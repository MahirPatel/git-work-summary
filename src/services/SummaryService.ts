import * as vscode from 'vscode';
import {
  SummarySettings,
  AuthorBulletGroup,
  AuthorWorkItemGroup,
  BulletCandidate,
  CategoryDetail,
  CategoryDetailFile,
  ChangeType,
  DateRange,
  FileAggregate,
  GitCommitInfo,
  GitFileChange,
  ScannedFile,
  SummaryPeriod,
  SummaryResult,
  WorkItem
} from '../models/types';
import { GitService } from './GitService';
import { WorkspaceScanner } from './WorkspaceScanner';
import { GroqService, computeTokenBudget, getMaxCommitsForTokenBudget } from './GroqService';
import { classifyFile, buildCategoryBulletText, detectLanguage, humanizeCommitMessage } from '../utils/fileClassifier';
import { rangeIncludesToday, resolveDateRangeInstants } from '../utils/dateRangeUtils';
import { Logger } from '../utils/logger';

/**
 * Orchestrates GitService + WorkspaceScanner and runs the deterministic
 * (non-AI) algorithm that turns raw signals into a ranked, deduplicated,
 * capped list of summary bullet points, for an arbitrary date range. See
 * README.md for a full write-up of the algorithm's rules. Optionally also
 * produces AI-generated `workItems` (via GroqService) when the caller
 * enables it and supplies an API key; this always degrades gracefully back
 * to the deterministic result on any failure.
 */
export class SummaryService {
  constructor(
    private readonly gitService: GitService,
    private readonly scanner: WorkspaceScanner,
    private readonly groqService: GroqService,
    private readonly logger: Logger
  ) {}

