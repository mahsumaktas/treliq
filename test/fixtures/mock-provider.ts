/**
 * Mock LLM Provider for testing
 */

import type { LLMProvider } from '../../src/core/provider';

/**
 * Helper to create a hybrid CheckEval response (idea + implementation + noveltyBonus).
 * ideaScore = min(100, ideaYes * 8 + noveltyBonus)
 * implementationScore = Math.round((implYes / 5) * 100)
 *
 * Idea score: base 0-80 from binary + 0-20 bonus = fine-grained 0-100
 * Impl score mapping: 0→0, 1→20, 2→40, 3→60, 4→80, 5→100
 */
export function dualChecklistResponse(ideaYes: number, implYes: number, risk = 'low', reason = 'Test', noveltyBonus = 0): string {
  const idea = Array.from({ length: 10 }, (_, i) => i < ideaYes);
  const implementation = Array.from({ length: 5 }, (_, i) => i < implYes);
  return JSON.stringify({ idea, implementation, noveltyBonus, risk, reason });
}

/**
 * @deprecated Use dualChecklistResponse instead. Kept for backward compat during migration.
 * Creates a legacy 15-question response (first 10 = idea, last 5 = impl).
 */
export function checklistResponse(yesCount: number, risk = 'low', reason = 'Test'): string {
  // Map old 15-question count to new dual format: split proportionally
  const ideaYes = Math.min(10, Math.round(yesCount * (10 / 15)));
  const implYes = Math.min(5, yesCount - ideaYes);
  // Legacy: estimate novelty bonus proportional to yes count
  const noveltyBonus = Math.round((yesCount / 15) * 12);
  return dualChecklistResponse(ideaYes, implYes, risk, reason, noveltyBonus);
}

export class MockLLMProvider implements LLMProvider {
  name = 'mock';

  // Configurable responses
  generateTextResponse: string | ((prompt: string) => string | Promise<string>) =
    dualChecklistResponse(7, 4, 'low', 'Mock LLM response', 12);
  generateEmbeddingResponse: number[] | ((text: string) => number[] | Promise<number[]>) =
    Array(768).fill(0).map((_, i) => Math.sin(i * 0.1) * 0.1);

  generateEmbeddingBatchResponse: number[][] | ((texts: string[]) => number[][] | Promise<number[][]>) | null = null;

  // Call tracking
  generateTextCalls: Array<{ prompt: string; options?: { temperature?: number; maxTokens?: number } }> = [];
  generateEmbeddingCalls: Array<{ text: string }> = [];
  generateEmbeddingBatchCalls: Array<{ texts: string[] }> = [];

  async generateText(
    prompt: string,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<string> {
    this.generateTextCalls.push({ prompt, options });

    if (typeof this.generateTextResponse === 'function') {
      return await this.generateTextResponse(prompt);
    }
    return this.generateTextResponse;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    this.generateEmbeddingCalls.push({ text });

    if (typeof this.generateEmbeddingResponse === 'function') {
      return await this.generateEmbeddingResponse(text);
    }
    return this.generateEmbeddingResponse;
  }

  async generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
    this.generateEmbeddingBatchCalls.push({ texts });

    if (this.generateEmbeddingBatchResponse) {
      if (typeof this.generateEmbeddingBatchResponse === 'function') {
        return await this.generateEmbeddingBatchResponse(texts);
      }
      return this.generateEmbeddingBatchResponse;
    }
    // Fallback: call generateEmbedding individually
    return Promise.all(texts.map(t => this.generateEmbedding(t)));
  }

  reset(): void {
    this.generateTextCalls = [];
    this.generateEmbeddingCalls = [];
    this.generateEmbeddingBatchCalls = [];
    this.generateTextResponse = dualChecklistResponse(7, 4, 'low', 'Mock LLM response', 12);
    this.generateEmbeddingResponse = Array(768).fill(0).map((_, i) => Math.sin(i * 0.1) * 0.1);
    this.generateEmbeddingBatchResponse = null;
  }
}
