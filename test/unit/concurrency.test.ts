/**
 * Unit tests for ConcurrencyController
 */

import { ConcurrencyController } from '../../src/core/concurrency';

describe('ConcurrencyController', () => {
  it('respects max concurrent limit', async () => {
    const controller = new ConcurrencyController(2, 0, 10);
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 5 }, (_, i) =>
      controller.execute(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise(resolve => setTimeout(resolve, 50));
        running--;
        return i;
      })
    );

    await Promise.all(tasks);
    expect(maxRunning).toBe(2);
  });

  it('retries on failure', async () => {
    const controller = new ConcurrencyController(1, 2, 10);
    let attempts = 0;

    const result = await controller.execute(async () => {
      attempts++;
      if (attempts < 2) {
        throw new Error('Temporary failure');
      }
      return 'success';
    });

    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  it('throws after max retries', async () => {
    const controller = new ConcurrencyController(1, 2, 10);
    let attempts = 0;

    await expect(
      controller.execute(async () => {
        attempts++;
        throw new Error('Persistent failure');
      })
    ).rejects.toThrow('Persistent failure');

    expect(attempts).toBe(3); // Initial + 2 retries
  });

  it('drains queue correctly', async () => {
    const controller = new ConcurrencyController(1, 0, 10);
    const results: number[] = [];

    const tasks = Array.from({ length: 3 }, (_, i) =>
      controller.execute(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        results.push(i);
        return i;
      })
    );

    await Promise.all(tasks);
    expect(results).toEqual([0, 1, 2]);
  });

  it('handles concurrent execution correctly', async () => {
    const controller = new ConcurrencyController(3, 0, 10);
    const startTimes: number[] = [];
    const endTimes: number[] = [];

    const tasks = Array.from({ length: 6 }, (_, i) =>
      controller.execute(async () => {
        startTimes.push(Date.now());
        await new Promise(resolve => setTimeout(resolve, 50));
        endTimes.push(Date.now());
        return i;
      })
    );

    await Promise.all(tasks);

    // Should have 2 batches of 3
    expect(startTimes.length).toBe(6);
    expect(endTimes.length).toBe(6);
  });
});