  async generate(
    folder: vscode.WorkspaceFolder,
    settings: SummarySettings,
    period: SummaryPeriod,
    dateRange: DateRange,
    teamWiseSummary: boolean,
    useAi: boolean,
    apiKey: string | undefined,
    token?: vscode.CancellationToken,
    progress?: vscode.Progress<{ message?: string }>
  ): Promise<SummaryResult> {
    const cwd = folder.uri.fsPath;
    const notices: string[] = [];
    const wantsGit = settings.includeGitCommits || settings.includeStagedChanges || settings.includeUnstagedChanges;
    const { since, until } = resolveDateRangeInstants(dateRange);
    // Staged/unstaged/untracked reflect the *current* working tree, which
    // only has meaning for a range that actually extends through today -
    // for a purely historical range (e.g. "Yesterday"), the working tree's
    // present state isn't part of that period.
    const includeCurrentState = rangeIncludesToday(dateRange);

    let commits: GitCommitInfo[] = [];
    let staged: GitFileChange[] = [];
    let unstaged: GitFileChange[] = [];
    let untracked: string[] = [];
    let trackedFiles: string[] = [];
    let scanned: ScannedFile[] = [];
    let gitAvailable = false;
    let isRepository = false;
    let selfAuthor: string | undefined;

    const gitTask = (async (): Promise<void> => {
      if (!wantsGit) {
        return;
      }
      progress?.report({ message: 'Checking Git availability…' });
      gitAvailable = await this.gitService.isGitAvailable();
      if (!gitAvailable) {
        notices.push('Git was not found on PATH — showing file-based detection only.');
        return;
      }

      isRepository = await this.gitService.isRepository(cwd);
      if (!isRepository) {
        notices.push('This folder is not a Git repository — showing file-based detection only.');
        return;
      }

      // Uncommitted work (staged/unstaged/untracked) is always the current
      // user's own working tree - Git has no visibility into a teammate's
      // uncommitted changes - so its bullets/work items are attributed to
      // this display name when grouping by author.
      if (teamWiseSummary) {
        selfAuthor = await this.gitService.getCurrentUserName(cwd);
      }

      const subtasks: Promise<void>[] = [];
      if (settings.includeGitCommits) {
        subtasks.push(
          (async (): Promise<void> => {
            progress?.report({ message: 'Reading commits…' });
            let identity: string | undefined;
            if (!teamWiseSummary) {
              identity = await this.gitService.getCurrentUserIdentity(cwd);
              if (!identity) {
                notices.push('Git user identity is not configured — showing commits from all authors.');
              }
            }
            commits = await this.gitService.getCommitsInRange(cwd, since, until, identity);
          })()
        );
      }
      if (settings.includeStagedChanges && includeCurrentState) {
        subtasks.push(
          (async (): Promise<void> => {
            progress?.report({ message: 'Reading staged changes…' });
            staged = await this.gitService.getStagedChanges(cwd);
          })()
        );
      }
      if (settings.includeUnstagedChanges && includeCurrentState) {
        subtasks.push(
          (async (): Promise<void> => {
            progress?.report({ message: 'Reading unstaged changes…' });
            unstaged = await this.gitService.getUnstagedChanges(cwd);
            untracked = await this.gitService.getUntrackedFiles(cwd);
          })()
        );
      }
      if (settings.includeModifiedFiles) {
        subtasks.push(
          (async (): Promise<void> => {
            progress?.report({ message: 'Checking tracked files…' });
            trackedFiles = await this.gitService.listTrackedFiles(cwd);
          })()
        );
      }
      await Promise.all(subtasks);
    })();

    const scanTask = (async (): Promise<void> => {
      if (!settings.includeModifiedFiles) {
        return;
      }
      progress?.report({ message: 'Scanning workspace for modified files…' });
      const scanResult = await this.scanner.findModifiedFilesInRange(cwd, settings, since, until, token, progress);
      scanned = scanResult.files;
      if (scanResult.truncated) {
        notices.push(
          'Workspace scan stopped early because this repository is very large; some modified files may be missing.'
        );
      }
    })();

    await Promise.all([gitTask, scanTask]);

    if (token?.isCancellationRequested) {
      return buildCancelledResult(folder, period, dateRange);
    }

    progress?.report({ message: 'Building summary…' });

    // WorkspaceScanner is a pure mtime walk with no Git awareness. Committing
    // a file doesn't reset its mtime, and neither does checkout/merge/pull
    // materializing a file on disk whose resulting content ends up
    // byte-identical to what Git already has - so the scanner can
    // re-discover files Git already accounts for two different ways: (a)
    // part of a commit this period, or currently staged/unstaged/untracked,
    // or (b) simply tracked and currently clean, but touched on disk by a
    // branch switch/merge/pull today. Both are excluded so the scanner only
    // ever contributes files Git genuinely has no visibility into at all
    // (Git-ignored files, or a non-Git workspace).
    const gitInvisibleScanned = excludeGitKnownFiles(scanned, commits, staged, unstaged, untracked, trackedFiles);

    // Files already represented by a commit bullet are excluded from
    // category grouping so the same work isn't summarized twice; they
    // still appear in `fullAggregates` for the details panel and stats.
    const uncommittedAggregates = aggregateFiles(staged, unstaged, untracked, gitInvisibleScanned);
    const fullAggregates = aggregateFiles(staged, unstaged, untracked, gitInvisibleScanned, commits);

    const commitBullets = buildCommitBullets(commits);
    const categoryBullets = buildCategoryBullets(uncommittedAggregates, selfAuthor);
    const finalizedBullets = finalizeBullets(commitBullets, categoryBullets, settings.maxBullets);
    const bullets = finalizedBullets.map((candidate) => candidate.text);
    const bulletGroups = teamWiseSummary ? toAuthorBulletGroups(finalizedBullets, selfAuthor) : undefined;
    const details = buildCategoryDetails(fullAggregates);

    if (bullets.length === 0) {
      this.logger.info(`No activity detected for ${period} in "${folder.name}".`);
    }

    let workItems: WorkItem[] = [];
    let aiSummaryUsed = false;
    if (useAi) {
      const ai = await this.buildAiWorkItems(cwd, commits, categoryBullets, settings, apiKey, teamWiseSummary);
      workItems = ai.workItems;
      aiSummaryUsed = ai.succeeded;
      notices.push(...ai.notices);
    }
    const workItemGroups =
      teamWiseSummary && aiSummaryUsed ? toAuthorWorkItemGroups(workItems, selfAuthor) : undefined;

    return {
      bullets,
      workItems,
      aiSummaryUsed,
      teamWiseSummaryUsed: teamWiseSummary,
      bulletGroups,
      workItemGroups,
      period,
      dateRange,
      generatedAt: new Date().toISOString(),
      workspaceFolderName: folder.name,
      workspaceFolderPath: cwd,
      stats: {
        commitCount: commits.length,
        filesChangedCount: fullAggregates.size,
        gitAvailable,
        isRepository
      },
      details,
      commits,
      notices
    };
  }

