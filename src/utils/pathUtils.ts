import * as path from 'path';

/**
 * Converts a path to use forward slashes regardless of platform.
 * Category/language classification rules are all written assuming `/`
 * separators, so every path must be normalized before matching.
 */
export function toPosixPath(inputPath: string): string {
  return inputPath.split(path.sep).join('/');
}

/**
 * Returns `absolutePath` relative to `rootPath`, using forward slashes.
 * Falls back to the (posix-ified) absolute path if it isn't inside root.
 */
export function toWorkspaceRelativePath(rootPath: string, absolutePath: string): string {
  const relative = path.relative(rootPath, absolutePath);
  if (!relative || relative.startsWith('..')) {
    return toPosixPath(absolutePath);
  }
  return toPosixPath(relative);
}

/** True if `mtimeMs` falls on the current calendar day in local time. */
export function isToday(mtimeMs: number): boolean {
  const now = new Date();
  const then = new Date(mtimeMs);
  return (
    now.getFullYear() === then.getFullYear() &&
    now.getMonth() === then.getMonth() &&
    now.getDate() === then.getDate()
  );
}

/** Returns the lowercase file extension including the leading dot, e.g. `.ts`. Empty string if none. */
export function getExtension(relativePath: string): string {
  const base = path.posix.basename(relativePath);
  const idx = base.lastIndexOf('.');
  // Treat dotfiles like ".env" as having no extension.
  if (idx <= 0) {
    return '';
  }
  return base.slice(idx).toLowerCase();
}

/** Returns the lowercase basename of a (posix) relative path. */
export function getBasename(relativePath: string): string {
  return path.posix.basename(relativePath).toLowerCase();
}

/** Returns the path split into lowercase segments, e.g. "src/auth/x.ts" -> ["src","auth","x.ts"]. */
export function getSegments(relativePath: string): string[] {
  return toPosixPath(relativePath)
    .toLowerCase()
    .split('/')
    .filter(Boolean);
}
