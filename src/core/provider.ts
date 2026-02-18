/**
 * Multi-provider LLM abstraction for Treliq
 */

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/** Default models per provider */
export const DEFAULT_PROVIDER_MODELS: Record<string, string> = {
  gemini: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
  openrouter: 'anthropic/claude-sonnet-4.5',
};

/** Models that need higher max_tokens (extended thinking, verbose output) */
function defaultMaxTokens(model: string): number {
  if (/sonnet|opus|claude-3/.test(model)) return 1024;
  return 200;
}

export interface LLMProvider {
  generateText(prompt: string, options?: { temperature?: number; maxTokens?: number }): Promise<string>;
  generateEmbedding(text: string): Promise<number[]>;
  name: string;
  readonly supportsEmbeddings?: boolean;
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  readonly supportsEmbeddings = true;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = DEFAULT_PROVIDER_MODELS.gemini) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generateText(prompt: string, options?: { temperature?: number; maxTokens?: number }): Promise<string> {
    await sleep(100);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: options?.temperature ?? 0.1,
          maxOutputTokens: options?.maxTokens ?? defaultMaxTokens(this.model),
        },
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  }

  async generateEmbedding(text: string): Promise<number[]> {
    await sleep(100);
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
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
  readonly supportsEmbeddings = true;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model = DEFAULT_PROVIDER_MODELS.openai) {
    this.apiKey = apiKey;
    this.model = model;
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
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: options?.temperature ?? 0.1,
        max_tokens: options?.maxTokens ?? defaultMaxTokens(this.model),
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
    const embedding = data.data?.[0]?.embedding ?? [];
    if (embedding.length === 0) {
      throw new Error('Empty embedding returned from OpenAI');
    }
    return embedding;
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly supportsEmbeddings = false;
  private apiKey: string;
  private model: string;
  private embeddingFallback?: LLMProvider;

  constructor(apiKey: string, model = DEFAULT_PROVIDER_MODELS.anthropic, embeddingFallback?: LLMProvider) {
    this.apiKey = apiKey;
    this.model = model;
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
        model: this.model,
        max_tokens: options?.maxTokens ?? defaultMaxTokens(this.model),
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

export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';
  readonly supportsEmbeddings = false;
  private apiKey: string;
  private model: string;
  private embeddingFallback?: LLMProvider;

  constructor(apiKey: string, model = DEFAULT_PROVIDER_MODELS.openrouter, embeddingFallback?: LLMProvider) {
    this.apiKey = apiKey;
    this.model = model;
    this.embeddingFallback = embeddingFallback;
  }

  async generateText(prompt: string, options?: { temperature?: number; maxTokens?: number }): Promise<string> {
    await sleep(100);
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/mahsumaktas/treliq',
        'X-Title': 'Treliq PR Triage',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: options?.temperature ?? 0.1,
        max_tokens: options?.maxTokens ?? defaultMaxTokens(this.model),
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.embeddingFallback) {
      throw new Error('OpenRouter does not support embeddings. Provide an embeddingFallback provider (e.g., Gemini).');
    }
    return this.embeddingFallback.generateEmbedding(text);
  }
}

export type ProviderName = 'gemini' | 'openai' | 'anthropic' | 'openrouter';

/**
 * Auto-detect an embedding fallback provider from available env vars.
 */
export function autoEmbeddingFallback(): LLMProvider | undefined {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) return new GeminiProvider(geminiKey);
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) return new OpenAIProvider(openaiKey);
  return undefined;
}

export function createProvider(name: ProviderName, apiKey: string, model?: string, embeddingFallback?: LLMProvider): LLMProvider {
  const m = model || DEFAULT_PROVIDER_MODELS[name];
  const ef = embeddingFallback ?? autoEmbeddingFallback();
  switch (name) {
    case 'gemini': return new GeminiProvider(apiKey, m);
    case 'openai': return new OpenAIProvider(apiKey, m);
    case 'anthropic': return new AnthropicProvider(apiKey, m, ef);
    case 'openrouter': return new OpenRouterProvider(apiKey, m, ef);
    default: throw new Error(`Unknown provider: ${name}`);
  }
}