  /**
   * Builds AI-enhanced work items: one per commit (title + description from
   * Groq, based on the commit message and its diff) plus one per uncommitted
   * category, reusing the already-computed deterministic category bullets
   * (no commit message applies to those). Returns an empty, `succeeded:
   * false` result on any failure so the caller can fall back to `bullets`.
   */
  private async buildAiWorkItems(
    cwd: string,
    commits: GitCommitInfo[],
    categoryBullets: BulletCandidate[],
    settings: SummarySettings,
    apiKey: string | undefined,
    teamWiseSummary: boolean
  ): Promise<{ workItems: WorkItem[]; succeeded: boolean; notices: string[] }> {
    const notices: string[] = [];
    const uncommittedItems: WorkItem[] = categoryBullets.map((bullet) => ({
      title: bullet.text,
      description: `${bullet.weight} file(s) changed in this area, not yet committed.`,
      author: bullet.author
    }));

    if (!apiKey) {
      notices.push(
        'AI summary needs a Groq API key — run "Git Standup: Set Groq API Key". Showing the deterministic summary instead.'
      );
      return { workItems: [], succeeded: false, notices };
    }
    if (commits.length === 0) {
      // Nothing for the AI to explain; uncommitted work still has a bullet-style item.
      return { workItems: uncommittedItems, succeeded: uncommittedItems.length > 0, notices };
    }

    // `tokenBudgetCeiling` guarantees every included commit gets a
    // meaningful diff snippet while keeping the whole request safely under
    // Groq's 6,000 tokens/minute limit - it can be stricter than the
    // user-configured `aiMaxCommits`, since that setting has no awareness
    // of the account's actual rate limits. This matters more for weekly/
    // monthly ranges, which can easily have far more commits than a single day.
    const tokenBudgetCeiling = getMaxCommitsForTokenBudget();
    const commitsForAi = commits.slice(0, Math.min(settings.aiMaxCommits, tokenBudgetCeiling));
    if (commits.length > commitsForAi.length) {
      const limitedBy =
        settings.aiMaxCommits <= tokenBudgetCeiling ? '"aiMaxCommits" setting' : "Groq's per-minute token limit";
      notices.push(
        `AI summary covered the ${commitsForAi.length} most recent commit(s) of ${commits.length} in this period, limited by the ${limitedBy}.`
      );
    }

    const { perCommitDiffChars, maxCompletionTokens } = computeTokenBudget(commitsForAi.length);
    const diffs = await Promise.all(
      commitsForAi.map((commit) => this.gitService.getCommitDiff(cwd, commit.hash, perCommitDiffChars))
    );
    const aiResult = await this.groqService.generateWorkItems(
      apiKey,
      settings.aiModel,
      commitsForAi.map((commit, i) => ({ commitMessage: commit.message, diff: diffs[i] ?? '' })),
      maxCompletionTokens
    );

    if (!aiResult.items || aiResult.items.length !== commitsForAi.length) {
      const reason = aiResult.errorMessage ?? 'an unexpected response';
      notices.push(`AI summary request failed (${reason}) — showing the deterministic summary instead.`);
      return { workItems: [], succeeded: false, notices };
    }

    const aiItems = aiResult.items;
    const commitItems: WorkItem[] = commitsForAi.map((commit, i) => ({
      title: aiItems[i]?.title ?? humanizeCommitMessage(commit.message),
      commitMessage: commit.message,
      description: aiItems[i]?.description || humanizeCommitMessage(commit.message),
      author: teamWiseSummary ? commit.author : undefined
    }));

    return { workItems: [...commitItems, ...uncommittedItems], succeeded: true, notices };
  }
}

function buildCancelledResult(
  folder: vscode.WorkspaceFolder,
  period: SummaryPeriod,
  dateRange: DateRange
): SummaryResult {
  return {
    bullets: [],
    workItems: [],
    aiSummaryUsed: false,
    teamWiseSummaryUsed: false,
    period,
    dateRange,
    generatedAt: new Date().toISOString(),
    workspaceFolderName: folder.name,
    workspaceFolderPath: folder.uri.fsPath,
    stats: { commitCount: 0, filesChangedCount: 0, gitAvailable: false, isRepository: false },
    details: [],
    commits: [],
    notices: ['Summary generation was cancelled.']
  };
}

