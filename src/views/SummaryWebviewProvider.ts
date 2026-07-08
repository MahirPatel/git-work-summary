import * as vscode from 'vscode';
import { getNonce } from '../utils/nonce';
import { SummaryStateStore } from '../services/SummaryStateStore';
import { HostToWebviewMessage, PanelStatus, WebviewToHostMessage } from '../models/types';
import { Logger } from '../utils/logger';

/**
 * Webview-based sidebar panel: "Today's Summary". Renders the AI-mode
 * checkbox, the five period-generation buttons, the custom date-range
 * picker, Clear/Copy/Export, the conditional "Generate Commit Message"
 * button, and the resulting bullet list. All actual work happens in the
 * registered commands — this provider only relays button clicks to
 * `vscode.commands.executeCommand` and pushes state back down, so the
 * webview UI and the Command Palette share one implementation.
 */
export class SummaryWebviewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'gitWorkSummary.summaryView';

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly stateStore: SummaryStateStore,
    private readonly logger: Logger
  ) {
    this.stateStore.onDidChange((result) => {
      this.postMessage(result ? { type: 'result', payload: result } : { type: 'clear' });
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media'),
        vscode.Uri.joinPath(this.extensionUri, 'dist')
      ]
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      this.handleMessage(message).catch((err) => {
        this.logger.error('Failed to handle webview message', err);
      });
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
  }

  setLoading(loading: boolean): void {
    this.postMessage({ type: 'loading', value: loading });
  }

  showError(message: string): void {
    this.postMessage({ type: 'error', message });
  }

  postStatus(status: PanelStatus): void {
    this.postMessage({ type: 'status', payload: status });
  }

  setCommitMessageLoading(loading: boolean): void {
    this.postMessage({ type: 'commitMessageLoading', value: loading });
  }

  showCommitMessage(message: string): void {
    this.postMessage({ type: 'commitMessageResult', message });
  }

  private async handleMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        if (this.stateStore.current) {
          this.postMessage({ type: 'result', payload: this.stateStore.current });
        }
        await vscode.commands.executeCommand('gitWorkSummary.refreshStatus');
        return;
      case 'generatePeriod':
        await vscode.commands.executeCommand(
          message.period === 'today'
            ? 'gitWorkSummary.generateToday'
            : message.period === 'yesterday'
              ? 'gitWorkSummary.generateYesterday'
              : message.period === 'weekly'
                ? 'gitWorkSummary.generateWeekly'
                : 'gitWorkSummary.generateMonthly',
          message.folderPaths
        );
        return;
      case 'generateCustom':
        await vscode.commands.executeCommand(
          'gitWorkSummary.generateCustom',
          message.startDate,
          message.endDate,
          message.folderPaths
        );
        return;
      case 'clearSummary':
        await vscode.commands.executeCommand('gitWorkSummary.clearSummary');
        return;
      case 'setAiMode':
        await vscode.commands.executeCommand('gitWorkSummary.setAiMode', message.enabled);
        return;
      case 'setTeamWiseSummary':
        await vscode.commands.executeCommand('gitWorkSummary.setTeamWiseSummary', message.enabled);
        return;
      case 'copy':
        await vscode.commands.executeCommand('gitWorkSummary.copySummary');
        return;
      case 'export':
        await vscode.commands.executeCommand('gitWorkSummary.exportMarkdown');
        return;
      case 'selectFolder':
        await vscode.commands.executeCommand('gitWorkSummary.selectWorkspaceFolder');
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('gitWorkSummary.openSettings');
        return;
      case 'setApiKey':
        await vscode.commands.executeCommand('gitWorkSummary.setGroqApiKey');
        return;
      case 'generateCommitMessage':
        await vscode.commands.executeCommand('gitWorkSummary.generateCommitMessage');
        return;
      case 'copyCommitMessage':
        await vscode.commands.executeCommand('gitWorkSummary.copyCommitMessage', message.message);
        return;
      case 'shareExtension':
        await vscode.commands.executeCommand('gitWorkSummary.shareExtension');
        return;
    }
  }

  private postMessage(message: HostToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'reset.css'));
    const styleVscodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'vscode.css'));
    const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'codicons', 'codicon.css')
    );

    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleResetUri}" rel="stylesheet" />
  <link href="${styleVscodeUri}" rel="stylesheet" />
  <link href="${codiconsUri}" rel="stylesheet" />
  <link href="${styleMainUri}" rel="stylesheet" />
  <title>Git Standup</title>
