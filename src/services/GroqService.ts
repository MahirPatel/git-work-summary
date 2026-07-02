import {
  Groq,
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError
} from 'groq-sdk';
import { Logger } from '../utils/logger';

export interface AiWorkItemInput {
  commitMessage: string;
  diff: string;
}

export interface AiWorkItemOutput {
  title: string;
  description: string;
}

/** Result of a generation attempt: exactly one of `items`/`errorMessage` is set. */
export interface AiGenerationResult {
  items?: AiWorkItemOutput[];
  /** Short, human-readable, safe-to-display-in-a-notice reason for failure. */
  errorMessage?: string;
}

/** Result of a commit-message generation attempt: exactly one of `message`/`errorMessage` is set. */
export interface CommitMessageResult {
  message?: string;
  errorMessage?: string;
}

const REQUEST_TIMEOUT_MS = 30000;

/**
 * Groq rate limits for the configured tier: 60 requests/minute, 1,000
 * requests/day, 6,000 tokens/minute, 500,000 tokens/day. Requests/day is
 * generous relative to the self-imposed 10-per-day AI summary quota, so the
 * only limit that can realistically bind a single request is tokens/minute
 * - one "Generate AI Summary" click is exactly one request, so that request
 * must, by itself, stay safely under the per-minute token cap.
 */
export const GROQ_RATE_LIMITS = {
  requestsPerMinute: 60,
  requestsPerDay: 1000,
  tokensPerMinute: 6000,
  tokensPerDay: 500000
} as const;

// Stay well under `tokensPerMinute` to absorb the fact that token counts
// here are estimated from character counts, not a real tokenizer.
const SAFE_REQUEST_TOKEN_BUDGET = Math.floor(GROQ_RATE_LIMITS.tokensPerMinute * 0.75); // 4500
const CHARS_PER_TOKEN_ESTIMATE = 3.5; // conservative for code/diffs, which tokenize denser than prose
const SYSTEM_PROMPT_TOKEN_ESTIMATE = 150;
const MIN_TOKENS_PER_COMMIT = 120; // floor so every included commit still gets a meaningful diff snippet
const RESPONSE_TOKENS_BASE = 120;
const RESPONSE_TOKENS_PER_ITEM = 60;

/**
 * The largest number of commits that can be processed in one request while
 * guaranteeing every commit still gets at least `MIN_TOKENS_PER_COMMIT`
 * worth of diff content, given the fixed overhead of the system prompt and
 * per-item response tokens. Acts as a hard safety ceiling independent of
 * (and typically stricter than) the user-configurable `aiMaxCommits`.
 */
export function getMaxCommitsForTokenBudget(): number {
  const available = SAFE_REQUEST_TOKEN_BUDGET - SYSTEM_PROMPT_TOKEN_ESTIMATE - RESPONSE_TOKENS_BASE;
  return Math.max(1, Math.floor(available / (MIN_TOKENS_PER_COMMIT + RESPONSE_TOKENS_PER_ITEM)));
}

export interface CommitTokenBudget {
  /** Max diff characters allowed per commit, sized so the whole request stays under the TPM budget. */
  perCommitDiffChars: number;
  /** `max_completion_tokens` to request, sized to what this many response items actually need. */
  maxCompletionTokens: number;
}

/** Computes a per-request token budget for processing exactly `commitCount` commits (see {@link getMaxCommitsForTokenBudget}). */
export function computeTokenBudget(commitCount: number): CommitTokenBudget {
  const count = Math.max(1, commitCount);
  const maxCompletionTokens = Math.min(2048, RESPONSE_TOKENS_BASE + RESPONSE_TOKENS_PER_ITEM * count);
  const promptTokenBudget = SAFE_REQUEST_TOKEN_BUDGET - maxCompletionTokens - SYSTEM_PROMPT_TOKEN_ESTIMATE;
  const perCommitTokenBudget = Math.max(MIN_TOKENS_PER_COMMIT, Math.floor(promptTokenBudget / count));
  return {
    perCommitDiffChars: Math.floor(perCommitTokenBudget * CHARS_PER_TOKEN_ESTIMATE),
    maxCompletionTokens
  };
}

const SYSTEM_PROMPT_TEMPLATE = (count: number): string =>
  [
    "You summarize a developer's Git commits for a daily work log.",
    `You will be given ${count} commit(s), each with its message and code diff.`,
    'For EACH commit, produce a short work title (3-7 words, title case, no trailing period) and a ' +
      'one-sentence plain-language description of what changed and why it likely matters, based on the diff.',
    'Respond with ONLY a JSON object of the form {"items": [{"title": string, "description": string}, ...]}, ' +
      'with exactly one item per commit, in the same order as given. No markdown, no extra commentary, no <think> tags.'
  ].join(' ');

