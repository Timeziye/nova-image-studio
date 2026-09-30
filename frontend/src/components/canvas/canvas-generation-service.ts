"use client";

/**
 * 画布生成服务：把节点生成接入【宿主任务队列】（不改后端、不改队列）。
 * 使用 host 的 nova-task-client（createNovaTask / getNovaTask / ackNovaTask / cancelNovaTask）。
 * 视频/音频不在范围内；图生图无 mask（队列不支持）。
 */
import { ackNovaTask, cancelNovaTask, createNovaTask, getNovaTask, resolveImageTaskProvider, type NovaTaskResponse, type NovaTaskStatus, type ImageReference } from "@/lib/ccode-task-client";
import { normalizeModel } from "@/lib/model-capabilities";
import { compressReferenceDataUrl } from "./lib/image-utils";
import { uploadImage } from "./lib/image-storage";
import type { CanvasGenerationConfig } from "./types";
import type { ReferenceImage } from "./types-media";

export type { CanvasGenerationConfig };

export type CanvasGeneratedImage = {
  storageKey: string;
  url: string;
  width: number;
  height: number;
  mimeType: string;
  bytes: number;
};

export class CanvasApiKeyMissingError extends Error {
  constructor() {
    super("请先配置 API 密钥");
    this.name = "CanvasApiKeyMissingError";
  }
}

const POLL_INTERVAL = 2500;
const MAX_WAIT_MS = 30 * 60 * 1000;

async function toImageReference(image: ReferenceImage): Promise<ImageReference | null> {
  if (!image.dataUrl || image.dataUrl.length < 100) return null; // 过滤空/无效 dataUrl
  // 发送前压缩，避免未压缩 PNG 把请求体顶过后端 10MB 上限导致连接重置
  const { dataUrl, mimeType } = await compressReferenceDataUrl(image.dataUrl);
  const data = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  return { data, mimeType: mimeType || image.type || "image/png" };
}

/** 合成实际提交用模型 ID。 */
function resolveTaskModel(config: CanvasGenerationConfig): string {
  return normalizeModel(config.model);
}

/** 提交单个节点的生成任务（count=1），返回 taskId。 */
export async function submitNodeGeneration(args: {
  prompt: string;
  referenceImages: ReferenceImage[];
  config: CanvasGenerationConfig;
}, signal?: AbortSignal): Promise<string> {
  const provider = resolveImageTaskProvider(resolveTaskModel(args.config));
  const apiKey = provider.apiKey;
  if (!apiKey) throw new CanvasApiKeyMissingError();

  const imageRefs = (await Promise.all(args.referenceImages.map(toImageReference))).filter((ref): ref is ImageReference => ref !== null);
  const taskId = await createNovaTask({
    apiKey,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    mode: imageRefs.length > 0 ? "image-to-image" : "text-to-image",
    prompt: args.prompt,
    outputSize: args.config.outputSize,
    customSize: args.config.customSize,
    aspectRatio: args.config.aspectRatio,
    temperature: args.config.temperature,
    model: provider.modelId,
    gptImageQuality: args.config.gptImageQuality,
    gptImageStyle: args.config.gptImageStyle,
    gptImageBackground: args.config.gptImageBackground,
    parallelCount: 1,
    images: imageRefs,
  }, signal);
  return taskId;
}

export async function cancelNodeTask(taskId: string): Promise<void> {
  await cancelNovaTask(taskId);
}

/** 轮询单个任务直到终态；通过 onStatus 回调实时通知调用方。 */
export async function pollNodeTask(
  taskId: string,
  onStatus: (status: NovaTaskStatus) => void,
  signal?: AbortSignal,
): Promise<CanvasGeneratedImage[]> {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const task = await readTaskWithRetry(taskId, signal);
    onStatus(task.status);
    if (task.status === "completed" || task.status === "failed" || task.status === "expired") {
      const images = task.result?.images || [];
      if (task.status !== "completed" || images.length === 0) {
        throw new Error(task.error || (task.status === "expired" ? "该任务已超出取回时间" : "生成失败"));
      }
      return retrieveResultImages(taskId, images, signal);
    }
    if (Date.now() > deadline) throw new Error("生成超时，请稍后重试");
    await delay(POLL_INTERVAL, signal);
  }
}

