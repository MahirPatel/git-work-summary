import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../services/GitService';
import { GroqService } from '../services/GroqService';
import { SummaryService } from '../services/SummaryService';
import { MarkdownExporter } from '../services/MarkdownExporter';
import { ClipboardService } from '../services/ClipboardService';
import { SettingsManager } from '../services/SettingsManager';
import { SummaryStateStore } from '../services/SummaryStateStore';
import { AiUsageTracker } from '../services/AiUsageTracker';
import { DateRange, PanelStatus, SummaryPeriod, SummaryResult } from '../models/types';
import { SummaryWebviewProvider } from '../views/SummaryWebviewProvider';
import { Logger } from '../utils/logger';
import { pickWorkspaceFolder, resolveWorkspaceFolder } from '../utils/workspaceUtils';
import {
  getTodayRange,
  getYesterdayRange,
  getWeeklyRange,
  getMonthlyRange,
  validateCustomRange
} from '../utils/dateRangeUtils';

export interface CommandDependencies {
  gitService: GitService;
  groqService: GroqService;
  summaryService: SummaryService;
  markdownExporter: MarkdownExporter;
  clipboardService: ClipboardService;
  settingsManager: SettingsManager;
  stateStore: SummaryStateStore;
  aiUsageTracker: AiUsageTracker;
  webviewProvider: SummaryWebviewProvider;
  logger: Logger;
}

/** Secret-storage key for the Groq API key. Never written to settings.json or source. */
export const GROQ_API_KEY_SECRET = 'groqApiKey';

/** globalState key for the "Generate with AI" checkbox - a standing preference, not a per-click parameter. */
const AI_MODE_STORAGE_KEY = 'gitWorkSummary.aiModeEnabled';

/** globalState key for the "Team Wise Summary" checkbox - a standing preference, not a per-click parameter. */
const TEAM_WISE_STORAGE_KEY = 'gitWorkSummary.teamWiseSummaryEnabled';

/** A generous cap on how much diff text to even fetch from git; GroqService applies its own tighter token budget on top. */
const COMMIT_MESSAGE_GIT_FETCH_CHAR_CAP = 20000;
const MAX_UNTRACKED_FILES_LISTED = 20;

function hasContent(results: SummaryResult[] | undefined): results is SummaryResult[] {
  return !!results && results.some((r) => r.bullets.length > 0 || r.workItems.length > 0);
}

/**
 * Resolves which workspace folder(s) a Generate click should cover.
 * `folderPaths` comes from the webview's repo checkbox list (matched
 * against `folder.uri.toString()`); when absent/empty (Command Palette
 * invocation, or a single-folder workspace where the checkbox list is
 * never shown) falls back to the existing single-folder mechanism.
 */
function resolveSelectedFolders(
  folderPaths: string[] | undefined,
  rememberedFolder: vscode.WorkspaceFolder | undefined
): vscode.WorkspaceFolder[] {
  const all = vscode.workspace.workspaceFolders ?? [];
  if (folderPaths && folderPaths.length > 0) {
    const matched = all.filter((f) => folderPaths.includes(f.uri.toString()));
    if (matched.length > 0) {
      return matched;
    }
  }
  const fallback = resolveWorkspaceFolder(rememberedFolder);
  return fallback ? [fallback] : [];
}

/** Synthesized result for a folder whose `generate()` call threw unexpectedly, so one bad repo doesn't abort a multi-repo batch or vanish silently. */
function buildFolderErrorResult(
  folder: vscode.WorkspaceFolder,
  period: SummaryPeriod,
  dateRange: DateRange,
  err: unknown
): SummaryResult {
  const message = err instanceof Error ? err.message : String(err);
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
    notices: [`Failed to generate summary for "${folder.name}": ${message}`]
  };
}

interface GitExtensionRepository {
  rootUri: vscode.Uri;
  inputBox: { value: string };
}
interface GitExtensionApi {
  repositories: GitExtensionRepository[];
}
interface GitExtensionExports {
  getAPI(version: 1): GitExtensionApi;
}

/**
 * Writes a generated commit message directly into VS Code's built-in
 * Source Control input box, if the folder is recognized by the bundled
 * `vscode.git` extension. Returns false (caller should fall back to
 * clipboard) if that extension isn't available or the folder isn't found.
 */
