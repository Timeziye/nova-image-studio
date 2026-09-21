import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamPromptOptimize } from '@/lib/prompt-optimize-client';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createStreamingFetch() {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    signal?.addEventListener('abort', () => {
      streamController.error(signal.reason);
    }, { once: true });
    return { ok: true, body };
  });
  const push = (payload: object) => {
    streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
  };
  const finish = () => {
    streamController.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    streamController.close();
  };
  return { fetchMock, push, finish };
}

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

  it('keeps an active stream alive past 30 seconds and completes normally', async () => {
    vi.useFakeTimers();
    const { fetchMock, push, finish } = createStreamingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    const onError = vi.fn();
    let receivedFirstDelta!: () => void;
    const firstDelta = new Promise<void>(resolve => { receivedFirstDelta = resolve; });
    let receivedSecondDelta!: () => void;
    const secondDelta = new Promise<void>(resolve => { receivedSecondDelta = resolve; });
    const onDelta = vi.fn((delta: string) => {
      if (delta === '前半段') receivedFirstDelta();
      if (delta === '后半段') receivedSecondDelta();
    });

    const handle = streamPromptOptimize(
      { apiKey: 'test-key', model: 'test-model', mode: 'agent', prompt: 'test prompt' },
      { onDelta, onDone, onError },
      'https://example.test',
    );
    push({ type: 'response.output_text.delta', delta: '前半段' });
    await firstDelta;

    await vi.advanceTimersByTimeAsync(45_000);
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.signal?.aborted).toBe(false);
    push({ type: 'response.output_text.delta', delta: '后半段' });
    await secondDelta;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(init?.signal?.aborted).toBe(false);
    finish();
    await handle.promise;

    expect(onDelta).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalledExactlyOnceWith('前半段后半段');
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports an idle timeout instead of silently leaving the UI loading', async () => {
    vi.useFakeTimers();
    const { fetchMock, push } = createStreamingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    const onError = vi.fn();
    let receivedDelta!: () => void;
    const firstDelta = new Promise<void>(resolve => { receivedDelta = resolve; });

    const handle = streamPromptOptimize(
      { apiKey: 'test-key', model: 'test-model', mode: 'agent', prompt: 'test prompt' },
      { onDelta: receivedDelta, onDone, onError },
      'https://example.test',
    );
    push({ type: 'response.output_text.delta', delta: '前半段' });
    await firstDelta;

    await vi.advanceTimersByTimeAsync(60_000);
    await handle.promise;

    expect(onDone).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toContain('优化请求超时');
  });

  it('keeps user cancellation silent', async () => {
    const { fetchMock, push } = createStreamingFetch();
    vi.stubGlobal('fetch', fetchMock);
    const onDone = vi.fn();
    const onError = vi.fn();
    let receivedDelta!: () => void;
    const firstDelta = new Promise<void>(resolve => { receivedDelta = resolve; });

    const handle = streamPromptOptimize(
      { apiKey: 'test-key', model: 'test-model', mode: 'agent', prompt: 'test prompt' },
      { onDelta: receivedDelta, onDone, onError },
      'https://example.test',
    );
    push({ type: 'response.output_text.delta', delta: '前半段' });
    await firstDelta;
    handle.abort();
    await handle.promise;

    expect(onDone).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