// A single diff (not N commits batched), so a larger per-call budget than
// the summary path is affordable while staying comfortably under the
// tokens-per-minute limit: ~12,000 chars (~3,400 tokens) + a small response
// + system prompt overhead is well under the 6,000 TPM cap.
const COMMIT_MESSAGE_DIFF_CHAR_BUDGET = 12000;
const COMMIT_MESSAGE_MAX_COMPLETION_TOKENS = 300;

const COMMIT_MESSAGE_SYSTEM_PROMPT = [
  'You write concise, professional Git commit messages based on a code diff.',
  'Use the imperative mood for the subject line (e.g. "Fix bug", not "Fixed bug" or "Fixes bug"), no trailing period, ideally under 72 characters.',
  'If the change is non-trivial, you may add a blank line followed by up to 3 short bullet points (starting with "-") explaining key details.',
  'Output ONLY the commit message text - no markdown formatting, no surrounding quotes, no explanations, no <think> tags.'
].join(' ');

/**
 * Thin wrapper around the Groq chat completions API used to turn a commit
 * message + diff into a short title/description pair. Every call degrades
 * gracefully: on any failure this returns a result with `errorMessage` set
 * (never throws) and the caller falls back to the deterministic summary, so
 * a bad API key, rate limit, or network outage never breaks summary
 * generation - it just loses the AI enhancement for that run, with a
 * specific, actionable reason surfaced to the user instead of a generic
 * "something went wrong".
 */
export class GroqService {
  constructor(private readonly logger: Logger) {}

  async generateWorkItems(
    apiKey: string,
    model: string,
    inputs: AiWorkItemInput[],
    maxCompletionTokens: number
  ): Promise<AiGenerationResult> {
    if (inputs.length === 0) {
      return { items: [] };
    }

    const client = new Groq({ apiKey, timeout: REQUEST_TIMEOUT_MS });
    const systemPrompt = SYSTEM_PROMPT_TEMPLATE(inputs.length);
    const userPrompt = buildUserPrompt(inputs);

    try {
      return await this.callAndParse(client, model, systemPrompt, userPrompt, inputs.length, maxCompletionTokens, true);
    } catch (err) {
      if (isUnsupportedReasoningEffortError(err)) {
        this.logger.info(`Model "${model}" does not support reasoning_effort; retrying without it.`);
        try {
          return await this.callAndParse(client, model, systemPrompt, userPrompt, inputs.length, maxCompletionTokens, false);
        } catch (retryErr) {
          this.logger.error('Groq API call failed (retry without reasoning_effort)', retryErr);
          return { errorMessage: describeError(retryErr, model) };
        }
      }
      this.logger.error('Groq API call failed', err);
      return { errorMessage: describeError(err, model) };
    }
  }

  private async callAndParse(
    client: Groq,
    model: string,
    systemPrompt: string,
    userPrompt: string,
    expectedCount: number,
    maxCompletionTokens: number,
    withReasoningEffort: boolean
  ): Promise<AiGenerationResult> {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.4,
      max_completion_tokens: maxCompletionTokens,
      top_p: 0.95,
      stream: false,
      response_format: { type: 'json_object' },
      ...(withReasoningEffort ? { reasoning_effort: 'none' as const } : {})
    });

    const content = completion.choices[0]?.message?.content ?? '';
    const parsed = parseWorkItems(content, expectedCount);
    if (!parsed) {
      this.logger.warn(`Groq response could not be parsed as expected JSON: ${content.slice(0, 300)}`);
      return { errorMessage: 'Groq returned a response that could not be parsed as expected JSON.' };
    }
    return { items: parsed };
  }

  /**
   * Generates a Git commit message from a single diff. Unlike the summary
   * path, this is plain text (not JSON) - a commit message is inherently
   * free-form text, and a single diff doesn't need structured per-item
   * parsing. `extraContext` can add a short note, e.g. naming untracked
   * files that have no diff of their own.
   */
  async generateCommitMessage(
    apiKey: string,
    model: string,
    diff: string,
    extraContext?: string
  ): Promise<CommitMessageResult> {
    const client = new Groq({ apiKey, timeout: REQUEST_TIMEOUT_MS });
    const truncatedDiff =
      diff.length > COMMIT_MESSAGE_DIFF_CHAR_BUDGET
        ? `${diff.slice(0, COMMIT_MESSAGE_DIFF_CHAR_BUDGET)}\n… (diff truncated)`
        : diff;
    const userPrompt = [extraContext?.trim(), `Diff:\n${truncatedDiff || '(no diff available)'}`]
      .filter(Boolean)
      .join('\n\n');

    try {
      return await this.callCommitMessage(client, model, userPrompt, true);
    } catch (err) {
      if (isUnsupportedReasoningEffortError(err)) {
        this.logger.info(`Model "${model}" does not support reasoning_effort; retrying without it.`);
        try {
          return await this.callCommitMessage(client, model, userPrompt, false);
        } catch (retryErr) {
          this.logger.error('Groq commit message call failed (retry without reasoning_effort)', retryErr);
          return { errorMessage: describeError(retryErr, model) };
        }
      }
      this.logger.error('Groq commit message call failed', err);
      return { errorMessage: describeError(err, model) };
    }
  }

  private async callCommitMessage(
    client: Groq,
    model: string,
    userPrompt: string,
    withReasoningEffort: boolean
  ): Promise<CommitMessageResult> {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: COMMIT_MESSAGE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.4,
      max_completion_tokens: COMMIT_MESSAGE_MAX_COMPLETION_TOKENS,
      top_p: 0.95,
      stream: false,
      ...(withReasoningEffort ? { reasoning_effort: 'none' as const } : {})
    });

    const content = (completion.choices[0]?.message?.content ?? '').trim();
    if (!content) {
      return { errorMessage: 'Groq returned an empty commit message.' };
    }
    return { message: cleanCommitMessage(content) };
  }
}

