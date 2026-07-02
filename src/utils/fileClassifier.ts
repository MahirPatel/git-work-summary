import { ChangeType } from '../models/types';
import { getBasename, getExtension, getSegments, toPosixPath } from './pathUtils';

/**
 * Deterministic (non-AI) classification of a changed file into a human-readable
 * "category" (business concept) plus, for a handful of structural categories,
 * a fixed bullet phrase taken directly from the spec's mapping table
 * (e.g. "Modified SQL -> Improved database queries"). Categories without a
 * fixed phrase are "open": their bullet wording is derived from the change
 * type(s) observed (created/modified/deleted) and how many files landed in
 * the group, in {@link buildCategoryBulletText}.
 */

export interface FileClassification {
  category: string;
  /** Present for structural categories whose wording never depends on file count. */
  fixedPhrase?: string;
}

interface ClassifyContext {
  lower: string;
  basename: string;
  ext: string;
  segments: string[];
}

interface CategoryRule {
  category: string;
  fixedPhrase?: string;
  test: (ctx: ClassifyContext) => boolean;
}

const DEPENDENCY_MANIFESTS = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.json',
  'composer.lock',
  'requirements.txt',
  'pipfile',
  'pipfile.lock',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'gemfile',
  'gemfile.lock'
]);

// Ordered: first matching rule wins, grouped in three tiers.
//
// Tier 1 - structural/meta rules. These describe *what kind of file this is*
// independent of domain, and must be checked before domain keywords: a test
// file under src/auth/ is still fundamentally "test coverage" work, not
// "authentication feature" work, and would otherwise never show up as
// Testing since most real test/doc files live under domain folders.
//
// Tier 2 - domain/business keywords (Authentication, Invoice, Payment).
//
// Tier 3 - generic architectural shape (Controller, Routes, Database, UI).
// These represent the feature work itself, so a domain keyword should take
// priority when present - e.g. "controllers/InvoiceController.php" is
// "Invoice Processing", not the generic "Business Logic" (spec example).
const CATEGORY_RULES: CategoryRule[] = [
  // --- Tier 1: structural/meta ---
  {
    category: 'Testing',
    fixedPhrase: 'Added test coverage',
    test: (ctx) =>
      /\.(test|spec)\./.test(ctx.basename) ||
      /(^|\/)(tests?|__tests__|spec)(\/|$)/.test(ctx.lower)
  },
  {
    category: 'Documentation',
    fixedPhrase: 'Updated documentation',
    test: (ctx) =>
      /^readme/.test(ctx.basename) ||
      ctx.basename === 'changelog.md' ||
      (ctx.ext === '.md' && /(^|\/)docs?(\/|$)/.test(ctx.lower))
  },
  {
    category: 'Dependencies',
    fixedPhrase: 'Updated project dependencies',
    test: (ctx) => DEPENDENCY_MANIFESTS.has(ctx.basename)
  },
  {
    category: 'Configuration',
    fixedPhrase: 'Updated project configuration',
    test: (ctx) =>
      ctx.basename.startsWith('.env') ||
      /(^|\/)config(\/|$)/.test(ctx.lower) ||
      /\.config\./.test(ctx.basename) ||
      /^appsettings/.test(ctx.basename) ||
      ctx.basename === 'tsconfig.json' ||
      ctx.basename === 'webpack.config.js'
  },
  // --- Tier 2: domain/business keywords ---
  {
    category: 'Authentication',
    test: (ctx) =>
      /(^|\/)(auth|authentication)(\/|$)/.test(ctx.lower) ||
      /(auth|login|logout|session|passport|oauth|jwt)/.test(ctx.basename)
  },
  {
    category: 'Invoice Processing',
    test: (ctx) => /invoice/.test(ctx.lower)
  },
  {
    category: 'Payment Processing',
    test: (ctx) =>
      /(^|\/)(payments?|billing|checkout)(\/|$)/.test(ctx.lower) ||
      /(payment|billing|checkout|stripe|paypal)/.test(ctx.basename)
  },
  // --- Tier 3: generic architectural shape ---
  {
    category: 'API Routes',
    fixedPhrase: 'Updated application routing',
    test: (ctx) =>
      /(^|\/)routes?(\/|$)/.test(ctx.lower) ||
      ctx.basename === 'api.php' ||
      /^routes?\./.test(ctx.basename) ||
      /router/.test(ctx.basename)
  },
  {
    category: 'Database',
    fixedPhrase: 'Improved database queries',
    test: (ctx) =>
      ctx.ext === '.sql' ||
      /(^|\/)(migrations?|seeders?)(\/|$)/.test(ctx.lower) ||
      /schema/.test(ctx.basename)
  },
  {
    category: 'Business Logic',
    fixedPhrase: 'Updated business logic',
    test: (ctx) => /controller/.test(ctx.basename)
  },
  {
    category: 'UI Components',
    test: (ctx) =>
      ['.css', '.scss', '.sass', '.less', '.tsx', '.jsx', '.vue', '.svelte'].includes(ctx.ext) ||
      /(^|\/)components?(\/|$)/.test(ctx.lower)
  }
];

