import * as vscode from 'vscode';
import { SummaryResult } from '../models/types';
import { Logger } from '../utils/logger';
import { formatDateRangeLabel, getPeriodWorkLabel } from '../utils/dateRangeUtils';

/** Builds the exported Markdown document and writes it to disk via a Save dialog. */
export class MarkdownExporter {
  constructor(private readonly logger: Logger) {}

  buildMarkdown(result: SummaryResult): string {
    const generatedAt = new Date(result.generatedAt);
    const lines: string[] = [];

    lines.push(`# ${getPeriodWorkLabel(result.period)} — ${formatDateRangeLabel(result.dateRange)}`);
    lines.push('');
    lines.push(`_Workspace: **${result.workspaceFolderName}**_`);
    lines.push('');
    lines.push('## Summary');
    lines.push('');

    if (result.aiSummaryUsed && result.workItems.length > 0) {
      for (const item of result.workItems) {
        lines.push(`- **${item.title}**`);
        if (item.commitMessage) {
          lines.push(`  - Commit Message: ${item.commitMessage}`);
        }
        lines.push(`  - Description: ${item.description}`);
      }
    } else if (result.bullets.length === 0) {
      lines.push('_No development activity detected for this period._');
    } else {
      for (const bullet of result.bullets) {
        lines.push(`- ${bullet}`);
      }
    }
    lines.push('');

    if (result.notices.length > 0) {
      lines.push('## Notices');
      lines.push('');
      for (const notice of result.notices) {
        lines.push(`- ${notice}`);
      }
      lines.push('');
    }

    if (result.commits.length > 0) {
      lines.push('<details>');
      lines.push(`<summary>Commits (${result.commits.length})</summary>`);
      lines.push('');
      for (const commit of result.commits) {
        lines.push(`- \`${commit.shortHash}\` ${commit.message} _(${commit.author})_`);
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    if (result.details.length > 0) {
      lines.push('<details>');
      lines.push(`<summary>Files touched (${result.stats.filesChangedCount})</summary>`);
      lines.push('');
      for (const detail of result.details) {
        lines.push(`**${detail.category}**`);
        lines.push('');
        for (const file of detail.files) {
          lines.push(`- \`${file.relativePath}\` — ${file.language}`);
        }
        lines.push('');
      }
      lines.push('</details>');
      lines.push('');
    }

    lines.push('---');
    lines.push(
      `_Generated locally by the Git Standup extension at ${generatedAt.toLocaleTimeString()}. No AI, no cloud services involved unless AI mode was used._`
    );
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Shows a Save dialog defaulting to a period-appropriate filename (e.g.
   * `daily-summary-2026-07-02.md`, `weekly-summary-2026-06-26_to_2026-07-02.md`)
   * in the workspace root (or the configured default export folder), then
   * writes the file. Returns the written Uri, or undefined if cancelled.
   */
  async export(
    result: SummaryResult,
    workspaceFolder: vscode.WorkspaceFolder,
    defaultExportFolder: string
  ): Promise<vscode.Uri | undefined> {
    const filename = buildFilename(result);
    const baseDir = defaultExportFolder
      ? vscode.Uri.joinPath(workspaceFolder.uri, defaultExportFolder)
      : workspaceFolder.uri;
    const defaultUri = vscode.Uri.joinPath(baseDir, filename);

    const targetUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { Markdown: ['md'] },
      saveLabel: 'Export Summary'
    });
    if (!targetUri) {
      return undefined;
    }

    const markdown = this.buildMarkdown(result);
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(markdown, 'utf8'));
    this.logger.info(`Exported markdown to ${targetUri.fsPath}`);
    return targetUri;
  }
}

function buildFilename(result: SummaryResult): string {
  const { period, dateRange } = result;
  if (period === 'today' || period === 'yesterday') {
    return `daily-summary-${dateRange.startDate}.md`;
  }
  const prefix = period === 'weekly' ? 'weekly-summary' : period === 'monthly' ? 'monthly-summary' : 'custom-summary';
  return `${prefix}-${dateRange.startDate}_to_${dateRange.endDate}.md`;
}
