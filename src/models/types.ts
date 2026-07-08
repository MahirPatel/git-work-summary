/**
 * Shared type definitions for the Git Standup extension.
 * Kept dependency-free (no `vscode` import) so they can be reused from
 * services, views, and unit tests without pulling in the extension host API.
 */

/** How a file's content changed relative to the Git index/HEAD. */
export type ChangeType = 'created' | 'modified' | 'deleted' | 'renamed';

/** Which data source contributed a given file to the aggregate. */
export type ChangeSource = 'commit' | 'staged' | 'unstaged' | 'untracked' | 'workspace-scan';

/** Which built-in (or custom) time window a summary was generated for. */
export type SummaryPeriod = 'today' | 'yesterday' | 'weekly' | 'monthly' | 'custom';

/** An inclusive local-date range, e.g. `{ startDate: '2026-06-25', endDate: '2026-07-01' }`. */
export interface DateRange {
  startDate: string;
  endDate: string;
}

/** A single commit within the summarized period, as parsed from `git log`. */
export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  /** ISO-8601 commit date. */
  date: string;
  /** Commit subject line (first line of the message) only. */
  message: string;
  /** Repo-relative paths touched by this commit. */
  files: string[];
}

/** A file-level change reported by `git diff` / `git status`. */
export interface GitFileChange {
  relativePath: string;
  changeType: ChangeType;
}

/** A file discovered by the workspace scanner because its mtime falls within the summarized period. */
export interface ScannedFile {
  relativePath: string;
  mtimeMs: number;
}

/** One row rendered in the "Detected Changes" tree / webview details panel. */
export interface CategoryDetailFile {
  relativePath: string;
  language: string;
  changeTypes: ChangeType[];
  sources: ChangeSource[];
}

export interface CategoryDetail {
  category: string;
  files: CategoryDetailFile[];
}

export interface SummaryStats {
  commitCount: number;
  filesChangedCount: number;
  gitAvailable: boolean;
  isRepository: boolean;
}

/**
 * One work item in the AI-generated summary template:
 *   • {title}
 *       • Commit Message : {commitMessage}
 *       • Description: {description}
 * `commitMessage` is omitted for items derived from uncommitted work.
 */
export interface WorkItem {
  title: string;
  commitMessage?: string;
  description: string;
  /** Commit author (or the current user, for uncommitted work) - only set when Team Wise Summary is enabled. */
  author?: string;
}

/** One author's work items, in Team Wise Summary order (current user first, then alphabetical). */
export interface AuthorWorkItemGroup {
  author: string;
  items: WorkItem[];
}

/** One author's bullets, in Team Wise Summary order (current user first, then alphabetical). */
export interface AuthorBulletGroup {
  author: string;
  bullets: string[];
}

/** Full result of running the summary pipeline once, for a given period. */
export interface SummaryResult {
  bullets: string[];
  /**
   * Present only when AI summary generation was enabled and succeeded this
   * run. When empty, renderers fall back to the deterministic `bullets`.
   */
  workItems: WorkItem[];
  /** True if `workItems` came from Groq rather than the deterministic fallback. */
  aiSummaryUsed: boolean;
  /** True if Team Wise Summary was enabled for this run (commits from every author, not just the current user). */
  teamWiseSummaryUsed: boolean;
  /** Present only when `teamWiseSummaryUsed` is true - `bullets` grouped by author, for the deterministic (non-AI) list. */
  bulletGroups?: AuthorBulletGroup[];
  /** Present only when `teamWiseSummaryUsed` is true - `workItems` grouped by author, for the AI summary. */
  workItemGroups?: AuthorWorkItemGroup[];
  period: SummaryPeriod;
  dateRange: DateRange;
  /** ISO-8601 timestamp of when this summary was generated. */
  generatedAt: string;
  workspaceFolderName: string;
  workspaceFolderPath: string;
  stats: SummaryStats;
  details: CategoryDetail[];
  commits: GitCommitInfo[];
  /** Human-readable notices about degraded/skipped data sources (e.g. "Git not found"). */
  notices: string[];
}

/** User-configurable settings, mirroring the `gitWorkSummary.*` configuration section. */
export interface SummarySettings {
  includeGitCommits: boolean;
  includeStagedChanges: boolean;
  includeUnstagedChanges: boolean;
  includeModifiedFiles: boolean;
  maxBullets: number;
  ignoredFolders: string[];
  ignoredExtensions: string[];
  defaultExportFolder: string;
  aiModel: string;
  aiMaxCommits: number;
}

/** An in-flight bullet before final ranking/deduplication/truncation. */
export interface BulletCandidate {
  text: string;
  source: 'commit' | 'category';
  /** Higher sorts earlier. Commit bullets are weighted above category bullets. */
  weight: number;
  /** Commit author (or the current user, for category/uncommitted bullets) - only set when Team Wise Summary is enabled. */
  author?: string;
}

/** Aggregated view of a single file across every data source that reported it. */
export interface FileAggregate {
  relativePath: string;
  changeTypes: Set<ChangeType>;
  sources: Set<ChangeSource>;
  mtimeMs?: number;
}

/** Panel-wide toggle/quota/availability state, independent of any single generated result. */
export interface PanelStatus {
  aiModeEnabled: boolean;
  teamWiseSummaryEnabled: boolean;
  hasApiKey: boolean;
  hasUncommittedChanges: boolean;
  aiUsageUsed: number;
  aiUsageLimit: number;
  /** Every workspace folder currently open, for the multi-repo checkbox list. `path` is `folder.uri.toString()`. */
  workspaceFolders: { path: string; name: string }[];
  /** Name of the folder "Select Workspace Folder" / "Generate Commit Message" currently target (independent of the checkbox selection above). */
  defaultFolderName: string | undefined;
}

/** Messages sent from the extension host to the webview UI. */
export type HostToWebviewMessage =
  | { type: 'loading'; value: boolean }
  | { type: 'result'; payload: SummaryResult[] }
  | { type: 'error'; message: string }
  | { type: 'clear' }
  | { type: 'status'; payload: PanelStatus }
  | { type: 'commitMessageLoading'; value: boolean }
  | { type: 'commitMessageResult'; message: string };

/** Messages sent from the webview UI to the extension host. */
export type WebviewToHostMessage =
  | { type: 'generatePeriod'; period: 'today' | 'yesterday' | 'weekly' | 'monthly'; folderPaths?: string[] }
  | { type: 'generateCustom'; startDate: string; endDate: string; folderPaths?: string[] }
  | { type: 'clearSummary' }
  | { type: 'setAiMode'; enabled: boolean }
  | { type: 'setTeamWiseSummary'; enabled: boolean }
  | { type: 'copy' }
  | { type: 'export' }
  | { type: 'selectFolder' }
  | { type: 'openSettings' }
  | { type: 'setApiKey' }
  | { type: 'generateCommitMessage' }
  | { type: 'copyCommitMessage'; message: string }
  | { type: 'shareExtension' }
  | { type: 'ready' };