/** 检查已有任务的当前状态（用于刷新页面后恢复进行中的任务）。 */
export async function checkExistingTask(taskId: string): Promise<{ status: NovaTaskResponse["status"]; images?: CanvasGeneratedImage[]; error?: string }> {
  const task = await readTaskWithRetry(taskId);
  if (task.status === "completed") {
    if (!task.result?.images?.length) throw new Error("任务没有可取回的图片，结果可能已过期");
    const stored = await retrieveResultImages(taskId, task.result.images);
    return { status: "completed", images: stored };
  }
  if (task.status === "failed" || task.status === "expired") {
    return { status: task.status, error: task.error || (task.status === "expired" ? "该任务已超出取回时间" : "生成失败") };
  }
  return { status: task.status };
}

/**
 * 提交一次生成任务到宿主队列并等待结果（兼容旧调用：一次任务按 config.count 返回多张图）。
 * @deprecated 新逻辑使用 submitNodeGeneration + pollNodeTask 逐节点提交。
 */
export async function generateCanvasImages(args: {
  prompt: string;
  referenceImages: ReferenceImage[];
  config: CanvasGenerationConfig;
  onStatus?: (status: NovaTaskStatus) => void;
  signal?: AbortSignal;
}): Promise<CanvasGeneratedImage[]> {
  const provider = resolveImageTaskProvider(resolveTaskModel(args.config));
  const apiKey = provider.apiKey;
  if (!apiKey) throw new CanvasApiKeyMissingError();

  const imageRefs = (await Promise.all(args.referenceImages.map(toImageReference))).filter((ref): ref is ImageReference => ref !== null);
  const taskId = await createNovaTask({
    apiKey,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    mode: imageRefs.length > 0 ? "image-to-image" : "text-to-image",
    prompt: args.prompt,
    outputSize: args.config.outputSize,
    customSize: args.config.customSize,
    aspectRatio: args.config.aspectRatio,
    temperature: args.config.temperature,
    model: provider.modelId,
    gptImageQuality: args.config.gptImageQuality,
    gptImageStyle: args.config.gptImageStyle,
    gptImageBackground: args.config.gptImageBackground,
    parallelCount: args.config.count,
    images: imageRefs,
  });

  const images = await pollNodeTask(taskId, (s) => args.onStatus?.(s), args.signal);
  return images;
}

/** 结果可能是 data URL 或 `URL:/api/nova/images/...`；统一下载为 blob 存入本地 IndexedDB。 */
async function retrieveResultImages(taskId: string, images: string[], signal?: AbortSignal): Promise<CanvasGeneratedImage[]> {
  const stored = await Promise.all(images.map(image => storeResultImage(image, signal)));
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  // ACK shortens server retention. Only acknowledge after every local write succeeds.
  // A failed ACK must not turn successfully saved images into a generation failure.
  await ackNovaTask(taskId).catch(() => undefined);
  return stored;
}

async function readTaskWithRetry(taskId: string, signal?: AbortSignal): Promise<NovaTaskResponse> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await getNovaTask(taskId);
    } catch (error) {
      if (!(error instanceof TypeError) || attempt >= 2) throw error;
      await delay(1000, signal);
    }
  }
}

async function storeResultImage(image: string, signal?: AbortSignal): Promise<CanvasGeneratedImage> {
  const realUrl = image.startsWith("URL:") ? image.slice(4) : image;
  if (!realUrl) throw new Error("生成结果地址为空，请重新取回结果");
  try {
    const stored = await uploadImage(realUrl, { signal, timeoutMs: 90_000, attempts: 2 });
    return { storageKey: stored.storageKey, url: stored.url, width: stored.width, height: stored.height, mimeType: stored.mimeType, bytes: stored.bytes };
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`生成结果取回或保存失败：${error instanceof Error ? error.message : String(error)}。可重新取回结果，无需重新生成。`);
  }
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);
    }
  });
}