/** Merges every data source into one aggregate per unique file path. */
export function aggregateFiles(
  staged: GitFileChange[],
  unstaged: GitFileChange[],
  untracked: string[],
  scanned: ScannedFile[],
  commits: GitCommitInfo[] = []
): Map<string, FileAggregate> {
  const map = new Map<string, FileAggregate>();

  const ensure = (relativePath: string): FileAggregate => {
    let agg = map.get(relativePath);
    if (!agg) {
      agg = { relativePath, changeTypes: new Set<ChangeType>(), sources: new Set() };
      map.set(relativePath, agg);
    }
    return agg;
  };

  for (const change of staged) {
    const agg = ensure(change.relativePath);
    agg.changeTypes.add(change.changeType);
    agg.sources.add('staged');
  }
  for (const change of unstaged) {
    const agg = ensure(change.relativePath);
    agg.changeTypes.add(change.changeType);
    agg.sources.add('unstaged');
  }
  for (const relativePath of untracked) {
    const agg = ensure(relativePath);
    agg.changeTypes.add('created');
    agg.sources.add('untracked');
  }
  for (const commit of commits) {
    for (const relativePath of commit.files) {
      const agg = ensure(relativePath);
      agg.changeTypes.add('modified');
      agg.sources.add('commit');
    }
  }
  for (const file of scanned) {
    const agg = ensure(file.relativePath);
    if (agg.changeTypes.size === 0) {
      agg.changeTypes.add('modified');
    }
    agg.sources.add('workspace-scan');
    agg.mtimeMs = file.mtimeMs;
  }

  return map;
}

/**
 * Filters the workspace scanner's mtime-based results down to files Git has
 * no visibility into at all - i.e. not part of any commit in the period,
 * not currently staged/unstaged/untracked, and not tracked by Git at all.
 * Preserves the scanner's documented fallback role (Git-ignored files, or a
 * non-Git workspace) without re-surfacing files Git already accounts for by
 * any of these means.
 *
 * Two distinct root causes make this necessary, both because the scanner's
 * independent mtime walk has no Git awareness:
 *  1. Committing a file does not reset its on-disk mtime, so the scanner
 *     re-discovers files that were just committed.
 *  2. `git checkout`/`merge`/`pull` rewrite the on-disk content (and mtime)
 *     of every file that differs between source and destination tree, even
 *     when the resulting content ends up byte-identical to what Git already
 *     has recorded - so `git status` reports nothing changed, yet the
 *     scanner still sees a fresh mtime. A frequent-branch-switching workflow
 *     can make many long-untouched, tracked-and-clean files look like
 *     "today's work" this way, with no commit and no `git status` entry to
 *     catch it. `trackedFiles` (from `git ls-files`) is how case 2 is
 *     detected: any tracked path is Git-known and excluded here, regardless
 *     of whether Git currently reports it as changed.
 */
export function excludeGitKnownFiles(
  scanned: ScannedFile[],
  commits: GitCommitInfo[],
  staged: GitFileChange[],
  unstaged: GitFileChange[],
  untracked: string[],
  trackedFiles: string[] = []
): ScannedFile[] {
  const known = new Set<string>();
  for (const commit of commits) {
    for (const relativePath of commit.files) {
      known.add(relativePath);
    }
  }
  for (const change of staged) {
    known.add(change.relativePath);
  }
  for (const change of unstaged) {
    known.add(change.relativePath);
  }
  for (const relativePath of untracked) {
    known.add(relativePath);
  }
  for (const relativePath of trackedFiles) {
    known.add(relativePath);
  }
  if (known.size === 0) {
    return scanned;
  }
  return scanned.filter((file) => !known.has(file.relativePath));
}

interface CategoryGroup {
  changeTypes: Set<ChangeType>;
  count: number;
  fixedPhrase?: string;
}

/** Groups aggregated files by category and produces one ranked bullet candidate per group. */
export function buildCategoryBullets(aggregates: Map<string, FileAggregate>, selfAuthor?: string): BulletCandidate[] {
  const groups = new Map<string, CategoryGroup>();

  for (const agg of aggregates.values()) {
    const { category, fixedPhrase } = classifyFile(agg.relativePath);
    let group = groups.get(category);
    if (!group) {
      group = { changeTypes: new Set<ChangeType>(), count: 0, fixedPhrase };
      groups.set(category, group);
    }
    group.count++;
    for (const t of agg.changeTypes) {
      group.changeTypes.add(t);
    }
  }

  const candidates: BulletCandidate[] = [];
  for (const [category, group] of groups) {
    const text = buildCategoryBulletText(category, group.fixedPhrase, group.changeTypes, group.count);
    // Category bullets are always built from the current user's own
    // uncommitted (staged/unstaged/untracked) tree, so any known display
    // name is unambiguously this user's, not a teammate's.
    candidates.push({ text, source: 'category', weight: group.count, author: selfAuthor });
  }

  candidates.sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text));
  return candidates;
}

