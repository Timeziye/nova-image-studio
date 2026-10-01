import type { CreateNovaTaskInput, ImageReference } from './ccode-task-client';

export const TASK_BODY_BUDGET = 8 * 1024 * 1024;
type ImageEncoder = (image: ImageReference, maxSide: number, quality: number, signal?: AbortSignal) => Promise<ImageReference>;
type Options = { signal?: AbortSignal; maxBytes?: number; encodeImage?: ImageEncoder };

export async function prepareTaskRequest(input: CreateNovaTaskInput, options: Options = {}): Promise<string> {
  const budget = Math.min(options.maxBytes ?? TASK_BODY_BUDGET, TASK_BODY_BUDGET);
  const checkAborted = () => {
    if (options.signal?.aborted) throw new DOMException('已终止', 'AbortError');
  };
  checkAborted();
  let body = JSON.stringify(input);
  if (new TextEncoder().encode(body).length <= budget) return body;

  const overhead = new TextEncoder().encode(JSON.stringify({ ...input, images: [] })).length;
  if (overhead >= budget || !input.images.length) throw new Error('任务请求过大，请缩短提示词或减少参数后重试。');
  const fairShare = Math.max(0, (budget - overhead) / input.images.length - 128);
  const images = input.images.map(image => ({ ...image }));
  const encodeImage = options.encodeImage ?? encodeReference;
  const passes = [[2560, 0.86], [2048, 0.80], [1536, 0.75], [1024, 0.70]];
  for (const [maxSide, quality] of passes) {
    // Two simultaneous decoders bound memory without serialising every reference.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(2, images.length) }, async () => {
      while (next < images.length) {
        const index = next++;
        checkAborted();
        if (images[index].data.length <= fairShare) continue;
        const encoded = await encodeImage(input.images[index], maxSide, quality, options.signal);
        checkAborted();
        if (encoded.data.length < images[index].data.length) images[index] = encoded;
      }
    }));
    body = JSON.stringify({ ...input, images });
    if (new TextEncoder().encode(body).length <= budget) return body;
  }
  throw new Error('参考图总体积过大，自动压缩后仍无法提交，请减少参考图数量或缩小图片后重试。');
}

async function encodeReference(reference: ImageReference, maxSide: number, quality: number, signal?: AbortSignal): Promise<ImageReference> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => { cleanup(); element.src = ''; reject(new DOMException('已终止', 'AbortError')); };
    element.onload = () => { cleanup(); resolve(element); };
    element.onerror = () => { cleanup(); reject(new Error('参考图解码失败，请重新导入图片。')); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    element.src = reference.data.startsWith('data:') ? reference.data : `data:${reference.mimeType};base64,${reference.data}`;
  });
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('参考图尺寸无效');
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法压缩参考图');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  // Preserve transparency for PNG/WebP references. Re-encode from the original each pass.
  const mime = /png|webp/i.test(reference.mimeType) ? 'image/webp' : 'image/jpeg';
  const url = canvas.toDataURL(mime, quality);
  const comma = url.indexOf(',');
  if (comma < 0) throw new Error('参考图压缩失败');
  return { data: url.slice(comma + 1), mimeType: url.slice(5, url.indexOf(';')) };
}
