import * as vscode from 'vscode';
import { Logger } from './utils/logger';
import { GitService } from './services/GitService';
import { WorkspaceScanner } from './services/WorkspaceScanner';
import { GroqService } from './services/GroqService';
import { SummaryService } from './services/SummaryService';
import { MarkdownExporter } from './services/MarkdownExporter';
import { ClipboardService } from './services/ClipboardService';
import { SettingsManager } from './services/SettingsManager';
import { SummaryStateStore } from './services/SummaryStateStore';
import { AiUsageTracker, DEFAULT_DAILY_AI_LIMIT } from './services/AiUsageTracker';
import { SummaryWebviewProvider } from './views/SummaryWebviewProvider';
import { DetectedChangesTreeProvider } from './views/DetectedChangesTreeProvider';
import { registerCommands } from './commands';

/**
 * Extension entry point. Composes services and views and registers
 * commands. Deliberately does no work at startup (no git/filesystem calls)
 * — everything runs lazily when the user clicks "Generate Summary" or
 * invokes a command, so activation stays instant.
 */
export function activate(context: vscode.ExtensionContext): void {
  const logger = new Logger();
  context.subscriptions.push(logger);
  logger.info('Extension activated.');

  const gitService = new GitService(logger);
  const scanner = new WorkspaceScanner(logger);
  const groqService = new GroqService(logger);
  const summaryService = new SummaryService(gitService, scanner, groqService, logger);
  const markdownExporter = new MarkdownExporter(logger);
  const clipboardService = new ClipboardService();
  const settingsManager = new SettingsManager();
  const stateStore = new SummaryStateStore();
  const aiUsageTracker = new AiUsageTracker(context.globalState, DEFAULT_DAILY_AI_LIMIT);
  context.subscriptions.push(settingsManager, stateStore);

  const webviewProvider = new SummaryWebviewProvider(context.extensionUri, stateStore, logger);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SummaryWebviewProvider.viewType, webviewProvider)
  );

  const treeProvider = new DetectedChangesTreeProvider(stateStore);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('gitWorkSummary.detailsView', treeProvider)
  );

  registerCommands(context, {
    gitService,
    groqService,
    summaryService,
    markdownExporter,
    clipboardService,
    settingsManager,
    stateStore,
    aiUsageTracker,
    webviewProvider,
    logger
  });
}

export function deactivate(): void {
  // No-op: everything is registered through `context.subscriptions`, which
  // VS Code disposes automatically when the extension is deactivated.
}