</head>
<body>
  <div id="app">
    <header class="header">
      <div class="header-row">
        <h2 class="title"><span class="codicon codicon-checklist"></span> Today's Summary</h2>
        <button id="btn-share" class="btn-link" type="button" title="Share this extension with your team">
          <span class="codicon codicon-share"></span> Share
        </button>
      </div>
      <p class="subtitle" id="subtitle">Generate a summary to see today's work.</p>
      <p class="ai-status hidden" id="ai-status"></p>
    </header>

    <div class="repo-select hidden" id="repo-select">
      <p class="section-title">Repositories</p>
      <div id="repo-select-list" class="repo-select-list"></div>
    </div>

    <label class="ai-mode-row" for="chk-ai-mode">
      <input type="checkbox" id="chk-ai-mode" />
      <span>Generate with AI</span>
    </label>
    <p class="ai-usage-line" id="ai-usage-line"></p>

    <label class="ai-mode-row" for="chk-team-wise" title="Include commits from every author, grouped by author">
      <input type="checkbox" id="chk-team-wise" />
      <span>Team Wise Summary</span>
    </label>

    <div class="toolbar">
      <button id="btn-today" class="btn btn-primary" type="button" title="Summarize today">
        <span class="codicon codicon-calendar"></span> Generate Today's Summary
      </button>
      <button id="btn-yesterday" class="btn" type="button" title="Summarize yesterday">
        <span class="codicon codicon-history"></span> Generate Yesterday's Summary
      </button>
      <button id="btn-weekly" class="btn" type="button" title="Summarize the last 7 days">
        <span class="codicon codicon-calendar"></span> Generate Weekly Summary
      </button>
      <button id="btn-monthly" class="btn" type="button" title="Summarize the last 30 days">
        <span class="codicon codicon-calendar"></span> Generate Monthly Summary
      </button>
    </div>

    <button id="btn-toggle-custom-range" class="btn-link" type="button" aria-expanded="false" aria-controls="custom-range">
      <span class="codicon codicon-chevron-right"></span> Custom Range…
    </button>

    <div class="custom-range hidden" id="custom-range">
      <div class="custom-range-inputs">
        <input type="date" id="custom-start" aria-label="Custom range start date" />
        <span class="custom-range-sep">to</span>
        <input type="date" id="custom-end" aria-label="Custom range end date" />
      </div>
      <button id="btn-custom" class="btn" type="button" title="Summarize a custom date range (max 31 days)">
        <span class="codicon codicon-calendar"></span> Generate Custom Summary
      </button>
      <p class="hint error-hint hidden" id="custom-range-error"></p>
    </div>

    <div class="toolbar">
      <button id="btn-clear" class="btn" type="button" title="Clear the current summary">
        <span class="codicon codicon-clear-all"></span> Clear
      </button>
      <button id="btn-copy" class="btn" type="button" disabled>
        <span class="codicon codicon-copy"></span> Copy
      </button>
      <button id="btn-export" class="btn" type="button" disabled>
        <span class="codicon codicon-markdown"></span> Export Markdown
      </button>
    </div>

    <div id="commit-message-section" class="hidden">
      <button id="btn-commit-message" class="btn btn-primary" type="button" title="Generate a commit message for your uncommitted changes">
        <span class="codicon codicon-git-commit"></span> <span id="commit-message-btn-label">Generate Commit Message</span>
      </button>
    </div>

    <div id="commit-message-result" class="hidden">
      <div class="commit-message-result-header">
        <span class="section-title">Generated Commit Message</span>
        <button id="btn-copy-commit-message" class="btn-link" type="button" title="Copy commit message">
          <span class="codicon codicon-copy"></span> Copy
        </button>
      </div>
      <pre id="commit-message-text"></pre>
    </div>

    <div id="loading" class="state hidden">
      <span class="codicon codicon-loading codicon-modifier-spin"></span>
      <p id="loading-message">Generating your summary…</p>
    </div>

    <div id="empty" class="state hidden">
      <span class="codicon codicon-inbox"></span>
      <p>No development activity detected yet.</p>
      <p class="hint">Pick a range above and click Generate.</p>
    </div>

    <div id="error" class="state hidden">
      <span class="codicon codicon-warning"></span>
      <p id="error-message"></p>
    </div>

    <div id="content" class="hidden">
      <div id="results-container"></div>

      <footer class="footer">
        <button id="btn-select-folder" class="btn-link" type="button" title="Select workspace folder">
          <span class="codicon codicon-folder-opened"></span> <span id="folder-name"></span>
        </button>
      </footer>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
