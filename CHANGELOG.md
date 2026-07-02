# Changelog

All notable changes to the "Git Work Summary" extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - Unreleased

### Added

- Initial release.
- Activity Bar container with "Today's Summary" webview panel and "Detected Changes" tree view.
- `Generate Summary`, `Copy Summary`, `Export as Markdown`, `Refresh`, `Select Workspace Folder`, and `Open Settings` commands.
- Deterministic, local-only summary algorithm: today's Git commits (author-scoped, merge commits excluded), staged changes, unstaged changes, untracked files, and a Git-independent workspace mtime scan.
- Rule-based file categorization (Authentication, Invoice Processing, Payment Processing, API Routes, Database, Testing, Documentation, Dependencies, Business Logic, Configuration, UI Components, plus a folder-derived fallback).
- Commit message humanizer that rewrites conventional-commit and imperative-mood subjects into natural past tense, entirely via regex/string rules (no AI).
- Markdown export to `daily-summary-YYYY-MM-DD.md` via a Save dialog.
- Full configuration surface under `gitWorkSummary.*`: toggle each data source, cap bullet count, customize ignored folders/extensions, and set a default export folder.
- Graceful degradation when Git is missing, the folder isn't a repository, or the repository is very large (workspace scan is cancellable and capped).
- Renamed the extension to "Git Work Summary" (previously prototyped as "Brag Document") with a new full-color icon.
- AI-Enhanced Summaries: a dedicated `Generate AI Summary` command/button sends today's commit messages and diffs to the Groq API to generate a short title and description per commit, rendered in a new nested template (`Today's Work — {Project} ({Date})` / title / Commit Message / Description). Falls back to the deterministic summary automatically on any failure (missing key, invalid key, rate limit, wrong model, network/firewall issue, unparseable response), each with a specific, actionable notice.
- `Set Groq API Key` / `Clear Groq API Key` commands; the key is stored in VS Code's encrypted Secret Storage, never in `settings.json` or source.
- New settings: `gitWorkSummary.aiModel`, `gitWorkSummary.aiMaxCommits`.
- Split summary generation into three explicit actions: `Generate Summary` (deterministic, unlimited), `Generate AI Summary` (Groq-powered, capped at 10/day, prompts for an API key on first use), and `Clear Summary` (resets the panel). Removed the `enableAiSummary` setting - the button choice now controls this directly.
- A persistent daily quota (10 AI summaries/day, resets at local midnight) tracked via `globalState`, with a live "AI summaries today: X of 10 used" indicator in the panel.
- Request/token budgeting tuned to the target Groq tier (60 requests/min, 1,000/day, 6,000 tokens/min, 500,000 tokens/day): per-commit diff size and `max_completion_tokens` now scale dynamically with commit count so a single request stays safely under the 6,000 tokens/minute limit, which is the only realistically binding constraint.
- Replaced the two-button AI model with a **"Generate with AI" checkbox** (persisted, applies to whichever generate action you run next) and five period-specific generate actions: `Generate Today's Summary`, `Generate Yesterday's Summary`, `Generate Weekly Summary` (rolling 7 days), `Generate Monthly Summary` (rolling 30 days), and `Generate Custom Summary` (any range up to 31 days, via inline date pickers in the panel or Command Palette prompts). Removed `gitWorkSummary.generateSummary`/`generateAiSummary` in favor of these.
- `GitService`/`WorkspaceScanner`/`SummaryService` generalized from an implicit "today" to an arbitrary `[since, until]` date range (`getCommitsInRange`, `findModifiedFilesInRange`); staged/unstaged/untracked state is now only included when the selected period actually extends through today, since it has no meaning for a purely historical range.
- New `src/utils/dateRangeUtils.ts`: rolling-window calculation, custom-range validation (31-day cap, no future dates), and always-absolute display-label formatting (never "Yesterday" in an exported file, only real dates).
- Markdown export filenames are now period-aware (`daily-summary-*.md`, `weekly-summary-*_to_*.md`, `monthly-summary-*_to_*.md`, `custom-summary-*_to_*.md`).
- New **Generate Commit Message** feature: appears only when there are uncommitted changes and a Groq API key is configured. Uses the staged diff (falling back to unstaged + untracked filenames) to draft an imperative-mood commit message via Groq, and writes it directly into VS Code's built-in Source Control input box (via the `vscode.git` extension API), falling back to clipboard copy if that's unavailable. Independent of the 10/day AI summary quota and the "Generate with AI" checkbox.
- `GroqService.generateCommitMessage`: a separate, plain-text (non-JSON) generation path with its own, more generous per-call token budget suited to a single diff.
- New `Toggle AI Mode` command (Command Palette equivalent of the checkbox).
- Renamed the extension from "Daily Work Summary -- Git" to **"Git Work Summary"** (`daily-work-summary-git` → `git-work-summary`, and every command id, setting key, view id, and stored state key updated to match). Added author contact info (`mahirpatel9765@gmail.com`) to the manifest.
- Rewrote the README as a concise, user-facing guide (brief, use cases, setup, usage) with real screenshots of the panel and Activity Bar; moved the deeper technical write-up out of the default read path.

### Fixed

- Panel content (buttons, date inputs, bullets, footer) was flush against the left/right edges of the sidebar with no gutter — `#app` now has proper horizontal padding.
- README screenshots rendered as broken images in the Extension Details view because `package.json`'s `repository` field pointed at a placeholder GitHub URL that didn't exist; `vsce` rewrites relative README image paths to that repo's raw-content URL at package time, so a dead repo meant dead images. Now points at the real repository (`github.com/MahirPatel/git-work-summary`).
