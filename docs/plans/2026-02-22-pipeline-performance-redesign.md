# Pipeline Performance Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 3000 PR scan suresini ~140dk'dan ~15-20dk'ya dusurmek (7-9x hiz) via streaming pipeline, parallel stages, provider retry, expanded cache, and batch embeddings.

**Architecture:** Mevcut sirasal `fetch ALL -> score ALL -> embed ALL -> vision ALL` akisi, her asamanin kendi concurrency havuzuyla bagimsiz calistigi streaming pipeline'a donusturulecek. PR fetch edilir edilmez scoring'e, scoring biter bitmez embed + vision paralel girecek. Cache, embedding ve vision sonuclarini da saklayacak.

**Tech Stack:** TypeScript, existing ConcurrencyController (extended), existing LLMProvider interface (extended with batch + retry wrapper)

---

## Task 1: RetryableProvider Wrapper

Tum LLM cagrilarini sarmalayan retry + adaptive pacing katmani.

**Files:**
- Create: `src/core/retryable-provider.ts`
- Test: `test/unit/retryable-provider.test.ts`
- Modify: `src/core/provider.ts:5` (remove `sleep(100)` from all providers)

**Step 1: Write the failing test**

```typescript
// test/unit/retryable-provider.test.ts
import { RetryableProvider } from '../../src/core/retryable-provider';
import { MockLLMProvider } from '../fixtures/mock-provider';

describe('RetryableProvider', () => {
  let mock: MockLLMProvider;

  beforeEach(() => {
    mock = new MockLLMProvider();
  });

  it('delegates generateText to inner provider', async () => {
    const provider = new RetryableProvider(mock);
    const result = await provider.generateText('hello');
    expect(result).toBe('{"score": 75, "risk": "low", "reason": "Mock LLM response"}');
    expect(mock.generateTextCalls).toHaveLength(1);
  });

  it('delegates generateEmbedding to inner provider', async () => {
    const provider = new RetryableProvider(mock);
    const result = await provider.generateEmbedding('hello');
    expect(result).toHaveLength(768);
  });

  it('retries on transient error and succeeds', async () => {
    let calls = 0;
    mock.generateTextResponse = () => {
      calls++;
      if (calls < 2) throw new Error('temporary');
      return '{"score": 80}';
    };
    const provider = new RetryableProvider(mock, { maxRetries: 3, baseDelay: 10 });
    const result = await provider.generateText('test');
    expect(result).toBe('{"score": 80}');
    expect(calls).toBe(2);
  });

  it('throws after max retries exhausted', async () => {
    mock.generateTextResponse = () => { throw new Error('persistent'); };
    const provider = new RetryableProvider(mock, { maxRetries: 2, baseDelay: 10 });
    await expect(provider.generateText('test')).rejects.toThrow('persistent');
  });

  it('respects Retry-After header simulation (429)', async () => {
    let calls = 0;
    mock.generateTextResponse = () => {
      calls++;
      if (calls === 1) {
        const err = new Error('429') as any;
        err.status = 429;
        err.retryAfter = 0.01; // 10ms for test speed
        throw err;
      }
      return '{"score": 90}';
    };
    const provider = new RetryableProvider(mock, { maxRetries: 3, baseDelay: 10 });
    const result = await provider.generateText('test');
    expect(result).toBe('{"score": 90}');
    expect(calls).toBe(2);
  });

  it('does not retry on 400/401 errors', async () => {
    mock.generateTextResponse = () => {
      const err = new Error('Bad Request') as any;
      err.status = 400;
      throw err;
    };
    const provider = new RetryableProvider(mock, { maxRetries: 3, baseDelay: 10 });
    await expect(provider.generateText('test')).rejects.toThrow('Bad Request');
    expect(mock.generateTextCalls).toHaveLength(1);
  });

  it('exposes name and supportsEmbeddings from inner provider', () => {
    const provider = new RetryableProvider(mock);
    expect(provider.name).toBe('mock');
  });

  it('delegates generateEmbeddingBatch to inner if supported', async () => {
    (mock as any).generateEmbeddingBatch = jest.fn().mockResolvedValue([[0.1], [0.2]]);
    const provider = new RetryableProvider(mock);
    const result = await provider.generateEmbeddingBatch!(['a', 'b']);
    expect(result).toEqual([[0.1], [0.2]]);
  });

  it('tracks throttle events', async () => {
    let throttleCount = 0;
    const onThrottle = () => { throttleCount++; };
    let calls = 0;
    mock.generateTextResponse = () => {
      calls++;
      if (calls <= 3) {
        const err = new Error('429') as any;
        err.status = 429;
        throw err;
      }
      return 'ok';
    };
    const provider = new RetryableProvider(mock, {
      maxRetries: 5, baseDelay: 10, onThrottle,
    });
    await provider.generateText('test');
    expect(throttleCount).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/retryable-provider.test.ts --no-coverage`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/core/retryable-provider.ts
