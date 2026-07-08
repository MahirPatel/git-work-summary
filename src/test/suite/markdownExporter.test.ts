import * as assert from 'assert';
import { MarkdownExporter } from '../../services/MarkdownExporter';
import { SummaryResult } from '../../models/types';
import { Logger } from '../../utils/logger';

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

describe('MarkdownExporter.buildMarkdownForResults', () => {
  const exporter = new MarkdownExporter(new Logger('git-standup-test'));

  it('returns buildMarkdown(results[0]) verbatim for a single result', () => {
    const result = makeResult({ workspaceFolderName: 'menu' });
    assert.strictEqual(exporter.buildMarkdownForResults([result]), exporter.buildMarkdown(result));
  });

  it('joins multiple results, each under its own repo-name heading, in order', () => {
    const menu = makeResult({ workspaceFolderName: 'menu', bullets: ['Fixed menu bug'] });
    const inventory = makeResult({ workspaceFolderName: 'inventory', bullets: ['Added inventory feature'] });

    const markdown = exporter.buildMarkdownForResults([menu, inventory]);

    const menuHeadingIndex = markdown.indexOf('## menu');
    const inventoryHeadingIndex = markdown.indexOf('## inventory');
    assert.ok(menuHeadingIndex !== -1, 'menu heading missing');
    assert.ok(inventoryHeadingIndex !== -1, 'inventory heading missing');
    assert.ok(menuHeadingIndex < inventoryHeadingIndex, 'repos out of order');
    assert.ok(markdown.includes('Fixed menu bug'));
    assert.ok(markdown.includes('Added inventory feature'));
  });
});