/** Strips a wrapping markdown code fence or quote layer some models add despite instructions not to. */
export function cleanCommitMessage(text: string): string {
  let result = text.trim();
  const fenceMatch = /^```(?:\w+)?\n([\s\S]*?)\n?```$/.exec(result);
  if (fenceMatch?.[1] !== undefined) {
    result = fenceMatch[1].trim();
  }
  if ((result.startsWith('"') && result.endsWith('"')) || (result.startsWith("'") && result.endsWith("'"))) {
    result = result.slice(1, -1).trim();
  }
  return result;
}

function buildUserPrompt(inputs: AiWorkItemInput[]): string {
  return inputs
    .map((input, index) => {
      const diff = input.diff.trim() || '(no diff available)';
      return `### Commit ${index + 1}\nMessage: ${input.commitMessage}\nDiff:\n${diff}`;
    })
    .join('\n\n');
}

export function isUnsupportedReasoningEffortError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('reasoning_effort');
}

/** Turns an SDK error into a short, specific, user-facing reason instead of a generic failure message. */
export function describeError(err: unknown, model: string): string {
  if (err instanceof AuthenticationError) {
    return 'Groq rejected the API key (401 Unauthorized). Run "Set Groq API Key" to re-enter it.';
  }
  if (err instanceof RateLimitError) {
    return 'Groq rate limit reached (429). Wait a moment and try again.';
  }
  if (err instanceof NotFoundError) {
    return `Model "${model}" was not found on Groq (404). Check the "aiModel" setting.`;
  }
  if (err instanceof PermissionDeniedError) {
    return 'Groq denied access with this API key (403). Check your account/key permissions.';
  }
  if (err instanceof APIConnectionTimeoutError) {
    return 'The request to Groq timed out. Check your internet connection and try again.';
  }
  if (err instanceof APIConnectionError) {
    return "Could not reach Groq's API. Check your internet connection or firewall (api.groq.com must be reachable).";
  }
  if (err instanceof APIError) {
    const detail = extractApiErrorMessage(err) ?? err.message;
    return `Groq API error (${err.status ?? 'unknown status'}): ${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function extractApiErrorMessage(err: APIError): string | undefined {
  const body = err.error as { message?: unknown } | null | undefined;
  if (body && typeof body === 'object' && typeof body.message === 'string') {
    return body.message;
  }
  return undefined;
}

export function parseWorkItems(content: string, expectedCount: number): AiWorkItemOutput[] | undefined {
  const jsonText = extractJsonObject(content);
  if (!jsonText) {
    return undefined;
  }

  try {
    const data = JSON.parse(jsonText) as { items?: unknown };
    if (!Array.isArray(data.items)) {
      return undefined;
    }

    const results: AiWorkItemOutput[] = data.items.map((raw) => {
      const item = raw as { title?: unknown; description?: unknown };
      const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : 'Work update';
      const description = typeof item.description === 'string' ? item.description.trim() : '';
      return { title, description };
    });

    while (results.length < expectedCount) {
      results.push({ title: 'Work update', description: '' });
    }
    return results.slice(0, expectedCount);
  } catch {
    return undefined;
  }
}

/** Extracts the outermost `{...}` object from text that may have stray prose/markdown fences around it. */
export function extractJsonObject(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return trimmed.slice(start, end + 1);
}