// Structural/generic directory names that don't describe a business domain,
// skipped when deriving a fallback category from folder names.
const GENERIC_SEGMENTS = new Set([
  'src', 'source', 'lib', 'app', 'apps', 'main', 'internal', 'pkg', 'packages',
  'test', 'tests', '__tests__', 'spec', 'dist', 'build', 'out', 'bin',
  'controllers', 'controller', 'services', 'service', 'handlers', 'handler',
  'models', 'model', 'dto', 'dtos', 'repositories', 'repository', 'utils', 'util',
  'helpers', 'helper', 'middlewares', 'middleware', 'views', 'pages', 'components',
  'assets', 'public', 'static', 'config', 'configs'
]);

function titleCaseWord(segment: string): string {
  const words = segment.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) {
    return 'General';
  }
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function deriveFallbackCategory(segments: string[]): string {
  const directories = segments.slice(0, -1);
  const meaningful = directories.filter((seg) => !GENERIC_SEGMENTS.has(seg) && seg.length > 1);
  const pick = meaningful.length > 0 ? meaningful[meaningful.length - 1] : undefined;
  return pick ? titleCaseWord(pick) : 'General';
}

/** Classifies a single (workspace-relative) file path into a category. */
export function classifyFile(relativePath: string): FileClassification {
  const posix = toPosixPath(relativePath);
  const ctx: ClassifyContext = {
    lower: posix.toLowerCase(),
    basename: getBasename(posix),
    ext: getExtension(posix),
    segments: getSegments(posix)
  };

  for (const rule of CATEGORY_RULES) {
    if (rule.test(ctx)) {
      return { category: rule.category, fixedPhrase: rule.fixedPhrase };
    }
  }

  return { category: deriveFallbackCategory(ctx.segments) };
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript React',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript React',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.php': 'PHP',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.go': 'Go',
  '.rb': 'Ruby',
  '.rs': 'Rust',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
  '.c': 'C',
  '.h': 'C/C++ Header',
  '.hpp': 'C++ Header',
  '.swift': 'Swift',
  '.m': 'Objective-C',
  '.scala': 'Scala',
  '.dart': 'Dart',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.sass': 'Sass',
  '.less': 'Less',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.json': 'JSON',
  '.jsonc': 'JSON',
  '.yml': 'YAML',
  '.yaml': 'YAML',
  '.xml': 'XML',
  '.toml': 'TOML',
  '.md': 'Markdown',
  '.mdx': 'MDX',
  '.sql': 'SQL',
  '.sh': 'Shell Script',
  '.bash': 'Shell Script',
  '.ps1': 'PowerShell',
  '.graphql': 'GraphQL',
  '.proto': 'Protocol Buffers'
};

/** Best-effort language/file-type label for display purposes (details panel, tree view). */
export function detectLanguage(relativePath: string): string {
  const basename = getBasename(relativePath);
  if (basename === 'dockerfile') {
    return 'Dockerfile';
  }
  if (basename.startsWith('.env')) {
    return 'Environment Config';
  }
  const ext = getExtension(relativePath);
  return LANGUAGE_BY_EXTENSION[ext] ?? 'Other';
}

function toMidSentenceCategory(category: string): string {
  const lower = category.toLowerCase();
  return lower === 'ui components' ? 'UI components' : lower;
}

/**
 * Builds the single bullet phrase representing every file grouped under one
 * category. Fixed-phrase categories (Testing, Documentation, Dependencies,
 * API Routes, Database, Business Logic, Configuration) always produce the
 * same wording regardless of file count, per the spec's mapping table.
 * "Open" categories derive wording from the dominant change type and count.
 */
export function buildCategoryBulletText(
  category: string,
  fixedPhrase: string | undefined,
  changeTypes: ReadonlySet<ChangeType>,
  fileCount: number
): string {
  if (fixedPhrase) {
    return fixedPhrase;
  }

  const isGeneral = category === 'General';
  const subject = toMidSentenceCategory(category);
  const onlyType = changeTypes.size === 1 ? [...changeTypes][0] : undefined;

  if (fileCount > 1) {
    return isGeneral ? `Updated ${fileCount} project files` : `Improved ${subject} module`;
  }
  if (onlyType === 'created') {
    return isGeneral ? 'Added a new file to the project' : `Added new ${subject} feature`;
  }
  if (onlyType === 'deleted') {
    return isGeneral ? 'Removed a file from the project' : `Removed ${subject} code`;
  }
  return isGeneral ? 'Updated a project file' : `Updated ${subject}`;
}

