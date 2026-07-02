import * as vscode from 'vscode';

export const AI_USAGE_STORAGE_KEY = 'gitWorkSummary.aiUsage';

/** Self-imposed daily cap on "Generate AI Summary" runs, independent of Groq's own account-level rate limits. */
export const DEFAULT_DAILY_AI_LIMIT = 10;

interface AiUsageRecord {
  date: string;
  count: number;
}

/**
 * Tracks how many AI summaries have been generated today, backed by
 * `globalState` so the count survives reloads/restarts. Resets
 * automatically at local midnight via a lazy date comparison - no timer or
 * scheduled reset needed.
 */
export class AiUsageTracker {
  constructor(
    private readonly globalState: vscode.Memento,
    readonly dailyLimit: number
  ) {}

  getUsedToday(): number {
    const record = this.globalState.get<AiUsageRecord>(AI_USAGE_STORAGE_KEY);
    return record && record.date === todayIso() ? record.count : 0;
  }

  hasRemaining(): boolean {
    return this.getUsedToday() < this.dailyLimit;
  }

  async recordUse(): Promise<number> {
    const next = this.getUsedToday() + 1;
    await this.globalState.update(AI_USAGE_STORAGE_KEY, { date: todayIso(), count: next });
    return next;
  }
}

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
