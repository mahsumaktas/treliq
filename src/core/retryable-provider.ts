import type { LLMProvider } from './provider';
import { createLogger } from './logger';

const log = createLogger('retryable-provider');

const NON_RETRYABLE = new Set([400, 401, 403, 404, 422]);

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  onThrottle?: () => void;
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

  get generateEmbeddingBatch(): ((texts: string[]) => Promise<number[][]>) | undefined {
    const inner = this.inner as any;
    if (typeof inner.generateEmbeddingBatch !== 'function') return undefined;
    return (texts: string[]) => this.withRetry(() => inner.generateEmbeddingBatch(texts), 'generateEmbeddingBatch');
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
          const retryAfter = err.retryAfter;
          if (typeof retryAfter === 'number' && retryAfter < 1) {
            delay = retryAfter * 1000;
          } else if (typeof retryAfter === 'number') {
            delay = retryAfter * 1000;
          } else {
            delay = this.baseDelay * Math.pow(2, attempt);
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