import type { LLMProvider } from './provider';
import { createLogger } from './logger';

const log = createLogger('retryable-provider');

/** HTTP status codes that should NOT be retried */
const NON_RETRYABLE = new Set([400, 401, 403, 404, 422]);

export interface RetryOptions {
  maxRetries?: number;    // Default: 3
  baseDelay?: number;     // Default: 1000ms
  maxDelay?: number;      // Default: 30000ms
  onThrottle?: () => void;  // Called when 429 detected
}

export class RetryableProvider implements LLMProvider {
  get name() { return this.inner.name; }
  get supportsEmbeddings() { return this.inner.supportsEmbeddings; }

  private inner: LLMProvider;
  private maxRetries: number;
  private baseDelay: number;
  private maxDelay: number;
  private onThrottle?: () => void;

  constructor(inner: LLMProvider, opts: RetryOptions = {}) {
    this.inner = inner;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseDelay = opts.baseDelay ?? 1000;
    this.maxDelay = opts.maxDelay ?? 30000;
    this.onThrottle = opts.onThrottle;
  }

  async generateText(prompt: string, options?: { temperature?: number; maxTokens?: number }): Promise<string> {
    return this.withRetry(() => this.inner.generateText(prompt, options), 'generateText');
  }

  async generateEmbedding(text: string): Promise<number[]> {
    return this.withRetry(() => this.inner.generateEmbedding(text), 'generateEmbedding');
  }

  async generateEmbeddingBatch?(texts: string[]): Promise<number[][]> {
    const fn = (this.inner as any).generateEmbeddingBatch;
    if (typeof fn !== 'function') return undefined as any;
    return this.withRetry(() => fn.call(this.inner, texts), 'generateEmbeddingBatch');
  }

  private async withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const status = err.status ?? this.extractStatus(err.message);

        if (NON_RETRYABLE.has(status)) throw err;

        if (attempt === this.maxRetries) throw err;

        let delay: number;
        if (status === 429) {
          this.onThrottle?.();
          delay = (err.retryAfter ?? this.baseDelay * Math.pow(2, attempt)) * 1000;
          if (typeof err.retryAfter === 'number' && err.retryAfter < 1) {
            delay = err.retryAfter * 1000;
          }
          log.warn({ attempt, delay, label }, 'Rate limited (429), backing off');
        } else {
          delay = this.baseDelay * Math.pow(2, attempt);
          log.warn({ attempt, delay, label, err: err.message }, 'Retrying after error');
        }

        delay = Math.min(delay, this.maxDelay);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error('Unreachable');
  }

  private extractStatus(message: string): number | undefined {
    const match = message?.match?.(/\b(4\d{2}|5\d{2})\b/);
    return match ? parseInt(match[1]) : undefined;
  }
}
```

**Step 4: Remove 100ms sleep from all providers**

In `src/core/provider.ts`, remove the `sleep` function and all `await sleep(100)` calls (lines 5, 40, 59, 87, 107, 143, 185). The sleep function definition and all 6 call sites should be deleted.

**Step 5: Run tests**

Run: `npx jest test/unit/retryable-provider.test.ts test/unit/provider.test.ts --no-coverage`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/core/retryable-provider.ts test/unit/retryable-provider.test.ts src/core/provider.ts
git commit -m "feat: add RetryableProvider wrapper with retry + adaptive backoff"
```

---

## Task 2: Adaptive ConcurrencyController

