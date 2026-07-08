import * as vscode from 'vscode';
import { SummaryResult } from '../models/types';
import { formatDateRangeLabel, getPeriodWorkLabel } from '../utils/dateRangeUtils';

/** Copies the generated summary to the system clipboard as clean plain text. */
export class ClipboardService {
  async copySummary(results: SummaryResult[]): Promise<void> {
    await vscode.env.clipboard.writeText(buildPlainTextForResults(results));
  }
}

/**
 * Multi-repo entry point: returns `buildPlainText(results[0])` verbatim
 * when there's exactly one result (byte-identical to the single-repo
 * output), otherwise joins each repo's own plain text under a repo-name
 * line, separated by a rule.
 */
export function buildPlainTextForResults(results: SummaryResult[]): string {
  if (results.length === 1) {
    return buildPlainText(results[0]!);
  }
  return results.map((result) => `${result.workspaceFolderName}\n${buildPlainText(result)}`).join('\n\n---\n\n');
}

export function buildPlainText(result: SummaryResult): string {
  const lines: string[] = [];
  lines.push(`${getPeriodWorkLabel(result.period)} — ${result.workspaceFolderName} (${formatDateRangeLabel(result.dateRange)})`);

  if (result.teamWiseSummaryUsed && result.aiSummaryUsed && result.workItemGroups?.length) {
    for (const group of result.workItemGroups) {
      lines.push('');
      lines.push(`Author: ${group.author}`);
      for (const item of group.items) {
        lines.push(`• ${item.title}`);
        if (item.commitMessage) {
          lines.push(`    • Commit Message : ${item.commitMessage}`);
        }
        lines.push(`    • Description: ${item.description}`);
      }
    }
    return lines.join('\n');
  }

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

  if (result.teamWiseSummaryUsed && result.bulletGroups?.length) {
    for (const group of result.bulletGroups) {
      lines.push('');
      lines.push(`Author: ${group.author}`);
      for (const bullet of group.bullets) {
        lines.push(`• ${bullet}`);
      }
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
