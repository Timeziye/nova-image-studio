import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNovaTask, type CreateNovaTaskInput } from '../ccode-task-client';

const request: CreateNovaTaskInput = { apiKey: 'test', baseUrl: 'https://example.invalid', protocol: 'openai', mode: 'text-to-image', prompt: 'test', outputSize: '2K', aspectRatio: '1:1', temperature: 1, model: 'test', parallelCount: 1, images: [] };
afterEach(() => vi.unstubAllGlobals());
describe('task creation capacity gate', () => {
  it('rejects excessive UTF-8 content without a network request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(createNovaTask({ ...request, prompt: '中'.repeat(3_000_000) })).rejects.toThrow(/请求过大/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('submits an eligible request exactly once and keeps the task ID', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ taskId: 'accepted' }), { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    await expect(createNovaTask(request)).resolves.toBe('accepted');
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].body).toBe(JSON.stringify(request));
  });
  it('does not submit after cancellation', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const controller = new AbortController(); controller.abort();
    await expect(createNovaTask(request, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
