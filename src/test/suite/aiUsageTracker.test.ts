import * as assert from 'assert';
import * as vscode from 'vscode';
import { AiUsageTracker, AI_USAGE_STORAGE_KEY } from '../../services/AiUsageTracker';

/** Minimal in-memory stand-in for `vscode.Memento`, since only get/update are used. */
class FakeMemento {
  private store = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.store.has(key) ? this.store.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

describe('AiUsageTracker', () => {
  it('starts at 0 used with no prior record', () => {
    const tracker = new AiUsageTracker(new FakeMemento() as unknown as vscode.Memento, 10);
    assert.strictEqual(tracker.getUsedToday(), 0);
    assert.strictEqual(tracker.hasRemaining(), true);
  });

  it('increments and persists usage within the same day', async () => {
    const memento = new FakeMemento();
    const tracker = new AiUsageTracker(memento as unknown as vscode.Memento, 3);
    assert.strictEqual(await tracker.recordUse(), 1);
    assert.strictEqual(await tracker.recordUse(), 2);
    assert.strictEqual(tracker.getUsedToday(), 2);
    assert.strictEqual(tracker.hasRemaining(), true);
  });

  it('reports no remaining once the daily limit is reached', async () => {
    const memento = new FakeMemento();
    const tracker = new AiUsageTracker(memento as unknown as vscode.Memento, 2);
    await tracker.recordUse();
    await tracker.recordUse();
    assert.strictEqual(tracker.getUsedToday(), 2);
    assert.strictEqual(tracker.hasRemaining(), false);
  });

  it('resets automatically when the stored record is from a different day', async () => {
    const memento = new FakeMemento();
    await memento.update(AI_USAGE_STORAGE_KEY, { date: '2000-01-01', count: 99 });
    const tracker = new AiUsageTracker(memento as unknown as vscode.Memento, 10);
    assert.strictEqual(tracker.getUsedToday(), 0);
    assert.strictEqual(tracker.hasRemaining(), true);
  });

  it('two independent trackers sharing the same memento see the same count', async () => {
    const memento = new FakeMemento();
    const trackerA = new AiUsageTracker(memento as unknown as vscode.Memento, 10);
    const trackerB = new AiUsageTracker(memento as unknown as vscode.Memento, 10);
    await trackerA.recordUse();
    assert.strictEqual(trackerB.getUsedToday(), 1);
  });
});
