/**
 * Mock LLM Provider for testing
 */

import type { LLMProvider } from '../../src/core/provider';

/**
 * Helper to create a CheckEval-format JSON response for mock LLM.
 * ideaScore = Math.round((yesCount / 15) * 100)
 *
 * Score mapping: 0→0, 3→20, 5→33, 7→47, 8→53, 9→60, 10→67, 11→73, 12→80, 13→87, 14→93, 15→100
 */
export function checklistResponse(yesCount: number, risk = 'low', reason = 'Test'): string {
  const answers = Array.from({ length: 15 }, (_, i) => i < yesCount);
  return JSON.stringify({ answers, risk, reason });
}

export class MockLLMProvider implements LLMProvider {
  name = 'mock';

  // Configurable responses
  generateTextResponse: string | ((prompt: string) => string | Promise<string>) =
    checklistResponse(11, 'low', 'Mock LLM response');
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
    this.generateTextResponse = checklistResponse(11, 'low', 'Mock LLM response');
    this.generateEmbeddingResponse = Array(768).fill(0).map((_, i) => Math.sin(i * 0.1) * 0.1);
    this.generateEmbeddingBatchResponse = null;
  }
}
