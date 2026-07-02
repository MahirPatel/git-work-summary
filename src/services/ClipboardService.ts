import * as vscode from 'vscode';
import { SummaryResult } from '../models/types';
import { formatDateRangeLabel, getPeriodWorkLabel } from '../utils/dateRangeUtils';

/** Copies the generated summary to the system clipboard as clean plain text. */
export class ClipboardService {
  async copySummary(result: SummaryResult): Promise<void> {
    await vscode.env.clipboard.writeText(buildPlainText(result));
  }
}

function buildPlainText(result: SummaryResult): string {
  const lines: string[] = [];
  lines.push(`${getPeriodWorkLabel(result.period)} — ${result.workspaceFolderName} (${formatDateRangeLabel(result.dateRange)})`);

  if (result.aiSummaryUsed && result.workItems.length > 0) {
    for (const item of result.workItems) {
      lines.push(`• ${item.title}`);
      if (item.commitMessage) {
        lines.push(`    • Commit Message : ${item.commitMessage}`);
      }
      lines.push(`    • Description: ${item.description}`);
    }
    return lines.join('\n');
  }

  lines.push('');
  if (result.bullets.length === 0) {
    lines.push('No development activity detected for this period.');
  } else {
    for (const bullet of result.bullets) {
      lines.push(`• ${bullet}`);
    }
  }

  return lines.join('\n');
}
