import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService, filterCommitsByIdentity } from '../../services/GitService';
import { GitCommitInfo } from '../../models/types';
import { Logger } from '../../utils/logger';

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

describe('GitService.filterCommitsByIdentity', () => {
  it('returns all commits unchanged when identity is undefined', () => {
    const commits = [makeCommit({ author: 'Dev' }), makeCommit({ author: 'Other' })];
    assert.deepStrictEqual(filterCommitsByIdentity(commits, undefined), commits);
  });

  it('returns all commits unchanged when identity is blank/whitespace', () => {
    const commits = [makeCommit({ author: 'Dev' })];
    assert.deepStrictEqual(filterCommitsByIdentity(commits, '   '), commits);
  });

  it('includes an exact email match regardless of case', () => {
    const mine = makeCommit({ authorEmail: 'Dev@Example.com' });
    const result = filterCommitsByIdentity([mine], 'dev@example.com');
    assert.strictEqual(result.length, 1);
  });

  it('excludes a teammate whose email differs only where the identity has a literal "."', () => {
    // Old bug: `--author=a.b@company.com` treated the "." as a regex
    // wildcard, so "aXb@company.com" matched too.
    const mine = makeCommit({ hash: 'mine', authorEmail: 'a.b@company.com' });
    const lookalike = makeCommit({ hash: 'lookalike', authorEmail: 'aXb@company.com' });
    const result = filterCommitsByIdentity([mine, lookalike], 'a.b@company.com');
    assert.deepStrictEqual(result.map((c) => c.hash), ['mine']);
  });

  it('excludes a teammate whose name is an unanchored prefix of the identity', () => {
    // Old bug: `--author=Ana` unanchored-matched "Anand Kumar" too.
    const mine = makeCommit({ hash: 'mine', author: 'Ana', authorEmail: 'ana@example.com' });
    const teammate = makeCommit({ hash: 'teammate', author: 'Anand Kumar', authorEmail: 'anand@example.com' });
    const result = filterCommitsByIdentity([mine, teammate], 'Ana');
    assert.deepStrictEqual(result.map((c) => c.hash), ['mine']);
  });

  it('matches a name-fallback identity exactly, not as a substring', () => {
    const mine = makeCommit({ hash: 'mine', author: 'Jordan Lee', authorEmail: 'jordan@example.com' });
    const other = makeCommit({ hash: 'other', author: 'Jordan Lee Jr.', authorEmail: 'jordanjr@example.com' });
    const result = filterCommitsByIdentity([mine, other], 'Jordan Lee');
    assert.deepStrictEqual(result.map((c) => c.hash), ['mine']);
  });

  it('regression: 1 real commit + 1 teammate lookalike collapses to exactly 1 commit', () => {
    const mine = makeCommit({ hash: 'mine', author: 'Himanshu', authorEmail: 'himanshu.chandarana@petpooja.com' });
    const lookalike = makeCommit({
      hash: 'lookalike',
      author: 'Other Dev',
      authorEmail: 'himanshuXchandarana@petpooja.com'
    });
    const result = filterCommitsByIdentity([mine, lookalike], 'himanshu.chandarana@petpooja.com');
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]?.hash, 'mine');
  });
});

