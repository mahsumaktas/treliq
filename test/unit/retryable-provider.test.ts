import { RetryableProvider } from '../../src/core/retryable-provider';
import { MockLLMProvider } from '../fixtures/mock-provider';

describe('RetryableProvider', () => {
  let mock: MockLLMProvider;

  beforeEach(() => {
    mock = new MockLLMProvider();
    // Speed up tests by making setTimeout instant
    jest.spyOn(global, 'setTimeout').mockImplementation(((cb: any) => {
      if (typeof cb === 'function') cb();
      return 0 as any;
    }) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

  it('respects 429 status and retries', async () => {
    let calls = 0;
    mock.generateTextResponse = () => {
      calls++;
      if (calls === 1) {
        const err = new Error('429') as any;
        err.status = 429;
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

  it('exposes name from inner provider', () => {
    const provider = new RetryableProvider(mock);
    expect(provider.name).toBe('mock');
  });

  it('delegates generateEmbeddingBatch when inner supports it', async () => {
    (mock as any).generateEmbeddingBatch = jest.fn().mockResolvedValue([[0.1], [0.2]]);
    const provider = new RetryableProvider(mock);
    const batchFn = provider.generateEmbeddingBatch;
    expect(batchFn).toBeDefined();
    const result = await batchFn!(['a', 'b']);
    expect(result).toEqual([[0.1], [0.2]]);
  });

  it('returns undefined for generateEmbeddingBatch when inner does not support it', () => {
    const provider = new RetryableProvider(mock);
    expect(provider.generateEmbeddingBatch).toBeUndefined();
  });

  it('calls onThrottle on 429', async () => {
    let throttleCount = 0;
    const onThrottle = () => { throttleCount++; };
    let calls = 0;
    mock.generateTextResponse = () => {
      calls++;
      if (calls <= 2) {
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
    expect(throttleCount).toBe(2);
  });
});