Mevcut ConcurrencyController'a runtime'da concurrency artirma/azaltma yetenegini ekle.

**Files:**
- Modify: `src/core/concurrency.ts`
- Modify: `test/unit/concurrency.test.ts`

**Step 1: Write the failing tests**

Append to `test/unit/concurrency.test.ts`:

```typescript
describe('Adaptive concurrency', () => {
  it('reduces concurrency via throttle()', async () => {
    const controller = new ConcurrencyController(10, 0, 10);
    expect(controller.getMaxConcurrent()).toBe(10);

    controller.throttle();
    expect(controller.getMaxConcurrent()).toBe(5);

    controller.throttle();
    expect(controller.getMaxConcurrent()).toBe(3); // floor(5/2) = 2, min=2 -> 3
  });

  it('increases concurrency via recover()', async () => {
    const controller = new ConcurrencyController(4, 0, 10);
    controller.throttle(); // -> 2
    expect(controller.getMaxConcurrent()).toBe(2);

    controller.recover();
    expect(controller.getMaxConcurrent()).toBe(3);

    controller.recover();
    expect(controller.getMaxConcurrent()).toBe(4); // cap at initial
  });

  it('does not exceed initial maxConcurrent on recover', () => {
    const controller = new ConcurrencyController(5, 0, 10);
    controller.recover();
    controller.recover();
    expect(controller.getMaxConcurrent()).toBe(5); // stays at initial
  });

  it('does not go below minimum (2) on throttle', () => {
    const controller = new ConcurrencyController(2, 0, 10);
    controller.throttle();
    expect(controller.getMaxConcurrent()).toBe(2); // min floor
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/concurrency.test.ts --no-coverage`
Expected: FAIL — getMaxConcurrent/throttle/recover not found

**Step 3: Add adaptive methods to ConcurrencyController**

In `src/core/concurrency.ts`, add:

```typescript
// Add field:
private initialMax: number;

// In constructor, store:
this.initialMax = maxConcurrent;

// New methods:
getMaxConcurrent(): number {
  return this.maxConcurrent;
}

/** Reduce concurrency by half (min 2) — call on repeated 429s */
throttle(): void {
  this.maxConcurrent = Math.max(2, Math.floor(this.maxConcurrent / 2));
}

/** Increase concurrency by 1 (up to initial) — call on sustained success */
recover(): void {
  this.maxConcurrent = Math.min(this.initialMax, this.maxConcurrent + 1);
}
```

**Step 4: Run tests**