/** Converts commits into deduplicated, newest-first bullet candidates. */
export function buildCommitBullets(commits: GitCommitInfo[]): BulletCandidate[] {
  const sorted = [...commits].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const seen = new Set<string>();
  const candidates: BulletCandidate[] = [];

  for (const commit of sorted) {
    const text = humanizeCommitMessage(commit.message);
    const key = normalizeForDedupe(text);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    // Commit bullets outrank category bullets: they're the developer's own words.
    candidates.push({ text, source: 'commit', weight: 1000 + commit.files.length, author: commit.author });
  }
  return candidates;
}

/** Merges commit + category bullets, deduplicates near-identical text, and caps the result. */
export function finalizeBullets(
  commitBullets: BulletCandidate[],
  categoryBullets: BulletCandidate[],
  maxBullets: number
): BulletCandidate[] {
  const all = [...commitBullets, ...categoryBullets];
  const seen = new Set<string>();
  const deduped: BulletCandidate[] = [];

  for (const candidate of all) {
    const key = normalizeForDedupe(candidate.text);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped.slice(0, Math.max(0, maxBullets));
}

function normalizeForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const UNATTRIBUTED_AUTHOR_LABEL = 'Uncommitted Changes';

/**
 * Buckets items by `author` for Team Wise Summary, ordered with the
 * current user's bucket first (if present), then every other author
 * alphabetically. Items without a resolvable author (e.g. uncommitted work
 * when the current user's `user.name` isn't configured) fall into a shared
 * `UNATTRIBUTED_AUTHOR_LABEL` bucket rather than being dropped. Preserves
 * each item's relative order within its bucket.
 */
export function groupByAuthor<T extends { author?: string }>(
  items: T[],
  selfAuthor: string | undefined
): Array<{ author: string; items: T[] }> {
  const order: string[] = [];
  const buckets = new Map<string, T[]>();

  for (const item of items) {
    const key = item.author?.trim() || UNATTRIBUTED_AUTHOR_LABEL;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(item);
  }

  const self = selfAuthor?.trim();
  order.sort((a, b) => {
    if (self) {
      if (a === self && b !== self) {
        return -1;
      }
      if (b === self && a !== self) {
        return 1;
      }
    }
    return a.localeCompare(b);
  });

  return order.map((author) => ({ author, items: buckets.get(author)! }));
}

function toAuthorBulletGroups(candidates: BulletCandidate[], selfAuthor: string | undefined): AuthorBulletGroup[] {
  return groupByAuthor(candidates, selfAuthor).map((group) => ({
    author: group.author,
    bullets: group.items.map((c) => c.text)
  }));
}

function toAuthorWorkItemGroups(items: WorkItem[], selfAuthor: string | undefined): AuthorWorkItemGroup[] {
  return groupByAuthor(items, selfAuthor).map((group) => ({ author: group.author, items: group.items }));
}

/** Builds the category -> files breakdown shown in the details panel / tree view. */
export function buildCategoryDetails(aggregates: Map<string, FileAggregate>): CategoryDetail[] {
  const byCategory = new Map<string, CategoryDetailFile[]>();

  for (const agg of aggregates.values()) {
    const { category } = classifyFile(agg.relativePath);
    const file: CategoryDetailFile = {
      relativePath: agg.relativePath,
      language: detectLanguage(agg.relativePath),
      changeTypes: [...agg.changeTypes],
      sources: [...agg.sources]
    };
    const list = byCategory.get(category);
    if (list) {
      list.push(file);
    } else {
      byCategory.set(category, [file]);
    }
  }

  const details: CategoryDetail[] = [];
  for (const [category, files] of byCategory) {
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    details.push({ category, files });
  }
  details.sort((a, b) => b.files.length - a.files.length || a.category.localeCompare(b.category));
  return details;
}
