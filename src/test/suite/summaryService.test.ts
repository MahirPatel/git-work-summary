import * as assert from 'assert';
import {
  aggregateFiles,
  buildCategoryBullets,
  buildCategoryDetails,
  buildCommitBullets,
  excludeGitKnownFiles,
  finalizeBullets,
  groupByAuthor
} from '../../services/SummaryService';
import { GitCommitInfo } from '../../models/types';

function makeCommit(overrides: Partial<GitCommitInfo>): GitCommitInfo {
  return {
    hash: 'abcdef1234567890',
    shortHash: 'abcdef1',
    author: 'Dev',
    authorEmail: 'dev@example.com',
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

  it('leaves author unset when no selfAuthor is given', () => {
    const aggregates = aggregateFiles([{ relativePath: 'README.md', changeType: 'modified' }], [], [], []);
    const bullets = buildCategoryBullets(aggregates);
    assert.strictEqual(bullets[0]?.author, undefined);
  });

  it('attributes every category bullet to selfAuthor when provided (uncommitted work is always the current user\'s)', () => {
    const aggregates = aggregateFiles([{ relativePath: 'README.md', changeType: 'modified' }], [], [], []);
    const bullets = buildCategoryBullets(aggregates, 'Mahir Patel');
    assert.strictEqual(bullets[0]?.author, 'Mahir Patel');
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

  it('attaches each commit\'s author to its bullet candidate', () => {
    const commits = [makeCommit({ message: 'do a thing', author: 'Nishit Dangi' })];
    const bullets = buildCommitBullets(commits);
    assert.strictEqual(bullets[0]?.author, 'Nishit Dangi');
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
    assert.deepStrictEqual(
      result.map((c) => c.text),
      ['Commit bullet 1', 'Commit bullet 2', 'Category bullet 1']
    );
  });

  it('deduplicates near-identical text regardless of casing/punctuation', () => {
    const commitBullets = [{ text: 'Fixed invoice rounding.', source: 'commit' as const, weight: 1000 }];
    const categoryBullets = [{ text: 'fixed invoice rounding', source: 'category' as const, weight: 1 }];
    const result = finalizeBullets(commitBullets, categoryBullets, 10);
    assert.strictEqual(result.length, 1);
  });

  it('preserves author on the finalized candidates', () => {
    const commitBullets = [{ text: 'Commit bullet 1', source: 'commit' as const, weight: 1000, author: 'Mahir Patel' }];
    const categoryBullets: never[] = [];
    const result = finalizeBullets(commitBullets, categoryBullets, 10);
    assert.strictEqual(result[0]?.author, 'Mahir Patel');
  });
});

describe('SummaryService.groupByAuthor', () => {
  it('orders the current user\'s bucket first, then remaining authors alphabetically', () => {
    const items = [
      { author: 'Nishit Dangi' },
      { author: 'Amit Shah' },
      { author: 'Mahir Patel' }
    ];
    const groups = groupByAuthor(items, 'Mahir Patel');
    assert.deepStrictEqual(
      groups.map((g) => g.author),
      ['Mahir Patel', 'Amit Shah', 'Nishit Dangi']
    );
  });

  it('sorts alphabetically with no self bucket preference when selfAuthor is undefined', () => {
    const items = [{ author: 'Nishit Dangi' }, { author: 'Amit Shah' }];
    const groups = groupByAuthor(items, undefined);
    assert.deepStrictEqual(
      groups.map((g) => g.author),
      ['Amit Shah', 'Nishit Dangi']
    );
  });

  it('buckets items with no author under a shared fallback label instead of dropping them', () => {
    const items = [{ author: undefined }, { author: 'Mahir Patel' }];
    const groups = groupByAuthor(items, 'Mahir Patel');
    assert.strictEqual(groups.length, 2);
    assert.ok(groups.some((g) => g.author === 'Uncommitted Changes'));
  });

  it('preserves relative order of items within each bucket', () => {
    const items = [
      { author: 'Mahir Patel', text: 'first' },
      { author: 'Mahir Patel', text: 'second' }
    ];
    const groups = groupByAuthor(items, 'Mahir Patel');
    assert.deepStrictEqual(
      groups[0]?.items.map((i) => i.text),
      ['first', 'second']
    );
  });
});

describe('SummaryService.excludeGitKnownFiles', () => {
  it('regression: scanner re-discovering a just-committed file (same mtime) is dropped entirely', () => {
    const commit = makeCommit({
      message: 'Changes related to dynamic logo',
      files: [
        'elements/logo.php',
        'webroot/js/logo.js',
        'config/app.php',
        'controllers/HomeController.php',
        'items/item.php'
      ]
    });
    const commits = [commit];
    const scanned = commit.files.map((relativePath) => ({ relativePath, mtimeMs: Date.now() }));

    const gitInvisibleScanned = excludeGitKnownFiles(scanned, commits, [], [], []);
    assert.deepStrictEqual(gitInvisibleScanned, []);

    const uncommittedAggregates = aggregateFiles([], [], [], gitInvisibleScanned);
    const categoryBullets = buildCategoryBullets(uncommittedAggregates);
    const commitBullets = buildCommitBullets(commits);
    const bullets = finalizeBullets(commitBullets, categoryBullets, 10);

    assert.strictEqual(categoryBullets.length, 0, 'already-committed files must not also produce category bullets');
    assert.strictEqual(
      bullets.length,
      1,
      'a single commit must yield exactly one bullet, not one commit bullet plus N category bullets'
    );
  });

  it('preserves the fallback role: a file Git has no knowledge of at all still surfaces', () => {
    const scanned = [{ relativePath: 'scratch/local-notes.txt', mtimeMs: Date.now() }];
    const gitInvisibleScanned = excludeGitKnownFiles(scanned, [], [], [], []);
    assert.deepStrictEqual(gitInvisibleScanned, scanned);

    const aggregates = aggregateFiles([], [], [], gitInvisibleScanned);
    assert.strictEqual(buildCategoryBullets(aggregates).length, 1);
  });

  it('drops only the overlapping files, keeping genuinely git-invisible ones from the same scan', () => {
    const commits = [makeCommit({ files: ['elements/logo.php'] })];
    const scanned = [
      { relativePath: 'elements/logo.php', mtimeMs: Date.now() },
      { relativePath: 'scratch/local-notes.txt', mtimeMs: Date.now() }
    ];
    const result = excludeGitKnownFiles(scanned, commits, [], [], []);
    assert.deepStrictEqual(
      result.map((f) => f.relativePath),
      ['scratch/local-notes.txt']
    );
  });

  it('also excludes files already reported as staged/unstaged/untracked, not just committed ones', () => {
    const scanned = [
      { relativePath: 'src/a.ts', mtimeMs: Date.now() },
      { relativePath: 'src/b.ts', mtimeMs: Date.now() },
      { relativePath: 'src/c.ts', mtimeMs: Date.now() }
    ];
    const result = excludeGitKnownFiles(
      scanned,
      [],
      [{ relativePath: 'src/a.ts', changeType: 'modified' }],
      [{ relativePath: 'src/b.ts', changeType: 'modified' }],
      ['src/c.ts']
    );
    assert.deepStrictEqual(result, []);
  });

  it('returns scanned files unchanged when nothing is known to Git (non-repo / Git unavailable)', () => {
    const scanned = [
      { relativePath: 'a.txt', mtimeMs: Date.now() },
      { relativePath: 'b.txt', mtimeMs: Date.now() }
    ];
    assert.deepStrictEqual(excludeGitKnownFiles(scanned, [], [], [], []), scanned);
  });

  it('regression: a tracked-and-clean file with a recent mtime (checkout/merge/pull residue) is dropped even though Git reports it as unchanged', () => {
    // Simulates `git checkout`/`merge`/`pull` rewriting a tracked file's
    // on-disk content back to something byte-identical to what Git already
    // has recorded - `git status` has nothing to report, so the file never
    // appears in commits/staged/unstaged/untracked, yet the scanner's
    // independent mtime walk still picks it up as "recently modified".
    const scanned = [
      { relativePath: 'app/Controller/MenusController.php', mtimeMs: Date.now() },
      { relativePath: 'app/Model/Item.php', mtimeMs: Date.now() }
    ];
    const trackedFiles = ['app/Controller/MenusController.php', 'app/Model/Item.php', 'app/View/Menus/index.ctp'];

    const result = excludeGitKnownFiles(scanned, [], [], [], [], trackedFiles);
    assert.deepStrictEqual(result, []);
  });

  it('preserves the fallback role even when trackedFiles is supplied: a file absent from Git entirely still surfaces', () => {
    const scanned = [{ relativePath: 'scratch/local-notes.txt', mtimeMs: Date.now() }];
    const trackedFiles = ['src/index.ts'];
    const gitInvisibleScanned = excludeGitKnownFiles(scanned, [], [], [], [], trackedFiles);
    assert.deepStrictEqual(gitInvisibleScanned, scanned);
  });

  it('drops tracked-and-clean files while keeping genuinely untracked/ignored ones from the same scan', () => {
    const scanned = [
      { relativePath: 'app/Model/Item.php', mtimeMs: Date.now() },
      { relativePath: 'scratch/local-notes.txt', mtimeMs: Date.now() }
    ];
    const trackedFiles = ['app/Model/Item.php', 'app/Controller/MenusController.php'];
    const result = excludeGitKnownFiles(scanned, [], [], [], [], trackedFiles);
    assert.deepStrictEqual(
      result.map((f) => f.relativePath),
      ['scratch/local-notes.txt']
    );
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
