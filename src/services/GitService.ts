import { execFile } from 'child_process';
import { promisify } from 'util';
import { GitCommitInfo, GitFileChange, ChangeType } from '../models/types';
import { Logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

// Record/unit separators used to robustly parse `git log` output in one pass
// instead of spawning a separate `git show` per commit (fast even with many
// commits today, and immune to commit messages that contain punctuation).
const RECORD_SEPARATOR = '\x1e';
const UNIT_SEPARATOR = '\x1f';

const MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15000;

export type GitErrorCode = 'not-found' | 'timeout' | 'buffer-exceeded' | 'exec-error';

export class GitCommandError extends Error {
  constructor(message: string, public readonly code: GitErrorCode) {
    super(message);
    this.name = 'GitCommandError';
  }
}

/**
 * Thin, safe wrapper around the `git` CLI. Every call uses `execFile` with an
 * argument array (never a shell string), so paths and messages containing
 * spaces or shell metacharacters can never cause command injection or
 * mis-parsing — important since a workspace path itself may contain spaces.
 */
export class GitService {
  constructor(private readonly logger: Logger) {}

  async isGitAvailable(): Promise<boolean> {
    try {
      await this.run(undefined, ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  async isRepository(cwd: string): Promise<boolean> {
    try {
      const out = await this.run(cwd, ['rev-parse', '--is-inside-work-tree']);
      return out.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** Returns the configured git identity (email, falling back to name) for scoping commits to "my" work. */
  async getCurrentUserIdentity(cwd: string): Promise<string | undefined> {
    try {
      const email = (await this.run(cwd, ['config', 'user.email'])).trim();
      if (email) {
        return email;
      }
    } catch {
      // user.email not configured; fall through to user.name.
    }
    try {
      const name = (await this.run(cwd, ['config', 'user.name'])).trim();
      if (name) {
        return name;
      }
    } catch {
      // Identity not configured at all; caller will show commits from every author.
    }
    return undefined;
  }

  /**
   * Commits within [since, until] on the current branch, excluding merge
   * commits, optionally scoped to a single author.
   */
  async getCommitsInRange(
    cwd: string,
    since: Date,
    until: Date,
    authorFilter?: string
  ): Promise<GitCommitInfo[]> {
    const format = `${RECORD_SEPARATOR}%H${UNIT_SEPARATOR}%an${UNIT_SEPARATOR}%aI${UNIT_SEPARATOR}%s`;
    const args = [
      'log',
      `--since=${since.toISOString()}`,
      `--until=${until.toISOString()}`,
      '--no-merges',
      '--name-only',
      `--pretty=format:${format}`
    ];
    if (authorFilter) {
      args.push(`--author=${authorFilter}`);
    }

    let stdout: string;
    try {
      stdout = await this.run(cwd, args);
    } catch (err) {
      this.logger.warn(`git log failed, skipping commits: ${(err as Error).message}`);
      return [];
    }
    if (!stdout.trim()) {
      return [];
    }

    const commits: GitCommitInfo[] = [];
    const chunks = stdout.split(RECORD_SEPARATOR).filter((chunk) => chunk.trim().length > 0);
    for (const chunk of chunks) {
      const newlineIdx = chunk.indexOf('\n');
      const header = newlineIdx === -1 ? chunk : chunk.slice(0, newlineIdx);
      const filesBlock = newlineIdx === -1 ? '' : chunk.slice(newlineIdx + 1);
      const parts = header.split(UNIT_SEPARATOR);
      if (parts.length < 4) {
        continue;
      }
      // Indices are safe: `parts.length >= 4` was just checked above.
      const hash = parts[0]!;
      const author = parts[1]!;
      const date = parts[2]!;
      const message = parts.slice(3).join(UNIT_SEPARATOR).trim();
      const files = filesBlock
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      commits.push({
        hash,
        shortHash: hash.slice(0, 7),
        author,
        date,
        message,
        files
      });
    }
    return commits;
  }

  async getStagedChanges(cwd: string): Promise<GitFileChange[]> {
    try {
      const out = await this.run(cwd, ['diff', '--cached', '--name-status']);
      return this.parseNameStatus(out);
    } catch (err) {
      this.logger.warn(`git diff --cached failed, skipping staged changes: ${(err as Error).message}`);
      return [];
    }
  }

  async getUnstagedChanges(cwd: string): Promise<GitFileChange[]> {
    try {
      const out = await this.run(cwd, ['diff', '--name-status']);
      return this.parseNameStatus(out);
    } catch (err) {
      this.logger.warn(`git diff failed, skipping unstaged changes: ${(err as Error).message}`);
      return [];
    }
  }

  async getUntrackedFiles(cwd: string): Promise<string[]> {
    try {
      const out = await this.run(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
      return out
        .split('\n')
        .filter((line) => line.startsWith('??'))
        .map((line) => line.slice(3).trim())
        .filter((p) => p.length > 0);
    } catch (err) {
      this.logger.warn(`git status failed, skipping untracked files: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Full patch for a single commit (used to give the AI summary something
   * to reason about beyond the commit message). Truncated to `maxChars`
   * since diffs are otherwise unbounded in size.
   */
  async getCommitDiff(cwd: string, hash: string, maxChars: number): Promise<string> {
    try {
      const out = await this.run(cwd, ['show', hash, '--no-color', '--unified=1', '--no-notes']);
      return out.length > maxChars ? `${out.slice(0, maxChars)}\n… (diff truncated)` : out;
    } catch (err) {
      this.logger.warn(`git show failed for ${hash}, skipping diff: ${(err as Error).message}`);
      return '';
    }
  }

  /** Full patch text of currently staged changes, truncated to `maxChars`. Used for AI commit message generation. */
  async getStagedDiff(cwd: string, maxChars: number): Promise<string> {
    try {
      const out = await this.run(cwd, ['diff', '--cached', '--no-color', '--unified=2']);
      return out.length > maxChars ? `${out.slice(0, maxChars)}\n… (diff truncated)` : out;
    } catch (err) {
      this.logger.warn(`git diff --cached failed, skipping staged diff text: ${(err as Error).message}`);
      return '';
    }
  }

  /** Full patch text of currently unstaged changes, truncated to `maxChars`. Used for AI commit message generation. */
  async getUnstagedDiff(cwd: string, maxChars: number): Promise<string> {
    try {
      const out = await this.run(cwd, ['diff', '--no-color', '--unified=2']);
      return out.length > maxChars ? `${out.slice(0, maxChars)}\n… (diff truncated)` : out;
    } catch (err) {
      this.logger.warn(`git diff failed, skipping unstaged diff text: ${(err as Error).message}`);
      return '';
    }
  }

  /** True if there is any staged, unstaged, or untracked change - used to decide whether to offer commit-message generation. */
  async hasUncommittedChanges(cwd: string): Promise<boolean> {
    try {
      const out = await this.run(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
      return out.trim().length > 0;
    } catch (err) {
      this.logger.warn(`git status failed while checking for uncommitted changes: ${(err as Error).message}`);
      return false;
    }
  }

  /** Parses `--name-status` output (handles A/M/D/R/C/T/U codes, including two-column renames/copies). */
  private parseNameStatus(output: string): GitFileChange[] {
    const changes: GitFileChange[] = [];
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const line of lines) {
      const tabIdx = line.indexOf('\t');
      if (tabIdx === -1) {
        continue;
      }
      const statusCode = line.slice(0, tabIdx).charAt(0).toUpperCase();
      const pathColumns = line.slice(tabIdx + 1).split('\t').filter(Boolean);
      const relativePath = pathColumns[pathColumns.length - 1];
      if (!relativePath) {
        continue;
      }

      let changeType: ChangeType;
      switch (statusCode) {
        case 'A':
        case 'C':
          changeType = 'created';
          break;
        case 'D':
          changeType = 'deleted';
          break;
        case 'R':
          changeType = 'renamed';
          break;
        default:
          changeType = 'modified';
          break;
      }
      changes.push({ relativePath, changeType });
    }
    return changes;
  }

  private async run(cwd: string | undefined, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true
      });
      return stdout;
    } catch (err) {
      throw this.normalizeError(err);
    }
  }

  private normalizeError(err: unknown): GitCommandError {
    const nodeErr = err as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: NodeJS.Signals | null;
      stderr?: string | Buffer;
    };

    if (nodeErr?.code === 'ENOENT') {
      return new GitCommandError('git executable not found on PATH', 'not-found');
    }
    if (nodeErr?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return new GitCommandError('git output exceeded the buffer limit', 'buffer-exceeded');
    }
    if (nodeErr?.killed && nodeErr.signal === 'SIGTERM') {
      return new GitCommandError('git command timed out', 'timeout');
    }
    const stderr = nodeErr?.stderr ? String(nodeErr.stderr).trim() : '';
    return new GitCommandError(stderr || nodeErr?.message || 'git command failed', 'exec-error');
  }
}
