import {
  AnthropicProvider,
  GeminiProvider,
  OpenAIProvider,
  createProvider,
} from '../../src/core/provider';

function mockFetchResponse(body: any, ok = true, status = 200) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
  } as any;
}

describe('provider', () => {
  beforeEach(() => {
    jest.spyOn(global, 'setTimeout').mockImplementation(((cb: any) => {
      if (typeof cb === 'function') cb();
      return 0 as any;
    }) as any);
    (global as any).fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GeminiProvider generateText returns first candidate text', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchResponse({
      candidates: [{ content: { parts: [{ text: 'gemini-output' }] } }],
    }));

    const provider = new GeminiProvider('gemini-key');
    const output = await provider.generateText('hello');

    expect(output).toBe('gemini-output');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('gemini-2.0-flash:generateContent'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-goog-api-key': 'gemini-key' }),
      }),
    );
  });

  it('GeminiProvider generateEmbedding throws on non-ok response', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockFetchResponse('quota exceeded', false, 429),
    );
    const provider = new GeminiProvider('gemini-key');

    await expect(provider.generateEmbedding('text')).rejects.toThrow('Embedding API error: 429');
  });

  it('OpenAIProvider generateEmbedding throws when embedding is empty', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchResponse({
      data: [{ embedding: [] }],
    }));

    const provider = new OpenAIProvider('openai-key');

    await expect(provider.generateEmbedding('text')).rejects.toThrow(
      'Empty embedding returned from OpenAI',
    );
  });

  it('AnthropicProvider generateEmbedding requires fallback provider', async () => {
    const provider = new AnthropicProvider('anthropic-key');

    await expect(provider.generateEmbedding('text')).rejects.toThrow(
      'Anthropic does not support embeddings. Provide an embeddingFallback provider.',
    );
  });

  it('AnthropicProvider generateEmbedding delegates to fallback provider', async () => {
    const fallback = {
      name: 'fallback',
      generateText: jest.fn(),
      generateEmbedding: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };
    const provider = new AnthropicProvider('anthropic-key', undefined, fallback);

    const embedding = await provider.generateEmbedding('sample');

    expect(embedding).toEqual([0.1, 0.2, 0.3]);
    expect(fallback.generateEmbedding).toHaveBeenCalledWith('sample');
  });

  it('createProvider builds known providers and rejects unknown ones', () => {
    expect(createProvider('gemini', 'k').name).toBe('gemini');
    expect(createProvider('openai', 'k').name).toBe('openai');
    expect(createProvider('anthropic', 'k').name).toBe('anthropic');
    expect(() => createProvider('unknown' as any, 'k')).toThrow('Unknown provider: unknown');
  });
});
