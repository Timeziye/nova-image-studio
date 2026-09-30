"use client";

import localforage from "localforage";

import { nanoid } from "nanoid";
import { readImageMeta } from "./image-utils";

export type UploadedImage = {
  url: string;
  storageKey: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
};

const store = localforage.createInstance({ name: "nova-image", storeName: "canvas_image_files" });
const objectUrls = new Map<string, string>();

/** 本地存储图片 blob（命名沿用 uploadImage，但全程纯前端 IndexedDB，不上传服务端）。 */
export async function uploadImage(input: string | Blob, options: { signal?: AbortSignal; timeoutMs?: number; attempts?: number } = {}): Promise<UploadedImage> {
  const blob = typeof input === "string" ? await downloadImageBlob(input, options) : input;
  const storageKey = `image:${nanoid()}`;
  await store.setItem(storageKey, blob);
  const url = URL.createObjectURL(blob);
  objectUrls.set(storageKey, url);
  const meta = await readImageMeta(url);
  return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
}

async function downloadImageBlob(url: string, options: { signal?: AbortSignal; timeoutMs?: number; attempts?: number }): Promise<Blob> {
  const attempts = options.attempts ?? 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new DOMException("图片下载超时", "TimeoutError")), options.timeoutMs ?? 90_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.size) throw new Error("图片下载结果为空");
      if (blob.type && !blob.type.startsWith("image/") && blob.type !== "application/octet-stream") {
        throw new Error(`图片响应类型无效：${blob.type}`);
      }
      return blob;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const transient = error instanceof TypeError || controller.signal.aborted;
      if (!transient || attempt + 1 >= attempts) {
        if (controller.signal.aborted) throw new Error("图片下载超时，请重新取回结果");
        throw error;
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  throw new Error("图片下载失败");
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
  if (!storageKey) return fallback;
  const cached = objectUrls.get(storageKey);
  if (cached) return cached;
  const blob = await store.getItem<Blob>(storageKey);
  if (!blob) return fallback;
  const url = URL.createObjectURL(blob);
  objectUrls.set(storageKey, url);
  return url;
}

export async function getImageBlob(storageKey: string) {
  return store.getItem<Blob>(storageKey);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
  await store.setItem(storageKey, blob);
  const url = URL.createObjectURL(blob);
  objectUrls.set(storageKey, url);
  return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }): Promise<string> {
  // 优先用 storageKey（IndexedDB），避免刷新后 blob: URL 失效导致 fetch 失败
  if (image.storageKey) {
    const blob = await store.getItem<Blob>(image.storageKey);
    if (blob) return blobToDataUrl(blob);
  }
  const url = image.dataUrl || image.url || "";
  if (!url) throw new Error("图片数据不可用（可能已刷新丢失），请重新上传或从素材库导入");
  if (url.startsWith("data:")) return url;
  // blob: URL 可能已失效（刷新后），尝试 fetch
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return blobToDataUrl(await response.blob());
  } catch {
    throw new Error("图片加载失败（blob URL 可能已失效），请重新上传或从素材库导入");
  }
}

export async function deleteStoredImages(keys: Iterable<string>) {
  await Promise.all(
    Array.from(new Set(keys)).map(async (key) => {
      const url = objectUrls.get(key);
      if (url) URL.revokeObjectURL(url);
      objectUrls.delete(key);
      await store.removeItem(key);
    }),
  );
}

export async function cleanupUnusedImages(usedData: unknown) {
  const usedKeys = collectImageStorageKeys(usedData);
  const unused: string[] = [];
  await store.iterate((_value, key) => {
    if (!usedKeys.has(key)) unused.push(key);
  });
  await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
  if (!value || typeof value !== "object") return keys;
  if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
  Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
  return keys;
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(blob);
  });
}
