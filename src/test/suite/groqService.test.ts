import * as assert from 'assert';
import {
  AuthenticationError,
  RateLimitError,
  NotFoundError,
  PermissionDeniedError,
  APIConnectionError,
  APIConnectionTimeoutError,
  BadRequestError
} from 'groq-sdk';
import {
  GROQ_RATE_LIMITS,
  cleanCommitMessage,
  computeTokenBudget,
  describeError,
  extractJsonObject,
  getMaxCommitsForTokenBudget,
  isUnsupportedReasoningEffortError,
  parseWorkItems
} from '../../services/GroqService';

describe('GroqService.extractJsonObject', () => {
  it('returns clean JSON as-is', () => {
    assert.strictEqual(extractJsonObject('{"items":[]}'), '{"items":[]}');
  });

  it('extracts JSON wrapped in a markdown code fence', () => {
    const wrapped = '```json\n{"items":[{"title":"x","description":"y"}]}\n```';
    assert.strictEqual(extractJsonObject(wrapped), '{"items":[{"title":"x","description":"y"}]}');
  });

  it('extracts JSON preceded by stray prose', () => {
    const wrapped = 'Sure, here is the JSON:\n{"items":[]}\nHope that helps!';
    assert.strictEqual(extractJsonObject(wrapped), '{"items":[]}');
  });

  it('returns undefined when no braces are present', () => {
    assert.strictEqual(extractJsonObject('no json here'), undefined);
  });
});

describe('GroqService.parseWorkItems', () => {
  it('parses a well-formed response matching the expected count', () => {
    const content = JSON.stringify({
      items: [
        { title: 'Fixed invoice rounding', description: 'Rounds totals to two decimals.' },
        { title: 'Added login throttling', description: 'Rate-limits repeated login attempts.' }
      ]
    });
    const result = parseWorkItems(content, 2);
    assert.strictEqual(result?.length, 2);
    assert.strictEqual(result?.[0]?.title, 'Fixed invoice rounding');
    assert.strictEqual(result?.[1]?.description, 'Rate-limits repeated login attempts.');
  });

  it('pads with a fallback item when the model returns fewer items than expected', () => {
    const content = JSON.stringify({ items: [{ title: 'Only one', description: 'desc' }] });
    const result = parseWorkItems(content, 3);
    assert.strictEqual(result?.length, 3);
    assert.strictEqual(result?.[1]?.title, 'Work update');
  });

  it('truncates when the model returns more items than expected', () => {
    const content = JSON.stringify({
      items: [
        { title: 'a', description: '1' },
        { title: 'b', description: '2' },
        { title: 'c', description: '3' }
      ]
    });
    const result = parseWorkItems(content, 1);
    assert.strictEqual(result?.length, 1);
    assert.strictEqual(result?.[0]?.title, 'a');
  });

  it('falls back to "Work update" for a missing/blank title', () => {
    const content = JSON.stringify({ items: [{ description: 'desc only' }] });
    const result = parseWorkItems(content, 1);
    assert.strictEqual(result?.[0]?.title, 'Work update');
  });

  it('returns undefined for non-JSON content', () => {
    assert.strictEqual(parseWorkItems('I cannot help with that.', 2), undefined);
  });

  it('returns undefined when "items" is missing or not an array', () => {
    assert.strictEqual(parseWorkItems('{"result": "ok"}', 1), undefined);
  });
});

describe('GroqService.isUnsupportedReasoningEffortError', () => {
  it('detects the Groq 400 error mentioning reasoning_effort', () => {
    const err = new Error('400 {"error":{"message":"`reasoning_effort` is not supported with this model"}}');
    assert.strictEqual(isUnsupportedReasoningEffortError(err), true);
  });

  it('returns false for unrelated errors', () => {
    assert.strictEqual(isUnsupportedReasoningEffortError(new Error('network timeout')), false);
  });
});

