import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SummarySettings, ScannedFile } from '../models/types';
import { toWorkspaceRelativePath } from '../utils/pathUtils';
import { Logger } from '../utils/logger';

// Safety valves for huge/pathological repositories (spec edge case): once
// exceeded, the scan stops early rather than hanging the extension host.
const MAX_FILES_VISITED = 20000;
const MAX_DIRS_VISITED = 20000;
const MAX_DEPTH = 20;

export interface WorkspaceScanResult {
  files: ScannedFile[];
  /** True if the scan stopped early because it hit a safety limit. */
  truncated: boolean;
}

/**
 * Walks the workspace looking for files whose mtime falls within
 * [since, until]. This is the only signal available in workspaces without
 * Git (or for Git-ignored files), and runs independently of GitService so
 * it works even when git is missing entirely.
 */
export class WorkspaceScanner {
  constructor(private readonly logger: Logger) {}

  async findModifiedFilesInRange(
    rootPath: string,
    settings: SummarySettings,
    since: Date,
    until: Date,
    token?: vscode.CancellationToken,
    progress?: vscode.Progress<{ message?: string }>
  ): Promise<WorkspaceScanResult> {
    const ignoredFolders = new Set(settings.ignoredFolders.map((f) => f.toLowerCase()));
    const ignoredExtensions = new Set(settings.ignoredExtensions.map((e) => e.toLowerCase()));
    const sinceMs = since.getTime();
    const untilMs = until.getTime();

    const results: ScannedFile[] = [];
    let filesVisited = 0;
    let dirsVisited = 0;
    let lastReportedAt = 0;
    let truncated = false;

    const limitReached = (): boolean =>
      !!token?.isCancellationRequested || filesVisited >= MAX_FILES_VISITED || dirsVisited >= MAX_DIRS_VISITED;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (limitReached()) {
        if (!token?.isCancellationRequested) {
          truncated = true;
        }
        return;
      }
      if (depth > MAX_DEPTH) {
        truncated = true;
        return;
      }

      dirsVisited++;

      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (err) {
        this.logger.warn(`Skipping unreadable directory "${dir}": ${(err as Error).message}`);
        return;
      }

      for (const entry of entries) {
        if (limitReached()) {
          truncated = truncated || !token?.isCancellationRequested;
          return;
        }
        if (entry.isSymbolicLink()) {
          continue;
        }

        const entryPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (ignoredFolders.has(entry.name.toLowerCase())) {
            continue;
          }
          await walk(entryPath, depth + 1);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        filesVisited++;
        if (progress && filesVisited - lastReportedAt >= 500) {
          lastReportedAt = filesVisited;
          progress.report({ message: `Scanning workspace files… (${filesVisited} checked)` });
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (ext && ignoredExtensions.has(ext)) {
          continue;
        }

        try {
          const stat = await fs.promises.stat(entryPath);
          if (stat.isFile() && stat.mtimeMs >= sinceMs && stat.mtimeMs <= untilMs) {
            results.push({
              relativePath: toWorkspaceRelativePath(rootPath, entryPath),
              mtimeMs: stat.mtimeMs
            });
          }
        } catch (err) {
          // Permission denied or the file vanished mid-scan; skip and continue.
          this.logger.warn(`Skipping unreadable file "${entryPath}": ${(err as Error).message}`);
        }
      }
    };

    await walk(rootPath, 0);
    return { files: results, truncated };
  }
}