// Imperative-mood verb (as typically found at the start of a commit subject)
// mapped to its past-tense, summary-friendly form.
const VERB_PAST_TENSE: Record<string, string> = {
  add: 'Added', adds: 'Added',
  fix: 'Fixed', fixes: 'Fixed',
  update: 'Updated', updates: 'Updated',
  create: 'Created', creates: 'Created',
  remove: 'Removed', removes: 'Removed',
  delete: 'Deleted', deletes: 'Deleted',
  implement: 'Implemented', implements: 'Implemented',
  refactor: 'Refactored', refactors: 'Refactored',
  improve: 'Improved', improves: 'Improved',
  optimize: 'Optimized', optimizes: 'Optimized',
  support: 'Added support for', supports: 'Added support for',
  handle: 'Handled', handles: 'Handled',
  prevent: 'Prevented', prevents: 'Prevented',
  ensure: 'Ensured', ensures: 'Ensured',
  move: 'Moved', moves: 'Moved',
  rename: 'Renamed', renames: 'Renamed',
  clean: 'Cleaned up', cleans: 'Cleaned up', cleanup: 'Cleaned up',
  bump: 'Bumped', bumps: 'Bumped',
  merge: 'Merged', merges: 'Merged',
  revert: 'Reverted', reverts: 'Reverted',
  document: 'Documented', documents: 'Documented',
  write: 'Wrote', writes: 'Wrote',
  introduce: 'Introduced', introduces: 'Introduced',
  enable: 'Enabled', enables: 'Enabled',
  disable: 'Disabled', disables: 'Disabled',
  simplify: 'Simplified', simplifies: 'Simplified',
  extract: 'Extracted', extracts: 'Extracted',
  replace: 'Replaced', replaces: 'Replaced',
  upgrade: 'Upgraded', upgrades: 'Upgraded',
  downgrade: 'Downgraded', downgrades: 'Downgraded',
  migrate: 'Migrated', migrates: 'Migrated',
  adjust: 'Adjusted', adjusts: 'Adjusted',
  correct: 'Corrected', corrects: 'Corrected',
  resolve: 'Resolved', resolves: 'Resolved',
  address: 'Addressed', addresses: 'Addressed',
  tweak: 'Tweaked', tweaks: 'Tweaked',
  polish: 'Polished', polishes: 'Polished'
};

// Conventional-commit type prefix, e.g. "feat(auth): " or "fix!: ".
const CONVENTIONAL_PREFIX =
  /^(feat|feature|fix|bugfix|refactor|perf|docs|doc|test|tests|style|build|ci|chore|revert)(\([^)]*\))?!?:\s*/i;

const TYPE_VERB: Record<string, string> = {
  feat: 'Added',
  feature: 'Added',
  fix: 'Fixed',
  bugfix: 'Fixed',
  refactor: 'Refactored',
  perf: 'Improved',
  docs: 'Updated',
  doc: 'Updated',
  test: 'Added test coverage for',
  tests: 'Added test coverage for',
  style: 'Polished',
  build: 'Updated build configuration for',
  ci: 'Updated CI configuration for',
  chore: 'Updated',
  revert: 'Reverted'
};

function capitalizeFirst(text: string): string {
  if (!text) {
    return text;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirstUnlessAcronym(text: string): string {
  if (!text) {
    return text;
  }
  const firstWord = text.split(' ')[0] ?? '';
  const isAcronym = firstWord.length > 1 && firstWord === firstWord.toUpperCase();
  return isAcronym ? text : text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Deterministically rewrites a raw commit subject line into a natural,
 * past-tense summary bullet. Pure string/regex transformation — no AI.
 *
 * Examples:
 *   "fix invoice calculation rounding"      -> "Fixed invoice calculation rounding"
 *   "feat(auth): add login throttling"      -> "Added login throttling"
 *   "Refactored payment module for clarity" -> "Refactored payment module for clarity"
 */
export function humanizeCommitMessage(rawSubject: string): string {
  const original = rawSubject.trim().replace(/\s+/g, ' ');
  if (!original) {
    return 'Made changes';
  }

  let type: string | undefined;
  let remainder = original;
  const conventionalMatch = original.match(CONVENTIONAL_PREFIX);
  if (conventionalMatch) {
    type = conventionalMatch[1]?.toLowerCase();
    remainder = original.slice(conventionalMatch[0].length).trim();
  }

  const leadingWordMatch = remainder.match(/^([A-Za-z]+)\b\s*([\s\S]*)$/);
  const leadingWord = leadingWordMatch?.[1]?.toLowerCase();
  const mappedVerb = leadingWord ? VERB_PAST_TENSE[leadingWord] : undefined;
  const typeVerb = type ? TYPE_VERB[type] : undefined;

  let result: string;
  if (mappedVerb) {
    const rest = (leadingWordMatch?.[2] ?? '').trim();
    result = rest ? `${mappedVerb} ${lowerFirstUnlessAcronym(rest)}` : mappedVerb;
  } else if (typeVerb) {
    result = remainder ? `${typeVerb} ${lowerFirstUnlessAcronym(remainder)}` : typeVerb;
  } else {
    result = capitalizeFirst(remainder);
  }

  result = result.replace(/[.\s]+$/g, '').trim();
  if (result.length > 120) {
    result = result.slice(0, 117).trimEnd() + '...';
  }
  return result || 'Made changes';
}
