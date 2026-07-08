import * as assert from 'assert';
import { buildPlainText, buildPlainTextForResults } from '../../services/ClipboardService';
import { SummaryResult } from '../../models/types';

function makeResult(overrides: Partial<SummaryResult>): SummaryResult {
  return {
    bullets: ['Did a thing'],
    workItems: [],
    aiSummaryUsed: false,
    teamWiseSummaryUsed: false,
    period: 'today',
    dateRange: { startDate: '2026-07-08', endDate: '2026-07-08' },
    generatedAt: new Date().toISOString(),
    workspaceFolderName: 'repo',
    workspaceFolderPath: '/repos/repo',
    stats: { commitCount: 1, filesChangedCount: 1, gitAvailable: true, isRepository: true },
    details: [],
    commits: [],
    notices: [],
    ...overrides
  };
}

describe('ClipboardService.buildPlainTextForResults', () => {
  it('returns buildPlainText(results[0]) verbatim for a single result', () => {
    const result = makeResult({ workspaceFolderName: 'menu' });
    assert.strictEqual(buildPlainTextForResults([result]), buildPlainText(result));
  });

  it('joins multiple results, each under its own repo-name line, in order', () => {
    const menu = makeResult({ workspaceFolderName: 'menu', bullets: ['Fixed menu bug'] });
    const inventory = makeResult({ workspaceFolderName: 'inventory', bullets: ['Added inventory feature'] });

    const text = buildPlainTextForResults([menu, inventory]);

    const menuIndex = text.indexOf('menu');
    const inventoryIndex = text.indexOf('inventory');
    assert.ok(menuIndex !== -1, 'menu label missing');
    assert.ok(inventoryIndex !== -1, 'inventory label missing');
    assert.ok(menuIndex < inventoryIndex, 'repos out of order');
    assert.ok(text.includes('Fixed menu bug'));
    assert.ok(text.includes('Added inventory feature'));
  });
});
