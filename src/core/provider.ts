/**
 * Multi-provider LLM abstraction for Treliq
 */

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export interface LLMProvider {
  generateText(prompt: string, options?: { temperature?: number; maxTokens?: number }): Promise<string>;
  generateEmbedding(text: string): Promise<number[]>;
  name: string;
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async generateText(prompt: string, options?: { temperature?: number; maxTokens?: number }): Promise<string> {
    await sleep(100);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: options?.temperature ?? 0.1,
          maxOutputTokens: options?.maxTokens ?? 200,
        },
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  async generateEmbedding(text: string): Promise<number[]> {
    await sleep(100);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text }] },
      }),
    });
    if (!res.ok) throw new Error(`Embedding API error: ${res.status} ${await res.text()}`);
    const data = await res.json() as { embedding: { values: number[] } };
    return data.embedding.values;
  }
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async generateText(prompt: string, options?: { temperature?: number; maxTokens?: number }): Promise<string> {
    await sleep(100);
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: options?.temperature ?? 0.1,
        max_tokens: options?.maxTokens ?? 200,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  }

  async generateEmbedding(text: string): Promise<number[]> {
    await sleep(100);
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI Embedding ${res.status}`);
    const data = await res.json() as { data?: Array<{ embedding?: number[] }> };
    return data.data?.[0]?.embedding ?? [];
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private apiKey: string;
  private embeddingFallback?: LLMProvider;

  constructor(apiKey: string, embeddingFallback?: LLMProvider) {
    this.apiKey = apiKey;
    this.embeddingFallback = embeddingFallback;
  }

  async generateText(prompt: string, options?: { temperature?: number; maxTokens?: number }): Promise<string> {
    await sleep(100);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: options?.maxTokens ?? 200,
        messages: [{ role: 'user', content: prompt }],
        temperature: options?.temperature ?? 0.1,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json() as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text ?? '';
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.embeddingFallback) {
      throw new Error('Anthropic does not support embeddings. Provide an embeddingFallback provider.');
    }
    return this.embeddingFallback.generateEmbedding(text);
  }
}

export type ProviderName = 'gemini' | 'openai' | 'anthropic';

export function createProvider(name: ProviderName, apiKey: string, embeddingFallback?: LLMProvider): LLMProvider {
  switch (name) {
    case 'gemini': return new GeminiProvider(apiKey);
    case 'openai': return new OpenAIProvider(apiKey);
    case 'anthropic': return new AnthropicProvider(apiKey, embeddingFallback);
    default: throw new Error(`Unknown provider: ${name}`);
  }
}
