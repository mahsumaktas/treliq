/**
 * Mock LLM Provider for testing
 */

import type { LLMProvider } from '../../src/core/provider';

export class MockLLMProvider implements LLMProvider {
  name = 'mock';

  // Configurable responses
  generateTextResponse: string | ((prompt: string) => string | Promise<string>) =
    '{"score": 75, "risk": "low", "reason": "Mock LLM response"}';
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
    this.generateTextResponse = '{"score": 75, "risk": "low", "reason": "Mock LLM response"}';
    this.generateEmbeddingResponse = Array(768).fill(0).map((_, i) => Math.sin(i * 0.1) * 0.1);
    this.generateEmbeddingBatchResponse = null;
  }
}