describe('GroqService.describeError', () => {
  it('gives specific, actionable guidance for an invalid API key (401)', () => {
    const err = new AuthenticationError(401, { message: 'Invalid API Key' }, 'Invalid API Key', new Headers());
    const message = describeError(err, 'qwen/qwen3-32b');
    assert.match(message, /API key/i);
    assert.match(message, /Set Groq API Key/);
  });

  it('gives specific guidance for a rate limit (429)', () => {
    const err = new RateLimitError(429, { message: 'rate limit exceeded' }, 'rate limit exceeded', new Headers());
    assert.match(describeError(err, 'qwen/qwen3-32b'), /rate limit/i);
  });

  it('names the offending model for a 404', () => {
    const err = new NotFoundError(404, { message: 'model not found' }, 'model not found', new Headers());
    assert.match(describeError(err, 'some/bad-model'), /some\/bad-model/);
  });

  it('flags a permission error (403)', () => {
    const err = new PermissionDeniedError(403, { message: 'denied' }, 'denied', new Headers());
    assert.match(describeError(err, 'qwen/qwen3-32b'), /denied|permission/i);
  });

  it('flags a connection timeout distinctly from a generic connection error', () => {
    const timeout = new APIConnectionTimeoutError();
    assert.match(describeError(timeout, 'qwen/qwen3-32b'), /timed out/i);
  });

  it('flags a generic connection failure as a network/firewall issue', () => {
    const connErr = new APIConnectionError({ message: 'fetch failed' });
    assert.match(describeError(connErr, 'qwen/qwen3-32b'), /internet connection|firewall/i);
  });

  it('surfaces the underlying message for other API errors (e.g. 400)', () => {
    const err = new BadRequestError(400, { message: 'context length exceeded' }, 'context length exceeded', new Headers());
    const message = describeError(err, 'qwen/qwen3-32b');
    assert.match(message, /400/);
    assert.match(message, /context length exceeded/);
  });

  it('falls back to the plain error message for non-API errors', () => {
    assert.strictEqual(describeError(new Error('boom'), 'qwen/qwen3-32b'), 'boom');
  });
});

describe('GroqService rate limits and token budgeting', () => {
  it('documents the exact tier limits used to derive the budget', () => {
    assert.strictEqual(GROQ_RATE_LIMITS.requestsPerMinute, 60);
    assert.strictEqual(GROQ_RATE_LIMITS.requestsPerDay, 1000);
    assert.strictEqual(GROQ_RATE_LIMITS.tokensPerMinute, 6000);
    assert.strictEqual(GROQ_RATE_LIMITS.tokensPerDay, 500000);
  });

  it('gives fewer commits a larger per-commit diff budget than many commits', () => {
    const few = computeTokenBudget(1);
    const many = computeTokenBudget(20);
    assert.ok(few.perCommitDiffChars > many.perCommitDiffChars, 'budget per commit should shrink as commit count grows');
  });

  it('scales max_completion_tokens with commit count but never exceeds the SDK ceiling', () => {
    assert.ok(computeTokenBudget(1).maxCompletionTokens < computeTokenBudget(15).maxCompletionTokens);
    assert.ok(computeTokenBudget(50).maxCompletionTokens <= 2048);
  });

  it('always leaves a positive, meaningful diff allowance even at the token-budget ceiling', () => {
    const ceiling = getMaxCommitsForTokenBudget();
    assert.ok(ceiling >= 1);
    const budgetAtCeiling = computeTokenBudget(ceiling);
    assert.ok(budgetAtCeiling.perCommitDiffChars >= 300, 'even the most crowded request should keep a usable diff snippet');
  });

  it('keeps the whole request safely under the tokens-per-minute limit for a realistic commit count', () => {
    const commitCount = 10;
    const budget = computeTokenBudget(commitCount);
    const estimatedPromptTokens = (budget.perCommitDiffChars * commitCount) / 3.5;
    const estimatedTotal = estimatedPromptTokens + budget.maxCompletionTokens + 150; // + system prompt estimate
    assert.ok(
      estimatedTotal < GROQ_RATE_LIMITS.tokensPerMinute,
      `estimated ${estimatedTotal} tokens should stay under the ${GROQ_RATE_LIMITS.tokensPerMinute} TPM limit`
    );
  });
});

describe('GroqService.cleanCommitMessage', () => {
  it('leaves a clean subject line untouched', () => {
    assert.strictEqual(cleanCommitMessage('Fix invoice rounding bug'), 'Fix invoice rounding bug');
  });

  it('strips a wrapping markdown code fence', () => {
    const wrapped = '```\nFix invoice rounding bug\n```';
    assert.strictEqual(cleanCommitMessage(wrapped), 'Fix invoice rounding bug');
  });

  it('strips a wrapping language-tagged code fence', () => {
    const wrapped = '```text\nFix invoice rounding bug\n```';
    assert.strictEqual(cleanCommitMessage(wrapped), 'Fix invoice rounding bug');
  });

  it('strips a single layer of wrapping double quotes', () => {
    assert.strictEqual(cleanCommitMessage('"Fix invoice rounding bug"'), 'Fix invoice rounding bug');
  });

  it('preserves a multi-line message with bullet points', () => {
    const message = 'Refactor payment module\n\n- Extract validation logic\n- Simplify error handling';
    assert.strictEqual(cleanCommitMessage(message), message);
  });

  it('trims surrounding whitespace', () => {
    assert.strictEqual(cleanCommitMessage('  Fix bug  \n'), 'Fix bug');
  });
});
