import * as assert from 'assert';
import {
  aggregateFiles,
  buildCategoryBullets,
  buildCategoryDetails,
  buildCommitBullets,
  finalizeBullets
} from '../../services/SummaryService';
import { GitCommitInfo } from '../../models/types';

function makeCommit(overrides: Partial<GitCommitInfo>): GitCommitInfo {
  return {
    hash: 'abcdef1234567890',
    shortHash: 'abcdef1',
    author: 'Dev',
    date: new Date().toISOString(),
    message: 'did something',
    files: [],
    ...overrides
  };
}

describe('SummaryService.aggregateFiles', () => {
  it('merges the same file reported by multiple sources into one aggregate', () => {
    const aggregates = aggregateFiles(
      [{ relativePath: 'src/auth/Login.ts', changeType: 'modified' }],
      [],
      ['src/auth/Login.ts'],
      [{ relativePath: 'src/auth/Login.ts', mtimeMs: Date.now() }]
    );
    assert.strictEqual(aggregates.size, 1);
    const agg = aggregates.get('src/auth/Login.ts');
    assert.ok(agg);
    assert.ok(agg.sources.has('staged'));
    assert.ok(agg.sources.has('untracked'));
    assert.ok(agg.sources.has('workspace-scan'));
  });

  it('excludes commit-only files unless commits are explicitly passed in', () => {
    const commits = [makeCommit({ files: ['src/auth/Login.ts'] })];
    const withoutCommits = aggregateFiles([], [], [], []);
    assert.strictEqual(withoutCommits.size, 0);

    const withCommits = aggregateFiles([], [], [], [], commits);
    assert.strictEqual(withCommits.size, 1);
  });
});

describe('SummaryService.buildCategoryBullets', () => {
  it('produces one deduplicated bullet per category, ranked by file count', () => {
    const aggregates = aggregateFiles(
      [
        { relativePath: 'src/auth/Login.ts', changeType: 'modified' },
        { relativePath: 'src/auth/Session.ts', changeType: 'modified' },
        { relativePath: 'src/payment/Checkout.ts', changeType: 'created' }
      ],
      [],
      [],
      []
    );
    const bullets = buildCategoryBullets(aggregates);
    assert.strictEqual(bullets.length, 2);
    // Authentication has 2 files, Payment Processing has 1 - auth ranks first.
    assert.strictEqual(bullets[0]?.text, 'Improved authentication module');
    assert.strictEqual(bullets[1]?.text, 'Added new payment processing feature');
  });
});

describe('SummaryService.buildCommitBullets', () => {
  it('deduplicates commits whose humanized text is identical, keeping order stable', () => {
    const commits = [
      makeCommit({ message: 'fix invoice rounding', date: '2024-01-01T10:00:00.000Z' }),
      makeCommit({ message: 'Fixed invoice rounding', date: '2024-01-01T09:00:00.000Z' })
    ];
    const bullets = buildCommitBullets(commits);
    assert.strictEqual(bullets.length, 1);
  });

  it('orders commits newest first', () => {
    const commits = [
      makeCommit({ message: 'first thing', date: '2024-01-01T09:00:00.000Z' }),
      makeCommit({ message: 'second thing', date: '2024-01-01T11:00:00.000Z' })
    ];
    const bullets = buildCommitBullets(commits);
    assert.strictEqual(bullets[0]?.text, 'Second thing');
    assert.strictEqual(bullets[1]?.text, 'First thing');
  });
});

describe('SummaryService.finalizeBullets', () => {
  it('caps the combined bullet list at maxBullets, preferring commit bullets', () => {
    const commitBullets = [
      { text: 'Commit bullet 1', source: 'commit' as const, weight: 1001 },
      { text: 'Commit bullet 2', source: 'commit' as const, weight: 1000 }
    ];
    const categoryBullets = [
      { text: 'Category bullet 1', source: 'category' as const, weight: 3 },
      { text: 'Category bullet 2', source: 'category' as const, weight: 2 }
    ];
    const result = finalizeBullets(commitBullets, categoryBullets, 3);
    assert.deepStrictEqual(result, ['Commit bullet 1', 'Commit bullet 2', 'Category bullet 1']);
  });

  it('deduplicates near-identical text regardless of casing/punctuation', () => {
    const commitBullets = [{ text: 'Fixed invoice rounding.', source: 'commit' as const, weight: 1000 }];
    const categoryBullets = [{ text: 'fixed invoice rounding', source: 'category' as const, weight: 1 }];
    const result = finalizeBullets(commitBullets, categoryBullets, 10);
    assert.strictEqual(result.length, 1);
  });
});

describe('SummaryService.buildCategoryDetails', () => {
  it('groups files by category, sorted by file count descending', () => {
    const aggregates = aggregateFiles(
      [
        { relativePath: 'src/auth/Login.ts', changeType: 'modified' },
        { relativePath: 'src/auth/Session.ts', changeType: 'modified' },
        { relativePath: 'README.md', changeType: 'modified' }
      ],
      [],
      [],
      []
    );
    const details = buildCategoryDetails(aggregates);
    assert.strictEqual(details[0]?.category, 'Authentication');
    assert.strictEqual(details[0]?.files.length, 2);
    assert.strictEqual(details[1]?.category, 'Documentation');
  });
});
