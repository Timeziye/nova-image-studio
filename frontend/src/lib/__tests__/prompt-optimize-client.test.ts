import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamPromptOptimize } from '@/lib/prompt-optimize-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamPromptOptimize', () => {
  it('uses the configured prompt optimization model in the Responses request', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body,
    });
    vi.stubGlobal('fetch', fetchMock);

    const handle = streamPromptOptimize(
      {
        apiKey: 'test-key',
        model: 'gpt-5.6-terra',
        mode: 'text-to-image',
        prompt: 'test prompt',
      },
      {
        onDelta: vi.fn(),
        onDone: vi.fn(),
        onError: vi.fn(),
      },
      'https://example.test',
    );

    await handle.promise;

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/responses');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-5.6-terra' });
  });
});
