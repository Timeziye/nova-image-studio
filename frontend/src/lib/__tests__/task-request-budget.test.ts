import { describe, expect, it, vi } from 'vitest';
import { prepareTaskRequest, TASK_BODY_BUDGET } from '../task-request-budget';
import type { CreateNovaTaskInput } from '../ccode-task-client';

const input = (data: string[]): CreateNovaTaskInput => ({ apiKey: 'test', baseUrl: 'https://example.invalid', protocol: 'openai', mode: 'image-to-image', prompt: '保留图中所有文字', outputSize: '2K', aspectRatio: '1:1', temperature: 1, model: 'test-model', parallelCount: 1, images: data.map(data => ({ data, mimeType: 'image/jpeg' })) });
const bytes = (value: string) => new TextEncoder().encode(value).length;

describe('task JSON aggregate budget', () => {
  it('compresses many individually small images whose total exceeds the budget', async () => {
    const request = input(Array.from({ length: 13 }, () => 'a'.repeat(900_000)));
    const encodeImage = vi.fn(async () => ({ data: 'small-image', mimeType: 'image/jpeg' }));
    const body = await prepareTaskRequest(request, { encodeImage });
    expect(bytes(body)).toBeLessThanOrEqual(TASK_BODY_BUDGET);
    expect(encodeImage).toHaveBeenCalledTimes(13);
    expect(JSON.parse(body).images).toHaveLength(13);
    expect(request.images[0].data.length).toBe(900_000);
    expect(JSON.parse(body).prompt).toBe(request.prompt);
  });
  it('leaves a request within budget unchanged', async () => {
    const request = input(['small']);
    const encodeImage = vi.fn();
    expect(await prepareTaskRequest(request, { encodeImage })).toBe(JSON.stringify(request));
    expect(encodeImage).not.toHaveBeenCalled();
  });
  it('rejects an uncompressible payload before it can be uploaded', async () => {
    const request = input(['a'.repeat(1200)]);
    await expect(prepareTaskRequest(request, { maxBytes: 512, encodeImage: async image => image })).rejects.toThrow(/参考图.*过大/);
  });
  it('measures UTF-8 JSON overhead, including prompt text', async () => {
    const request = { ...input([]), prompt: '中'.repeat(400) };
    await expect(prepareTaskRequest(request, { maxBytes: 512 })).rejects.toThrow(/过大/);
  });
  it('does not enlarge already small references when fitting the remaining images', async () => {
    const request = input(['a'.repeat(1200), 'tiny']);
    const body = await prepareTaskRequest(request, { maxBytes: 600, encodeImage: async () => ({ data: 'b'.repeat(50), mimeType: 'image/jpeg' }) });
    expect(JSON.parse(body).images[1].data).toBe('tiny');
  });
  it('respects cancellation before image preparation', async () => {
    const controller = new AbortController(); controller.abort();
    const encodeImage = vi.fn();
    await expect(prepareTaskRequest(input(['a'.repeat(1200)]), { maxBytes: 512, encodeImage, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(encodeImage).not.toHaveBeenCalled();
  });
});
