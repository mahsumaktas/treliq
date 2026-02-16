/**
 * ConcurrencyController — Limit parallel async operations with retry support
 */

export class ConcurrencyController {
  private maxConcurrent: number;
  private retryAttempts: number;
  private retryDelay: number;
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(maxConcurrent = 5, retryAttempts = 2, retryDelay = 1000) {
    this.maxConcurrent = maxConcurrent;
    this.retryAttempts = retryAttempts;
    this.retryDelay = retryDelay;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await this.withRetry(fn);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  private release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt <= this.retryAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt === this.retryAttempts) throw err;
        await new Promise(r => setTimeout(r, this.retryDelay * (attempt + 1)));
      }
    }
    throw new Error('Max retries exceeded');
  }
}