async function insertIntoScmInputBox(folder: vscode.WorkspaceFolder, message: string): Promise<boolean> {
  try {
    const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!gitExtension) {
      return false;
    }
    const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    const api = exports.getAPI(1);
    const folderPath = folder.uri.fsPath;
    const repo = api.repositories.find(
      (r) => r.rootUri.fsPath === folderPath || folderPath.startsWith(r.rootUri.fsPath + path.sep)
    );
    if (!repo) {
      return false;
    }
    repo.inputBox.value = message;
    return true;
  } catch {
    return false;
  }
}

/** Registers every `gitWorkSummary.*` command and wires it into `context.subscriptions`. */
export function registerCommands(context: vscode.ExtensionContext, deps: CommandDependencies): void {
  // Remembers a folder explicitly picked via "Select Workspace Folder" for
  // the rest of the session, so later automatic runs don't re-prompt.
  let rememberedFolder: vscode.WorkspaceFolder | undefined;
  let isGenerating = false;
  let statusRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  const getAiModeEnabled = (): boolean => context.globalState.get<boolean>(AI_MODE_STORAGE_KEY, false);
  const getTeamWiseSummaryEnabled = (): boolean =>
    context.globalState.get<boolean>(TEAM_WISE_STORAGE_KEY, false);

  /** Recomputes and pushes the panel's standing status (AI mode, team-wise mode, API key, uncommitted changes, quota) to the webview. */
  const refreshStatus = async (): Promise<void> => {
    const folder = resolveWorkspaceFolder(rememberedFolder);
    const [hasApiKey, hasUncommittedChanges] = await Promise.all([
      context.secrets.get(GROQ_API_KEY_SECRET).then((v) => !!v),
      folder ? deps.gitService.hasUncommittedChanges(folder.uri.fsPath) : Promise.resolve(false)
    ]);
    const status: PanelStatus = {
      aiModeEnabled: getAiModeEnabled(),
      teamWiseSummaryEnabled: getTeamWiseSummaryEnabled(),
      hasApiKey,
      hasUncommittedChanges,
      aiUsageUsed: deps.aiUsageTracker.getUsedToday(),
      aiUsageLimit: deps.aiUsageTracker.dailyLimit,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => ({
        path: f.uri.toString(),
        name: f.name
      })),
      defaultFolderName: folder?.name
    };
    deps.webviewProvider.postStatus(status);
  };

  /** Shows the "paste your key" prompt and stores it in Secret Storage. Returns undefined if cancelled. */
  const promptAndStoreApiKey = async (): Promise<string | undefined> => {
    const value = await vscode.window.showInputBox({
      title: 'Set Groq API Key',
      prompt:
        'Paste your Groq API key. It is stored securely in VS Code Secret Storage, never in settings.json or source code.',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'gsk_...',
      validateInput: (value) => (value.trim().length === 0 ? 'API key cannot be empty.' : undefined)
    });
    if (value === undefined) {
      return undefined;
    }
    const trimmed = value.trim();
    await context.secrets.store(GROQ_API_KEY_SECRET, trimmed);
    return trimmed;
  };

  /** Shared by every period command - only the period/dateRange differ. Runs `generate()` once per selected folder, in one progress-tracked, cancellable batch. */
  const runGenerate = async (
    folders: vscode.WorkspaceFolder[],
    period: SummaryPeriod,
    dateRange: DateRange,
    teamWiseSummary: boolean,
    useAi: boolean,
    apiKey: string | undefined
  ): Promise<void> => {
    isGenerating = true;
    deps.webviewProvider.setLoading(true);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: useAi ? 'Git Standup: generating AI summary…' : 'Git Standup: generating summary…',
          cancellable: true
        },
        async (progress, token) => {
          const results: SummaryResult[] = [];
          let quotaWarned = false;

          for (let i = 0; i < folders.length; i++) {
            if (token.isCancellationRequested) {
              // All-or-nothing cancel, matching today's single-folder behavior:
              // discard everything gathered so far rather than committing a partial batch.
              return;
            }
            const folder = folders[i]!;
            if (folders.length > 1) {
              progress.report({ message: `Generating summary for "${folder.name}" (${i + 1} of ${folders.length})…` });
            }

            let folderUseAi = false;
            if (useAi) {
              if (deps.aiUsageTracker.hasRemaining()) {
                await deps.aiUsageTracker.recordUse();
                folderUseAi = true;
              } else if (!quotaWarned) {
                quotaWarned = true;
                vscode.window.showWarningMessage(
                  `Git Standup: you've used all ${deps.aiUsageTracker.dailyLimit} AI summaries for today. ${
                    folders.length > 1 ? 'Remaining repos will be generated without AI.' : 'Generating without AI instead.'
                  } The limit resets at midnight.`
                );
              }
            }

            try {
              const settings = deps.settingsManager.getSettings(folder.uri);
              const result = await deps.summaryService.generate(
                folder,
                settings,
                period,
                dateRange,
                teamWiseSummary,
                folderUseAi,
                apiKey,
                token,
                progress
              );
              results.push(result);
            } catch (err) {
              deps.logger.error(`Failed to generate summary for "${folder.name}"`, err);
              results.push(buildFolderErrorResult(folder, period, dateRange, err));
            }
          }

          if (!token.isCancellationRequested) {
            deps.stateStore.set(results);
          }
        }
      );
    } catch (err) {
      deps.logger.error('Failed to generate summary', err);
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Git Standup: failed to generate summary — ${message}`);
      deps.webviewProvider.showError(message);
    } finally {
      isGenerating = false;
      deps.webviewProvider.setLoading(false);
      await refreshStatus();
    }
  };

  /** Resolves which folder(s) and whether/how to use AI for this run based on the checked repos, "Generate with AI" checkbox, quota, and API key - then generates. */
  const runGenerateForPeriod = async (
    period: SummaryPeriod,
    dateRange: DateRange,
    folderPaths?: string[]
  ): Promise<void> => {
    if (isGenerating) {
      vscode.window.showInformationMessage('Git Standup: a summary is already being generated.');
      return;
    }
    const folders = resolveSelectedFolders(folderPaths, rememberedFolder);
    if (folders.length === 0) {
      vscode.window.showWarningMessage('Git Standup: open a folder or workspace first.');
      return;
    }

    const teamWiseSummary = getTeamWiseSummaryEnabled();
    let useAi = false;
    let apiKey: string | undefined;

    if (getAiModeEnabled()) {
      if (!deps.aiUsageTracker.hasRemaining()) {
        vscode.window.showWarningMessage(
          `Git Standup: you've used all ${deps.aiUsageTracker.dailyLimit} AI summaries for today. Generating without AI instead. The limit resets at midnight.`
        );
      } else {
        let key = await context.secrets.get(GROQ_API_KEY_SECRET);
        if (!key) {
          key = await promptAndStoreApiKey();
          if (key) {
            vscode.window.showInformationMessage('Git Standup: Groq API key saved securely.');
          } else {
            vscode.window.showInformationMessage('Git Standup: no API key entered — generating without AI.');
          }
        }
        if (key) {
          useAi = true;
          apiKey = key;
        }
      }
    }

    await runGenerate(folders, period, dateRange, teamWiseSummary, useAi, apiKey);
  };

  const generateToday = async (folderPaths?: string[]): Promise<void> =>
    runGenerateForPeriod('today', getTodayRange(), folderPaths);
  const generateYesterday = async (folderPaths?: string[]): Promise<void> =>
    runGenerateForPeriod('yesterday', getYesterdayRange(), folderPaths);
  const generateWeekly = async (folderPaths?: string[]): Promise<void> =>
    runGenerateForPeriod('weekly', getWeeklyRange(), folderPaths);
  const generateMonthly = async (folderPaths?: string[]): Promise<void> =>
    runGenerateForPeriod('monthly', getMonthlyRange(), folderPaths);

  /** `startDateArg`/`endDateArg` come from the webview's date pickers; omitted for Command Palette invocation, which prompts instead. */
  const generateCustom = async (startDateArg?: string, endDateArg?: string, folderPaths?: string[]): Promise<void> => {
    let startDate = startDateArg;
    let endDate = endDateArg;

    if (!startDate || !endDate) {
      const dateValidator = (value: string): string | undefined =>
        /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? undefined : 'Enter a date as YYYY-MM-DD.';
      const promptedStart = await vscode.window.showInputBox({
        title: "Generate Custom Summary — Start Date (1/2)",
        prompt: 'Start date (YYYY-MM-DD)',
        placeHolder: 'YYYY-MM-DD',
        ignoreFocusOut: true,
        validateInput: dateValidator
      });
      if (!promptedStart) {
        return;
      }
      const promptedEnd = await vscode.window.showInputBox({
        title: "Generate Custom Summary — End Date (2/2)",
        prompt: 'End date (YYYY-MM-DD)',
        placeHolder: 'YYYY-MM-DD',
        ignoreFocusOut: true,
        validateInput: dateValidator
      });
      if (!promptedEnd) {
        return;
      }
      startDate = promptedStart;
      endDate = promptedEnd;
    }

    const validation = validateCustomRange(startDate, endDate);
    if (!validation.valid || !validation.range) {
      vscode.window.showWarningMessage(`Git Standup: ${validation.error}`);
      return;
    }
    await runGenerateForPeriod('custom', validation.range, folderPaths);
  };

  const clearSummary = async (): Promise<void> => {
    deps.stateStore.set(undefined);
  };

  const copy = async (): Promise<void> => {
    const current = deps.stateStore.current;
    if (!hasContent(current)) {
      vscode.window.showWarningMessage('Git Standup: generate a summary first.');
      return;
    }
    await deps.clipboardService.copySummary(current);
    vscode.window.showInformationMessage('Git Standup: summary copied to clipboard.');
  };

  const exportMarkdown = async (): Promise<void> => {
    const current = deps.stateStore.current;
    if (!hasContent(current)) {
      vscode.window.showWarningMessage('Git Standup: generate a summary first.');
      return;
    }
    // Resolve the base folder from what was actually summarized, not an
    // independently-tracked "current folder" that may point elsewhere.
    const primaryUri = vscode.Uri.file(current[0]!.workspaceFolderPath);
    const folder = vscode.workspace.getWorkspaceFolder(primaryUri) ?? resolveWorkspaceFolder(rememberedFolder);
    if (!folder) {
      vscode.window.showWarningMessage('Git Standup: open a folder or workspace first.');
      return;
    }

    try {
      const settings = deps.settingsManager.getSettings(folder.uri);
      const uri = await deps.markdownExporter.export(current, folder, settings.defaultExportFolder);
      if (!uri) {
        return;
      }
      const openAction = 'Open File';
      const choice = await vscode.window.showInformationMessage(
        `Git Standup: exported to ${path.basename(uri.fsPath)}`,
        openAction
      );
      if (choice === openAction) {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
      }
    } catch (err) {
      deps.logger.error('Failed to export markdown', err);
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Git Standup: failed to export markdown — ${message}`);
    }
  };

  const selectWorkspaceFolder = async (): Promise<void> => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      vscode.window.showWarningMessage('Git Standup: open a folder or workspace first.');
      return;
    }
    const folder = await pickWorkspaceFolder();
    if (!folder) {
      return;
    }
    rememberedFolder = folder;
    if (folders.length > 1) {
      vscode.window.showInformationMessage(`Git Standup: now using workspace folder "${folder.name}".`);
    }
    await refreshStatus();
  };

  const openSettings = async (): Promise<void> => {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'gitWorkSummary');
  };

  const openFile = async (uri?: vscode.Uri): Promise<void> => {
    if (!uri) {
      return;
    }
    try {
      await vscode.commands.executeCommand('vscode.open', uri);
    } catch (err) {
      vscode.window.showErrorMessage(`Git Standup: could not open file — ${(err as Error).message}`);
    }
  };

  const setGroqApiKey = async (): Promise<void> => {
    const stored = await promptAndStoreApiKey();
    if (stored) {
      vscode.window.showInformationMessage('Git Standup: Groq API key saved securely.');
      await refreshStatus();
    }
  };

  const clearGroqApiKey = async (): Promise<void> => {
    await context.secrets.delete(GROQ_API_KEY_SECRET);
    vscode.window.showInformationMessage('Git Standup: Groq API key removed.');
    await refreshStatus();
  };

  /** Internal - driven by the webview checkbox, which always sends an explicit state. */
  const setAiMode = async (enabled?: boolean): Promise<void> => {
    await context.globalState.update(AI_MODE_STORAGE_KEY, !!enabled);
    await refreshStatus();
  };

  /** User-facing equivalent of the checkbox for Command Palette users. */
  const toggleAiMode = async (): Promise<void> => {
    const next = !getAiModeEnabled();
    await context.globalState.update(AI_MODE_STORAGE_KEY, next);
    await refreshStatus();
    vscode.window.showInformationMessage(`Git Standup: AI mode is now ${next ? 'ON' : 'OFF'}.`);
  };

  /** Internal - driven by the webview checkbox, which always sends an explicit state. */
  const setTeamWiseSummary = async (enabled?: boolean): Promise<void> => {
    await context.globalState.update(TEAM_WISE_STORAGE_KEY, !!enabled);
    await refreshStatus();
  };

  /** User-facing equivalent of the checkbox for Command Palette users. */
  const toggleTeamWiseSummary = async (): Promise<void> => {
    const next = !getTeamWiseSummaryEnabled();
    await context.globalState.update(TEAM_WISE_STORAGE_KEY, next);
    await refreshStatus();
    vscode.window.showInformationMessage(`Git Standup: Team Wise Summary is now ${next ? 'ON' : 'OFF'}.`);
  };

  const generateCommitMessage = async (): Promise<void> => {
    const folder = resolveWorkspaceFolder(rememberedFolder);
    if (!folder) {
      vscode.window.showWarningMessage('Git Standup: open a folder or workspace first.');
      return;
    }

    let apiKey = await context.secrets.get(GROQ_API_KEY_SECRET);
    if (!apiKey) {
      apiKey = await promptAndStoreApiKey();
      if (!apiKey) {
        return;
      }
      vscode.window.showInformationMessage('Git Standup: Groq API key saved securely.');
      await refreshStatus();
    }

    deps.webviewProvider.setCommitMessageLoading(true);
    try {
      const cwd = folder.uri.fsPath;
      const [staged, unstaged, untracked] = await Promise.all([
        deps.gitService.getStagedChanges(cwd),
        deps.gitService.getUnstagedChanges(cwd),
        deps.gitService.getUntrackedFiles(cwd)
      ]);

      let diff: string;
      let extraContext: string | undefined;
      if (staged.length > 0) {
        diff = await deps.gitService.getStagedDiff(cwd, COMMIT_MESSAGE_GIT_FETCH_CHAR_CAP);
      } else if (unstaged.length > 0 || untracked.length > 0) {
        diff = await deps.gitService.getUnstagedDiff(cwd, COMMIT_MESSAGE_GIT_FETCH_CHAR_CAP);
        extraContext = 'Note: these changes are not yet staged.';
      } else {
        vscode.window.showInformationMessage('Git Standup: no uncommitted changes found.');
        return;
      }

      if (untracked.length > 0) {
        const shown = untracked.slice(0, MAX_UNTRACKED_FILES_LISTED).join(', ');
        const suffix = untracked.length > MAX_UNTRACKED_FILES_LISTED ? ', …' : '';
        const note = `New (untracked) files: ${shown}${suffix}`;
        extraContext = extraContext ? `${extraContext}\n${note}` : note;
      }

      const settings = deps.settingsManager.getSettings(folder.uri);
      const result = await deps.groqService.generateCommitMessage(apiKey, settings.aiModel, diff, extraContext);
      if (!result.message) {
        vscode.window.showErrorMessage(
          `Git Standup: failed to generate commit message — ${result.errorMessage ?? 'unknown error'}`
        );
        return;
      }

      deps.webviewProvider.showCommitMessage(result.message);

      const inserted = await insertIntoScmInputBox(folder, result.message);
      if (inserted) {
        vscode.window.showInformationMessage('Git Standup: commit message generated and inserted into Source Control.');
      } else {
        await vscode.env.clipboard.writeText(result.message);
        vscode.window.showInformationMessage(
          'Git Standup: commit message copied to clipboard (Source Control input not found).'
        );
      }
    } catch (err) {
      deps.logger.error('Failed to generate commit message', err);
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Git Standup: failed to generate commit message — ${message}`);
    } finally {
      deps.webviewProvider.setCommitMessageLoading(false);
    }
  };

  const refreshStatusCommand = async (): Promise<void> => {
    await refreshStatus();
  };

  const MARKETPLACE_URL = 'https://marketplace.visualstudio.com/items?itemName=mahirpatel.git-standup';

  const shareExtension = async (): Promise<void> => {
    const copyLink = 'Copy Marketplace Link';
    const openPage = 'Open Marketplace Page';
    const choice = await vscode.window.showQuickPick([copyLink, openPage], {
      title: 'Share Git Standup – AI Work Summary',
      placeHolder: 'How would you like to share this extension?'
    });
    if (choice === copyLink) {
      await vscode.env.clipboard.writeText(MARKETPLACE_URL);
      vscode.window.showInformationMessage('Git Standup: marketplace link copied to clipboard.');
    } else if (choice === openPage) {
      await vscode.env.openExternal(vscode.Uri.parse(MARKETPLACE_URL));
    }
  };

  const copyCommitMessage = async (message?: string): Promise<void> => {
    if (!message) {
      return;
    }
    await vscode.env.clipboard.writeText(message);
    vscode.window.showInformationMessage('Git Standup: commit message copied to clipboard.');
  };

  /**
   * `refreshStatus` otherwise only runs at explicit action points (webview
   * load, after a generate click, after touching the API key/folder/AI
   * toggle) - none of which fire just because the user edited and saved a
   * file. Without this, "Generate Commit Message" can stay hidden after
   * saving new uncommitted changes until some unrelated action happens to
   * refresh it. Debounced so a multi-file "Save All" triggers one status
   * check instead of one per file.
   */
  const scheduleStatusRefresh = (): void => {
    if (statusRefreshTimer) {
      clearTimeout(statusRefreshTimer);
    }
    statusRefreshTimer = setTimeout(() => {
      statusRefreshTimer = undefined;
      void refreshStatus();
    }, 600);
  };

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => scheduleStatusRefresh()),
    { dispose: () => statusRefreshTimer && clearTimeout(statusRefreshTimer) },
    vscode.commands.registerCommand('gitWorkSummary.generateToday', generateToday),
    vscode.commands.registerCommand('gitWorkSummary.generateYesterday', generateYesterday),
    vscode.commands.registerCommand('gitWorkSummary.generateWeekly', generateWeekly),
    vscode.commands.registerCommand('gitWorkSummary.generateMonthly', generateMonthly),
    vscode.commands.registerCommand('gitWorkSummary.generateCustom', generateCustom),
    vscode.commands.registerCommand('gitWorkSummary.clearSummary', clearSummary),
    vscode.commands.registerCommand('gitWorkSummary.refresh', generateToday),
    vscode.commands.registerCommand('gitWorkSummary.copySummary', copy),
    vscode.commands.registerCommand('gitWorkSummary.exportMarkdown', exportMarkdown),
    vscode.commands.registerCommand('gitWorkSummary.selectWorkspaceFolder', selectWorkspaceFolder),
    vscode.commands.registerCommand('gitWorkSummary.openSettings', openSettings),
    vscode.commands.registerCommand('gitWorkSummary.openFile', openFile),
    vscode.commands.registerCommand('gitWorkSummary.setGroqApiKey', setGroqApiKey),
    vscode.commands.registerCommand('gitWorkSummary.clearGroqApiKey', clearGroqApiKey),
    vscode.commands.registerCommand('gitWorkSummary.toggleAiMode', toggleAiMode),
    vscode.commands.registerCommand('gitWorkSummary.setAiMode', setAiMode),
    vscode.commands.registerCommand('gitWorkSummary.toggleTeamWiseSummary', toggleTeamWiseSummary),
    vscode.commands.registerCommand('gitWorkSummary.setTeamWiseSummary', setTeamWiseSummary),
    vscode.commands.registerCommand('gitWorkSummary.generateCommitMessage', generateCommitMessage),
    vscode.commands.registerCommand('gitWorkSummary.copyCommitMessage', copyCommitMessage),
    vscode.commands.registerCommand('gitWorkSummary.shareExtension', shareExtension),
    vscode.commands.registerCommand('gitWorkSummary.refreshStatus', refreshStatusCommand)
  );
}