Run: `npx jest test/unit/concurrency.test.ts --no-coverage`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/core/concurrency.ts test/unit/concurrency.test.ts
git commit -m "feat: add adaptive throttle/recover to ConcurrencyController"
```

---

## Task 3: Expand Cache with Embedding + Vision

Cache'i embedding ve vision sonuclarini da saklayacak sekilde genislet.

**Files:**
- Modify: `src/core/cache.ts`
- Modify: `test/unit/cache.test.ts`

**Step 1: Write the failing tests**

Append to `test/unit/cache.test.ts`:

```typescript
describe('expanded cache (embedding + vision)', () => {
  it('saves and restores embedding data', () => {
    const scoredPR = createScoredPR({
      number: 1,
      updatedAt: '2024-01-01T00:00:00Z',
      embedding: [0.1, 0.2, 0.3],
    });
    const shaMap = new Map([[1, 'sha1']]);

    saveCache(testCacheFile, 'owner/repo', scoredPR, shaMap, 'hash1');
    const cache = loadCache(testCacheFile, 'owner/repo', 'hash1');
    const item: PRListItem = { number: 1, updatedAt: '2024-01-01T00:00:00Z', headSha: 'sha1' };
    const hit = getCacheHit(cache!, item);

    expect(hit?.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('saves and restores vision data', () => {
    const scoredPR = createScoredPR({
      number: 1,
      updatedAt: '2024-01-01T00:00:00Z',
      visionAlignment: 'aligned',
      visionScore: 88,
      visionReason: 'Matches roadmap',
    });
    const shaMap = new Map([[1, 'sha1']]);

    saveCache(testCacheFile, 'owner/repo', [scoredPR], shaMap, 'hash1');
    const cache = loadCache(testCacheFile, 'owner/repo', 'hash1');
    const item: PRListItem = { number: 1, updatedAt: '2024-01-01T00:00:00Z', headSha: 'sha1' };
    const hit = getCacheHit(cache!, item);

    expect(hit?.visionAlignment).toBe('aligned');
    expect(hit?.visionScore).toBe(88);
    expect(hit?.visionReason).toBe('Matches roadmap');
  });

  it('is backwards compatible with old cache format (no embedding/vision)', () => {
    // Write old-format cache manually (without embedding)
    const oldCache = {
      repo: 'owner/repo',
      lastScan: '2024-01-01T00:00:00Z',
      configHash: 'hash1',
      prs: {
        '1': {
          updatedAt: '2024-01-01T00:00:00Z',
          headSha: 'sha1',
          scoredPR: createScoredPR({ number: 1, updatedAt: '2024-01-01T00:00:00Z' }),
        },
      },
    };
    writeFileSync(testCacheFile, JSON.stringify(oldCache));

    const cache = loadCache(testCacheFile, 'owner/repo', 'hash1');
    const item: PRListItem = { number: 1, updatedAt: '2024-01-01T00:00:00Z', headSha: 'sha1' };
    const hit = getCacheHit(cache!, item);

    expect(hit).not.toBeNull();
    expect(hit?.embedding).toBeUndefined();
    expect(hit?.visionAlignment).toBeDefined(); // from createScoredPR default
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/cache.test.ts --no-coverage`
Expected: FAIL — embedding not in cache hit

**Step 3: Modify cache.ts**

Change `CachedPR` interface to include embedding and vision:

```typescript
export interface CachedPR {
  updatedAt: string;
  headSha: string;
  scoredPR: ScoredPR; // Changed: no longer Omit<ScoredPR, 'embedding'>
}
```

In `saveCache`, stop stripping embedding:

```typescript
// OLD:
const { embedding, ...rest } = pr;
cache.prs[String(pr.number)] = {
  updatedAt: pr.updatedAt,
  headSha: shaMap.get(pr.number) ?? '',
  scoredPR: rest,
};

// NEW:
cache.prs[String(pr.number)] = {
  updatedAt: pr.updatedAt,
  headSha: shaMap.get(pr.number) ?? '',
  scoredPR: pr,
};
```

Note: This means the cache file grows larger (embeddings are 768-dimensional arrays). For 3000 PRs, this adds ~15MB to cache file. Acceptable trade-off for 120+ min savings on incremental scans.

**Step 4: Run tests**

Run: `npx jest test/unit/cache.test.ts --no-coverage`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/core/cache.ts test/unit/cache.test.ts
git commit -m "feat: expand cache to store embedding + vision results"
```

---

## Task 4: Batch Embedding Support

LLMProvider interface'ine opsiyonel `generateEmbeddingBatch` ekle. Gemini ve OpenAI icin implement et.

**Files:**
- Modify: `src/core/provider.ts`
- Modify: `test/unit/provider.test.ts`
- Modify: `test/fixtures/mock-provider.ts`

**Step 1: Write the failing tests**

Append to `test/unit/provider.test.ts`:

```typescript
describe('batch embedding', () => {
  it('GeminiProvider batch embeds multiple texts', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchResponse({
      embeddings: [
        { values: [0.1, 0.2] },
        { values: [0.3, 0.4] },
      ],
    }));

    const provider = new GeminiProvider('gemini-key');
    const result = await provider.generateEmbeddingBatch(['text1', 'text2']);

    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });

  it('OpenAIProvider batch embeds multiple texts', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchResponse({
      data: [
        { embedding: [0.5, 0.6] },
        { embedding: [0.7, 0.8] },
      ],
    }));

    const provider = new OpenAIProvider('openai-key');
    const result = await provider.generateEmbeddingBatch(['text1', 'text2']);

    expect(result).toEqual([[0.5, 0.6], [0.7, 0.8]]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/provider.test.ts --no-coverage`
Expected: FAIL — generateEmbeddingBatch not found

**Step 3: Add batch embedding to LLMProvider interface and implementations**

In `src/core/provider.ts`, add to `LLMProvider` interface:

```typescript
generateEmbeddingBatch?(texts: string[]): Promise<number[][]>;
```

Add to `GeminiProvider`:

```typescript
async generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
    body: JSON.stringify({
      requests: texts.map(text => ({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text }] },
      })),
    }),
  });
  if (!res.ok) throw new Error(`Gemini Batch Embedding ${res.status}`);
  const data = await res.json() as { embeddings: Array<{ values: number[] }> };
  return data.embeddings.map(e => e.values);
}
```

Add to `OpenAIProvider`:

```typescript
async generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: texts,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI Batch Embedding ${res.status}`);
  const data = await res.json() as { data: Array<{ embedding: number[] }> };
  return data.data.map(d => d.embedding);
}
```

**Step 4: Add batch to MockLLMProvider**

In `test/fixtures/mock-provider.ts`, add:

```typescript
generateEmbeddingBatchResponse: number[][] | ((texts: string[]) => number[][] | Promise<number[][]>) | null = null;

async generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
  if (this.generateEmbeddingBatchResponse) {
    if (typeof this.generateEmbeddingBatchResponse === 'function') {
      return await this.generateEmbeddingBatchResponse(texts);
    }
    return this.generateEmbeddingBatchResponse;
  }
  // Fallback: call generateEmbedding individually
  return Promise.all(texts.map(t => this.generateEmbedding(t)));
}
```

**Step 5: Run tests**

Run: `npx jest test/unit/provider.test.ts --no-coverage`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/core/provider.ts test/unit/provider.test.ts test/fixtures/mock-provider.ts
git commit -m "feat: add batch embedding to Gemini + OpenAI providers"
```

---

## Task 5: Parallel DedupEngine with Batch Support

DedupEngine'i ConcurrencyController ile paralel calisacak ve batch embedding kullanacak sekilde guncelle.

**Files:**
- Modify: `src/core/dedup.ts`
- Modify: `test/unit/dedup.test.ts`

**Step 1: Write the failing tests**

Append to `test/unit/dedup.test.ts`:

```typescript
it('uses batch embedding when provider supports it', async () => {
  const batchFn = jest.fn().mockResolvedValue([
    [1, 0, 0],
    [0.99, 0.01, 0],
    [0, 1, 0],
  ]);
  const provider: LLMProvider = {
    name: 'mock-batch',
    generateText: jest.fn(),
    generateEmbedding: jest.fn(),
    generateEmbeddingBatch: batchFn,
  } as any;

  const pr1 = createScoredPR({ number: 10, title: 'fix login bug', totalScore: 65 });
  const pr2 = createScoredPR({ number: 11, title: 'auth fix', totalScore: 92 });
  const pr3 = createScoredPR({ number: 12, title: 'docs update', totalScore: 70 });

  const engine = new DedupEngine(0.85, 0.8, provider);
  const clusters = await engine.findDuplicates([pr1, pr2, pr3]);

  expect(batchFn).toHaveBeenCalledTimes(1);
  expect(provider.generateEmbedding).not.toHaveBeenCalled();
  expect(clusters.length).toBe(1);
});

it('falls back to parallel individual embedding when batch not supported', async () => {
  const provider: LLMProvider = {
    name: 'mock-no-batch',
    generateText: jest.fn(),
    generateEmbedding: jest.fn().mockImplementation(async (text: string) => {
      if (text.includes('login')) return [1, 0, 0];
      return [0, 1, 0];
    }),
  };

  const pr1 = createScoredPR({ number: 10, title: 'fix login bug', totalScore: 65 });
  const pr2 = createScoredPR({ number: 12, title: 'docs update', totalScore: 70 });

  const engine = new DedupEngine(0.85, 0.8, provider);
  await engine.findDuplicates([pr1, pr2]);

  expect(provider.generateEmbedding).toHaveBeenCalledTimes(2);
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/dedup.test.ts --no-coverage`
Expected: FAIL — batch not used

**Step 3: Rewrite DedupEngine embedding phase**

In `src/core/dedup.ts`, replace the sequential embedding loop with:

```typescript
import { ConcurrencyController } from './concurrency';

// In findDuplicates:
// 1. Try batch embedding first
if (typeof (this.provider as any).generateEmbeddingBatch === 'function') {
  log.info({ count: prs.length }, 'Using batch embedding');
  const BATCH_SIZE = 100;
  for (let i = 0; i < prs.length; i += BATCH_SIZE) {
    const batch = prs.slice(i, i + BATCH_SIZE);
    const texts = batch.map(pr => this.prToText(pr));
    try {
      const results = await (this.provider as any).generateEmbeddingBatch(texts);
      for (let j = 0; j < batch.length; j++) {
        batch[j].embedding = results[j];
        embeddings.set(batch[j].number, results[j]);
      }
    } catch (err: any) {
      log.warn({ batch: i, err }, 'Batch embedding failed, falling back to parallel');
      // Fall through to parallel individual below
      break;
    }
  }
}

// 2. For PRs without embedding (batch failed or no batch support): parallel individual
const remaining = prs.filter(p => !p.embedding);
if (remaining.length > 0) {
  const cc = new ConcurrencyController(15, 2, 500);
  const results = await Promise.allSettled(
    remaining.map(pr => cc.execute(async () => {
      const text = this.prToText(pr);
      const embedding = await this.embed(text);
      pr.embedding = embedding;
      embeddings.set(pr.number, embedding);
    }))
  );
  let failed = 0;
  for (const r of results) {
    if (r.status === 'rejected') failed++;
  }
  if (failed > 0) log.warn({ failed }, 'Some embeddings failed');
}
```

Remove the 250ms delay and the consecutiveFailures circuit breaker (retry is now handled by RetryableProvider).

**Step 4: Run tests**

Run: `npx jest test/unit/dedup.test.ts --no-coverage`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/core/dedup.ts test/unit/dedup.test.ts
git commit -m "feat: parallel + batch embedding in DedupEngine"
```

---

## Task 6: Parallel VisionChecker

VisionChecker'a `checkMany` metodu ekle, ConcurrencyController ile paralel calistir.

**Files:**
- Modify: `src/core/vision.ts`
- Modify: `test/unit/vision.test.ts`

**Step 1: Write the failing tests**

Append to `test/unit/vision.test.ts`:

```typescript
describe('VisionChecker.checkMany', () => {
  it('checks multiple PRs in parallel', async () => {
    const provider = new MockLLMProvider();
    let callCount = 0;
    provider.generateTextResponse = () => {
      callCount++;
      return `{"score": ${70 + callCount}, "alignment": "aligned", "reason": "reason ${callCount}"}`;
    };
    const checker = new VisionChecker('Focus on developer tooling', provider);

    const prs = [
      createScoredPR({ number: 1 }),
      createScoredPR({ number: 2 }),
      createScoredPR({ number: 3 }),
    ];

    await checker.checkMany(prs);

    expect(prs[0].visionAlignment).toBe('aligned');
    expect(prs[1].visionAlignment).toBe('aligned');
    expect(prs[2].visionAlignment).toBe('aligned');
    expect(callCount).toBe(3);
  });

  it('handles individual failures gracefully', async () => {
    const provider = new MockLLMProvider();
    let callCount = 0;
    provider.generateTextResponse = () => {
      callCount++;
      if (callCount === 2) throw new Error('LLM error');
      return '{"score": 80, "alignment": "aligned", "reason": "ok"}';
    };
    const checker = new VisionChecker('Vision doc', provider);

    const prs = [
      createScoredPR({ number: 1 }),
      createScoredPR({ number: 2 }),
      createScoredPR({ number: 3 }),
    ];

    await checker.checkMany(prs);

    expect(prs[0].visionAlignment).toBe('aligned');
    expect(prs[1].visionAlignment).toBe('unchecked');
    expect(prs[2].visionAlignment).toBe('aligned');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx jest test/unit/vision.test.ts --no-coverage`
Expected: FAIL — checkMany not found

**Step 3: Add checkMany to VisionChecker**

In `src/core/vision.ts`:

```typescript
import { ConcurrencyController } from './concurrency';
import { createLogger } from './logger';

const log = createLogger('vision');

// Add to VisionChecker class:
async checkMany(prs: ScoredPR[], maxConcurrent = 10): Promise<void> {
  const cc = new ConcurrencyController(maxConcurrent, 2, 1000);

  const results = await Promise.allSettled(
    prs.map(pr => cc.execute(async () => {
      const result = await this.check(pr);
      pr.visionAlignment = result.alignment;
      pr.visionScore = result.score;
      pr.visionReason = result.reason;
    }))
  );

  let failed = 0;
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      failed++;
      log.warn({ pr: prs[i].number, err: result.reason }, 'Vision check failed');
      prs[i].visionAlignment = 'unchecked';
    }
  }
  if (failed > 0) log.warn({ failed, total: prs.length }, 'Some vision checks failed');
}
```

**Step 4: Run tests**

Run: `npx jest test/unit/vision.test.ts --no-coverage`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/core/vision.ts test/unit/vision.test.ts
git commit -m "feat: add parallel checkMany to VisionChecker"
```

---

## Task 7: Pipeline Scanner Rewrite

Scanner'i streaming pipeline mimarisine gecir. Her asama kendi concurrency'si ile bagimsiz calisiyor.

**Files:**
- Modify: `src/core/scanner.ts` (scan method rewrite)
- Modify: `test/unit/scanner.test.ts` (if needed to adapt)

**Step 1: Write the failing test**

In `test/unit/scanner.test.ts` (or verify existing tests still cover the pipeline). The key behavior to test:

```typescript
// Append to scanner.test.ts or verify existing coverage:
// The core behavioral contract remains: scan() returns TreliqResult
// with rankedPRs sorted by totalScore desc, spamCount, clusters.
// Implementation detail (pipeline vs sequential) should not change test expectations.
```

Since scanner.test.ts likely mocks external dependencies (Octokit, GraphQL), the existing tests should work with the pipeline rewrite as long as the same inputs produce the same outputs. **No new test needed here** — the rewrite is internal refactoring.

**Step 2: Rewrite scanner.ts scan() method**

Replace the vision section (lines 174-197 of scanner.ts) with `checkMany`:

```typescript
// OLD (lines 174-197):
if (this.config.provider) {
  try {
    log.info('Checking vision alignment');
    const visionDoc = await this.fetchVisionDoc(owner, repo);
    if (visionDoc) {
      const vision = new VisionChecker(visionDoc, this.config.provider);
      for (const pr of scored) {
        try {
          const result = await vision.check(pr);
          pr.visionAlignment = result.alignment;
          pr.visionScore = result.score;
          pr.visionReason = result.reason;
        } catch (err: any) {
          log.warn({ pr: pr.number, err }, 'Vision check failed for PR');
          pr.visionAlignment = 'unchecked';
        }
      }
    } else {
      log.info('No VISION.md or ROADMAP.md found, skipping');
    }
  } catch (err: any) {
    log.warn({ err }, 'Vision check failed (skipping)');
  }
}

// NEW:
if (this.config.provider) {
  try {
    const visionDoc = await this.fetchVisionDoc(owner, repo);
    if (visionDoc) {
      log.info({ count: scored.length }, 'Checking vision alignment (parallel)');
      const vision = new VisionChecker(visionDoc, this.config.provider);
      await vision.checkMany(scored);
    } else {
      log.info('No VISION.md or ROADMAP.md found, skipping');
    }
  } catch (err: any) {
    log.warn({ err }, 'Vision check failed (skipping)');
  }
}
```

Replace the dedup + vision sections to run in parallel:

```typescript
// Run dedup and vision in parallel (they are independent)
const [clusters] = await Promise.all([
  // Dedup
  (async (): Promise<DedupCluster[]> => {
    if (!this.config.provider) {
      log.info('Skipping dedup (no LLM provider)');
      return [];
    }
    try {
      log.info('Finding duplicates via embeddings');
      const dedup = new DedupEngine(
        this.config.duplicateThreshold,
        this.config.relatedThreshold,
        this.config.provider,
      );
      const c = await dedup.findDuplicates(scored);
      log.info({ clusters: c.length }, 'Found duplicate clusters');
      return c;
    } catch (err: any) {
      log.warn({ err }, 'Dedup failed (skipping)');
      return [];
    }
  })(),
  // Vision (parallel with dedup)
  (async () => {
    if (!this.config.provider) return;
    try {
      const visionDoc = await this.fetchVisionDoc(owner, repo);
      if (visionDoc) {
        log.info({ count: scored.length }, 'Checking vision alignment (parallel)');
        const vision = new VisionChecker(visionDoc, this.config.provider);
        await vision.checkMany(scored);
      } else {
        log.info('No VISION.md or ROADMAP.md found, skipping');
      }
    } catch (err: any) {
      log.warn({ err }, 'Vision check failed (skipping)');
    }
  })(),
]);
```

Also update `ScoringEngine` constructor call to use higher concurrency:

```typescript
// In TreliqScanner constructor:
this.scoring = new ScoringEngine(config.provider, config.trustContributors, 10);
```

**Step 3: Update scanner to use cache for embedding + vision**

In the cache-hit path, cached PRs now have embedding and vision data. The dedup engine should skip embedding for PRs that already have embeddings. Check this in `DedupEngine.findDuplicates`:

```typescript
// In embedding phase, skip PRs that already have embeddings from cache:
const needsEmbedding = prs.filter(p => !p.embedding);
const alreadyEmbedded = prs.filter(p => p.embedding);
// Only embed needsEmbedding, then combine
```

For vision, skip PRs that already have `visionAlignment !== 'unchecked'`:

```typescript
// In checkMany or scanner:
const needsVision = scored.filter(p => p.visionAlignment === 'unchecked');
if (needsVision.length < scored.length) {
  log.info({ cached: scored.length - needsVision.length }, 'Skipping cached vision results');
}
await vision.checkMany(needsVision);
```

**Step 4: Wire RetryableProvider in scanner**

In `src/core/scanner.ts`, wrap the provider:

```typescript
import { RetryableProvider } from './retryable-provider';

// In constructor or scan():
const provider = this.config.provider
  ? new RetryableProvider(this.config.provider)
  : undefined;
```

Use this wrapped provider for scoring, dedup, and vision.

**Step 5: Run full test suite**

Run: `npx jest --no-coverage`
Expected: ALL 218+ tests PASS

**Step 6: Commit**

```bash
git add src/core/scanner.ts
git commit -m "feat: pipeline scanner with parallel dedup + vision + retry"
```

---

## Task 8: Integration Testing + Full Suite Verification

Tum degisikliklerin birlikte calistigini dogrula.

**Files:**
- Verify: `test/integration/scoring-engine.test.ts`
- Run: Full test suite

**Step 1: Run build**

Run: `npm run build`
Expected: No TypeScript errors

**Step 2: Run lint**

Run: `npm run lint`
Expected: No lint errors

**Step 3: Run full test suite**

Run: `npm test`
Expected: 218+ tests passing, no regressions

**Step 4: Commit final state**

```bash
git add -A
git commit -m "test: verify pipeline performance redesign passes all tests"
```

---

## Summary: Expected File Changes

| File | Action | Lines Changed (est) |
|------|--------|-------------------|
| `src/core/retryable-provider.ts` | CREATE | ~80 |
| `test/unit/retryable-provider.test.ts` | CREATE | ~100 |
| `src/core/provider.ts` | MODIFY | ~-12 (remove sleep) +30 (batch) |
| `test/unit/provider.test.ts` | MODIFY | +30 (batch tests) |
| `test/fixtures/mock-provider.ts` | MODIFY | +15 (batch mock) |
| `src/core/concurrency.ts` | MODIFY | +20 (adaptive) |
| `test/unit/concurrency.test.ts` | MODIFY | +35 (adaptive tests) |
| `src/core/cache.ts` | MODIFY | ~5 (remove embedding strip) |
| `test/unit/cache.test.ts` | MODIFY | +40 (embedding/vision cache tests) |
| `src/core/dedup.ts` | MODIFY | ~40 (parallel + batch) |
| `test/unit/dedup.test.ts` | MODIFY | +40 (batch/parallel tests) |
| `src/core/vision.ts` | MODIFY | +25 (checkMany) |
| `test/unit/vision.test.ts` | MODIFY | +35 (checkMany tests) |
| `src/core/scanner.ts` | MODIFY | ~30 (pipeline + parallel) |

**Total: ~2 new files, ~12 modified files, ~550 lines changed**