describe('GitService.getCommitsInRange (real git repo)', function () {
  this.timeout(20000);

  let dir: string;
  let gitService: GitService;

  before(() => {
    gitService = new GitService(new Logger('git-standup-test'));
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-standup-test-'));
    execFileSync('git', ['init'], { cwd: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function commitAs(name: string, email: string, message: string): void {
    execFileSync(
      'git',
      [
        '-c',
        `user.name=${name}`,
        '-c',
        `user.email=${email}`,
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        message
      ],
      { cwd: dir }
    );
  }

  function wideSince(): Date {
    return new Date(Date.now() - 60 * 60 * 1000);
  }

  function wideUntil(): Date {
    return new Date(Date.now() + 60 * 60 * 1000);
  }

  it('excludes a dotted-email lookalike teammate end-to-end', async () => {
    commitAs('Himanshu', 'himanshu.chandarana@petpooja.com', 'my real commit');
    commitAs('Other Dev', 'himanshuXchandarana@petpooja.com', 'teammate lookalike commit');

    const commits = await gitService.getCommitsInRange(
      dir,
      wideSince(),
      wideUntil(),
      'himanshu.chandarana@petpooja.com'
    );
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(commits[0]?.message, 'my real commit');
  });

  it('excludes a substring/prefix-name lookalike teammate end-to-end', async () => {
    commitAs('Ana', 'ana@example.com', 'my real commit');
    commitAs('Anand Kumar', 'anand@example.com', 'teammate lookalike commit');

    const commits = await gitService.getCommitsInRange(dir, wideSince(), wideUntil(), 'Ana');
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(commits[0]?.message, 'my real commit');
  });

  it('returns commits from every author when no identity is passed', async () => {
    commitAs('Ana', 'ana@example.com', 'first commit');
    commitAs('Anand Kumar', 'anand@example.com', 'second commit');

    const commits = await gitService.getCommitsInRange(dir, wideSince(), wideUntil(), undefined);
    assert.strictEqual(commits.length, 2);
  });

  it('includes a commit when the identity exactly equals its author email', async () => {
    commitAs('Dev', 'dev@example.com', 'ordinary commit');

    const commits = await gitService.getCommitsInRange(dir, wideSince(), wideUntil(), 'dev@example.com');
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(commits[0]?.authorEmail, 'dev@example.com');
  });
});

describe('GitService.listTrackedFiles (real git repo)', function () {
  this.timeout(20000);

  let dir: string;
  let gitService: GitService;

  before(() => {
    gitService = new GitService(new Logger('git-standup-test'));
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-standup-test-'));
    execFileSync('git', ['init'], { cwd: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeAndAdd(relativePath: string, contents: string): void {
    const fullPath = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents);
    execFileSync('git', ['add', relativePath], { cwd: dir });
  }

  function commitAs(name: string, email: string, message: string): void {
    execFileSync(
      'git',
      ['-c', `user.name=${name}`, '-c', `user.email=${email}`, '-c', 'commit.gpgsign=false', 'commit', '-m', message],
      { cwd: dir }
    );
  }

  it('lists every committed file, repo-relative, regardless of mtime', async () => {
    writeAndAdd('src/index.ts', 'export {};');
    writeAndAdd('README.md', '# hi');
    commitAs('Dev', 'dev@example.com', 'initial commit');

    const files = await gitService.listTrackedFiles(dir);
    assert.deepStrictEqual([...files].sort(), ['README.md', 'src/index.ts']);
  });

  it('does not include an untracked (not yet `git add`ed) file', async () => {
    writeAndAdd('src/index.ts', 'export {};');
    commitAs('Dev', 'dev@example.com', 'initial commit');
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'not added');

    const files = await gitService.listTrackedFiles(dir);
    assert.deepStrictEqual(files, ['src/index.ts']);
  });

  it('still lists a tracked file after checkout restores it to earlier, byte-identical content (mtime bumped, status clean)', async () => {
    writeAndAdd('app/Model/Item.php', '<?php // v1');
    commitAs('Dev', 'dev@example.com', 'first commit');

    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'app/Model/Item.php'), '<?php // v2');
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Dev',
        '-c',
        'user.email=dev@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-am',
        'change on feature'
      ],
      { cwd: dir }
    );
    // "-" returns to the previously checked-out branch regardless of its
    // name (avoids depending on `init.defaultBranch` being main vs master).
    // This rewrites Item.php's on-disk content/mtime back to "v1", exactly
    // the scenario from the real bug - `git status` will report the tree
    // as clean, but `listTrackedFiles` must still list the file.
    execFileSync('git', ['checkout', '-'], { cwd: dir });

    const files = await gitService.listTrackedFiles(dir);
    assert.deepStrictEqual(files, ['app/Model/Item.php']);
  });

  it('returns an empty array (not a throw) when cwd is not a Git repository', async () => {
    const nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-standup-test-non-repo-'));
    try {
      const files = await gitService.listTrackedFiles(nonRepoDir);
      assert.deepStrictEqual(files, []);
    } finally {
      fs.rmSync(nonRepoDir, { recursive: true, force: true });
    }
  });
});
