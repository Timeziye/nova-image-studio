'use client';

export type AssetSourceKind =
  | 'text-to-image'
  | 'image-to-image'
  | 'agent'
  | 'reverse-prompt'
  | 'gif'
  | 'upload'
  | 'random'
  | 'prompt-gallery'
  | 'manual';

export type AssetKind = 'image' | 'text';

export interface ImageAsset {
  id: string;
  kind?: 'image';
  blobKey: string;
  hash: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  tags: string[];
  note: string;
  sourceKind: AssetSourceKind;
  sourceLabel: string;
  sourceRef?: string;
  prompt?: string;
  folderId?: string;
  order?: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface TextAsset {
  id: string;
  kind: 'text';
  hash: string;
  content: string;
  sizeBytes: number;
  sourceKind: AssetSourceKind;
  sourceLabel: string;
  sourceRef?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export type AssetItem = ImageAsset | TextAsset;

export interface AssetFolder {
  id: string;
  name: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface AssetBlobRecord {
  key: string;
  hash: string;
  blob: Blob;
  thumbnailBlob?: Blob;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  createdAt: number;
}

export interface AddImageAssetInput {
  blob: Blob;
  name?: string;
  tags?: string[];
  note?: string;
  folderId?: string | null;
  sourceKind: AssetSourceKind;
  sourceLabel?: string;
  sourceRef?: string;
  prompt?: string;
}

export interface UpdateImageAssetInput {
  name?: string;
  tags?: string[];
  note?: string;
  folderId?: string | null;
  order?: number;
}

export interface AddTextAssetInput {
  content: string;
  sourceKind: AssetSourceKind;
  sourceLabel?: string;
  sourceRef?: string;
}

const DB_NAME = 'nova-assets-db';
const DB_VERSION = 2;
const ASSETS_STORE = 'assets';
const BLOBS_STORE = 'asset-blobs';
const FOLDERS_STORE = 'asset-folders';
const THUMB_MAX_SIDE = 512;
export const ASSET_LIBRARY_CHANGED_EVENT = 'nova-assets-changed';


function notifyAssetLibraryChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ASSET_LIBRARY_CHANGED_EVENT));
}

function now(): number {
  return Date.now();
}

function makeId(prefix = 'asset'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function hashBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer.slice(0));
    return bufferToHex(digest);
  }
  let hash = 0x811c9dc5;
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv32-${blob.size}-${hash.toString(16).padStart(8, '0')}`;
}

async function hashText(text: string): Promise<string> {
  const normalized = text.trim();
  const encoder = new TextEncoder();
  const buffer = encoder.encode(normalized);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer.slice(0));
    return `text-${bufferToHex(digest)}`;
  }
  let hash = 0x811c9dc5;
  for (const byte of buffer) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `text-fnv32-${buffer.length}-${hash.toString(16).padStart(8, '0')}`;
}

function isTextAsset(asset: AssetItem | null | undefined): asset is TextAsset {
  return asset?.kind === 'text';
}

function isImageAsset(asset: AssetItem | null | undefined): asset is ImageAsset {
  return Boolean(asset) && asset?.kind !== 'text';
}

export function getAssetFileExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('jpeg')) return 'jpg';
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('avif')) return 'avif';
  return 'png';
}

function sanitizeTags(tags?: string[]): string[] {
  if (!tags) return [];
  const unique = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag) unique.add(tag);
  }
  return Array.from(unique);
}

function normalizeFolderId(folderId?: string | null): string | undefined {
  const normalized = String(folderId || '').trim();
  return normalized || undefined;
}

function loadImageFromObjectUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

async function getImageDimensionsAndThumbnail(blob: Blob): Promise<{
  width?: number;
  height?: number;
  thumbnailBlob?: Blob;
}> {
  if (typeof document === 'undefined') return {};
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageFromObjectUrl(url);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return {};

    const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(width, height));
    const thumbWidth = Math.max(1, Math.round(width * scale));
    const thumbHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = thumbWidth;
    canvas.height = thumbHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { width, height };
    ctx.drawImage(img, 0, 0, thumbWidth, thumbHeight);
    const thumbnailBlob = await canvasToBlob(canvas, 'image/webp', 0.82);
    return { width, height, thumbnailBlob: thumbnailBlob || undefined };
  } catch {
    return {};
  } finally {
    URL.revokeObjectURL(url);
  }
}

function openAssetsDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => resolve(null);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = event => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(ASSETS_STORE)) {
        const store = db.createObjectStore(ASSETS_STORE, { keyPath: 'id' });
        store.createIndex('hash', 'hash', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        db.createObjectStore(BLOBS_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(FOLDERS_STORE)) {
        const store = db.createObjectStore(FOLDERS_STORE, { keyPath: 'id' });
        store.createIndex('order', 'order', { unique: false });
      }
    };
  });
}

function getAllFromStore<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise(resolve => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve((req.result as T[]) || []);
    req.onerror = () => resolve([]);
  });
}

function getFromStore<T>(db: IDBDatabase, storeName: string, key: string): Promise<T | null> {
  return new Promise(resolve => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve((req.result as T) || null);
    req.onerror = () => resolve(null);
  });
}

async function putAssetAndBlob(asset: AssetItem, blobRecord: AssetBlobRecord | null): Promise<void> {
  const db = await openAssetsDB();
  if (!db) throw new Error('当前浏览器不支持素材库本地存储');
  return new Promise((resolve, reject) => {
    const tx = db.transaction([ASSETS_STORE, BLOBS_STORE], 'readwrite');
    if (blobRecord) tx.objectStore(BLOBS_STORE).put(blobRecord);
    tx.objectStore(ASSETS_STORE).put(asset);
    tx.oncomplete = () => { db.close(); notifyAssetLibraryChanged(); resolve(); };
    tx.onerror = () => {
      const error = tx.error || new Error('素材库写入失败');
      db.close();
      reject(error);
    };
  });
}

async function putAssets(assets: AssetItem[]): Promise<void> {
  if (assets.length === 0) return;
  const db = await openAssetsDB();
  if (!db) throw new Error('当前浏览器不支持素材库本地存储');
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ASSETS_STORE, 'readwrite');
    const store = tx.objectStore(ASSETS_STORE);
    for (const asset of assets) store.put(asset);
    tx.oncomplete = () => { db.close(); notifyAssetLibraryChanged(); resolve(); };
    tx.onerror = () => {
      const error = tx.error || new Error('素材库写入失败');
      db.close();
      reject(error);
    };
  });
}

async function putFolders(folders: AssetFolder[]): Promise<void> {
  if (folders.length === 0) return;
  const db = await openAssetsDB();
  if (!db) throw new Error('当前浏览器不支持素材库本地存储');
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FOLDERS_STORE, 'readwrite');
    const store = tx.objectStore(FOLDERS_STORE);
    for (const folder of folders) store.put(folder);
    tx.oncomplete = () => { db.close(); notifyAssetLibraryChanged(); resolve(); };
    tx.onerror = () => {
      const error = tx.error || new Error('文件夹写入失败');
      db.close();
      reject(error);
    };
  });
}

export async function addImageAsset(input: AddImageAssetInput): Promise<ImageAsset> {
  const sourceBlob = input.blob;
  const mimeType = sourceBlob.type || 'image/png';
  const hash = await hashBlob(sourceBlob);
  const key = hash;
  const createdAt = now();
  const db = await openAssetsDB();
  if (!db) {
    throw new Error('当前浏览器不支持素材库本地存储');
  }

  let existingBlob: AssetBlobRecord | null = null;
  let existingAssets: AssetItem[] = [];
  existingBlob = await getFromStore<AssetBlobRecord>(db, BLOBS_STORE, key);
  existingAssets = await getAllFromStore<AssetItem>(db, ASSETS_STORE);
  db.close();

  const sameSourceAsset = existingAssets.filter(isImageAsset).find(asset =>
    asset.hash === hash &&
    asset.sourceKind === input.sourceKind &&
    asset.sourceRef &&
    asset.sourceRef === input.sourceRef
  );
  if (sameSourceAsset) {
    const updated: ImageAsset = {
      ...sameSourceAsset,
      lastUsedAt: createdAt,
      updatedAt: createdAt,
      tags: sanitizeTags([...sameSourceAsset.tags, ...(input.tags || [])]),
      note: input.note || sameSourceAsset.note,
      ...(input.folderId !== undefined ? { folderId: normalizeFolderId(input.folderId) } : {}),
    };
    await putAssetAndBlob(updated, null);
    return updated;
  }

  const dimensions: { width?: number; height?: number; thumbnailBlob?: Blob } = existingBlob
    ? { width: existingBlob.width, height: existingBlob.height }
    : await getImageDimensionsAndThumbnail(sourceBlob);
  const blobRecord: AssetBlobRecord | null = existingBlob
    ? null
    : {
      key,
      hash,
      blob: sourceBlob,
      thumbnailBlob: dimensions.thumbnailBlob,
      mimeType,
      sizeBytes: sourceBlob.size,
      width: dimensions.width,
      height: dimensions.height,
      createdAt,
    };

  const asset: ImageAsset = {
    id: makeId(),
    kind: 'image',
    blobKey: key,
    hash,
    name: input.name?.trim() || `素材-${new Date(createdAt).toLocaleString()}`,
    mimeType,
    sizeBytes: sourceBlob.size,
    width: dimensions.width,
    height: dimensions.height,
    tags: sanitizeTags(input.tags),
    note: input.note?.trim() || '',
    sourceKind: input.sourceKind,
    sourceLabel: input.sourceLabel || getSourceKindLabel(input.sourceKind),
    sourceRef: input.sourceRef,
    prompt: input.prompt,
    folderId: normalizeFolderId(input.folderId),
    order: createdAt,
    createdAt,
    updatedAt: createdAt,
    lastUsedAt: createdAt,
  };
  await putAssetAndBlob(asset, blobRecord);
  return asset;
}

export async function addTextAsset(input: AddTextAssetInput): Promise<TextAsset> {
  const content = input.content.trim();
  if (!content) throw new Error('提示词内容不能为空');
  const hash = await hashText(content);
  const createdAt = now();
  const db = await openAssetsDB();
  if (!db) {
    throw new Error('当前浏览器不支持素材库本地存储');
  }

  const assets = await getAllFromStore<AssetItem>(db, ASSETS_STORE);
  db.close();
  const existing = assets.find(asset => isTextAsset(asset) && asset.hash === hash);
  if (existing && isTextAsset(existing)) {
    const updated: TextAsset = {
      ...existing,
      lastUsedAt: createdAt,
      updatedAt: createdAt,
    };
    await putAssetAndBlob(updated, null);
    return updated;
  }

  const asset: TextAsset = {
    id: makeId('text-asset'),
    kind: 'text',
    hash,
    content,
    sizeBytes: new TextEncoder().encode(content).byteLength,
    sourceKind: input.sourceKind,
    sourceLabel: input.sourceLabel || getSourceKindLabel(input.sourceKind),
    sourceRef: input.sourceRef,
    createdAt,
    updatedAt: createdAt,
    lastUsedAt: createdAt,
  };
  await putAssetAndBlob(asset, null);
  return asset;
}

export async function findImageAssetByBlob(blob: Blob): Promise<ImageAsset | null> {
  const hash = await hashBlob(blob);
  const db = await openAssetsDB();
  if (!db) return null;
  const assets = await getAllFromStore<AssetItem>(db, ASSETS_STORE);
  db.close();
  return assets.filter(isImageAsset).find(asset => asset.hash === hash) || null;
}

export async function listAssets(kind?: AssetKind): Promise<AssetItem[]> {
  const db = await openAssetsDB();
  if (!db) return [];
  const assets = await getAllFromStore<AssetItem>(db, ASSETS_STORE);
  db.close();
  return assets
    .filter(asset => {
      if (!kind) return true;
      if (kind === 'image') return isImageAsset(asset);
      return isTextAsset(asset);
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function listAssetFolders(): Promise<AssetFolder[]> {
  const db = await openAssetsDB();
  if (!db) return [];
  const folders = await getAllFromStore<AssetFolder>(db, FOLDERS_STORE);
  db.close();
  return folders.sort((a, b) => (a.order || 0) - (b.order || 0) || a.createdAt - b.createdAt || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function createAssetFolder(name: string): Promise<AssetFolder> {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error('文件夹名称不能为空');
  const folders = await listAssetFolders();
  if (folders.some(folder => folder.name.trim().toLowerCase() === normalizedName.toLowerCase())) {
    throw new Error('同名文件夹已存在');
  }
  const createdAt = now();
  const folder: AssetFolder = {
    id: makeId('asset-folder'),
    name: normalizedName,
    order: (folders[folders.length - 1]?.order || 0) + 1000,
    createdAt,
    updatedAt: createdAt,
  };
  await putFolders([folder]);
  return folder;
}

export async function findOrCreateAssetFolder(name: string): Promise<AssetFolder> {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error('文件夹名称不能为空');
  const folders = await listAssetFolders();
  const existing = folders.find(folder => folder.name.trim().toLowerCase() === normalizedName.toLowerCase());
  if (existing) return existing;
  return createAssetFolder(normalizedName);
}

export async function renameAssetFolder(folderId: string, name: string): Promise<void> {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error('文件夹名称不能为空');
  const folders = await listAssetFolders();
  const folder = folders.find(item => item.id === folderId);
  if (!folder) throw new Error('文件夹不存在');
  if (folders.some(item => item.id !== folderId && item.name.trim().toLowerCase() === normalizedName.toLowerCase())) {
    throw new Error('同名文件夹已存在');
  }
  await putFolders([{ ...folder, name: normalizedName, updatedAt: now() }]);
}

export async function deleteAssetFolder(folderId: string): Promise<void> {
  const folders = await listAssetFolders();
  if (!folders.some(folder => folder.id === folderId)) throw new Error('文件夹不存在');
  const db = await openAssetsDB();
  if (!db) throw new Error('当前浏览器不支持素材库本地存储');
  const assets = await getAllFromStore<AssetItem>(db, ASSETS_STORE);
  const imageAssetsToDelete = assets
    .filter(isImageAsset)
    .filter(asset => asset.folderId === folderId);
  const deletedIds = new Set(imageAssetsToDelete.map(asset => asset.id));
  const blobKeysToDelete = new Set(
    imageAssetsToDelete
      .filter(asset => !assets.some(item => isImageAsset(item) && !deletedIds.has(item.id) && item.blobKey === asset.blobKey))
      .map(asset => asset.blobKey),
  );

  return new Promise((resolve, reject) => {
    const tx = db.transaction([FOLDERS_STORE, ASSETS_STORE, BLOBS_STORE], 'readwrite');
    tx.objectStore(FOLDERS_STORE).delete(folderId);
    const assetsStore = tx.objectStore(ASSETS_STORE);
    for (const asset of imageAssetsToDelete) assetsStore.delete(asset.id);
    const blobsStore = tx.objectStore(BLOBS_STORE);
    for (const blobKey of blobKeysToDelete) blobsStore.delete(blobKey);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => {
      const error = tx.error || new Error('文件夹删除失败');
      db.close();
      reject(error);
    };
  });
}

export async function reorderAssetFolders(folderIds: string[]): Promise<void> {
  const idOrder = new Map(folderIds.map((id, index) => [id, index]));
  const timestamp = now();
  const folders = await listAssetFolders();
  const updates = folders
    .filter(folder => idOrder.has(folder.id))
    .map(folder => ({
      ...folder,
      order: ((idOrder.get(folder.id) || 0) + 1) * 1000,
      updatedAt: timestamp,
    }));
  await putFolders(updates);
}

export async function listImageAssets(): Promise<ImageAsset[]> {
  const assets = await listAssets('image');
  return assets.filter(isImageAsset);
}

export async function listTextAssets(): Promise<TextAsset[]> {
  const assets = await listAssets('text');
  return assets.filter(isTextAsset);
}

export async function getImageAsset(assetId: string): Promise<ImageAsset | null> {
  const db = await openAssetsDB();
  if (!db) return null;
  const asset = await getFromStore<AssetItem>(db, ASSETS_STORE, assetId);
  db.close();
  return isImageAsset(asset) ? asset : null;
}

export async function getTextAsset(assetId: string): Promise<TextAsset | null> {
  const db = await openAssetsDB();
  if (!db) return null;
  const asset = await getFromStore<AssetItem>(db, ASSETS_STORE, assetId);
  db.close();
  return isTextAsset(asset) ? asset : null;
}

export async function getAssetBlob(assetId: string): Promise<Blob | null> {
  const asset = await getImageAsset(assetId);
  if (!asset) return null;
  const db = await openAssetsDB();
  if (!db) return null;
  const record = await getFromStore<AssetBlobRecord>(db, BLOBS_STORE, asset.blobKey);
  db.close();
  return record?.blob || null;
}

export async function getAssetThumbnailBlob(asset: ImageAsset): Promise<Blob | null> {
  const db = await openAssetsDB();
  if (!db) return null;
  const record = await getFromStore<AssetBlobRecord>(db, BLOBS_STORE, asset.blobKey);
  db.close();
  return record?.thumbnailBlob || record?.blob || null;
}

export async function updateImageAsset(assetId: string, input: UpdateImageAssetInput): Promise<void> {
  const current = await getImageAsset(assetId);
  if (!current) throw new Error('素材不存在');
  const updated: ImageAsset = {
    ...current,
    name: input.name?.trim() || current.name,
    tags: input.tags ? sanitizeTags(input.tags) : current.tags,
    note: typeof input.note === 'string' ? input.note : current.note,
    ...(input.folderId !== undefined ? { folderId: normalizeFolderId(input.folderId) } : {}),
    ...(typeof input.order === 'number' ? { order: input.order } : {}),
    updatedAt: now(),
  };
  await putAssetAndBlob(updated, null);
}

export async function moveImageAssetsToFolder(assetIds: string[], folderId?: string | null): Promise<void> {
  const ids = Array.from(new Set(assetIds));
  if (ids.length === 0) return;
  const normalizedFolderId = normalizeFolderId(folderId);
  if (normalizedFolderId) {
    const folders = await listAssetFolders();
    if (!folders.some(folder => folder.id === normalizedFolderId)) throw new Error('文件夹不存在');
  }
  const db = await openAssetsDB();
  if (!db) throw new Error('当前浏览器不支持素材库本地存储');
  const assets = await getAllFromStore<AssetItem>(db, ASSETS_STORE);
  db.close();
  const imageAssets = assets.filter(isImageAsset);
  const maxOrder = imageAssets
    .filter(asset => (asset.folderId || '') === (normalizedFolderId || '') && !ids.includes(asset.id))
    .reduce((max, asset) => Math.max(max, asset.order || asset.createdAt || 0), 0);
  const timestamp = now();
  const updates = imageAssets
    .filter(asset => ids.includes(asset.id))
    .map((asset, index) => ({
      ...asset,
      folderId: normalizedFolderId,
      order: maxOrder + (index + 1) * 1000,
      updatedAt: timestamp,
    }));
  await putAssets(updates);
}

export async function reorderImageAssets(assetIds: string[], folderId?: string | null): Promise<void> {
  const idOrder = new Map(assetIds.map((id, index) => [id, index]));
  if (idOrder.size === 0) return;
  const normalizedFolderId = normalizeFolderId(folderId);
  const db = await openAssetsDB();
  if (!db) throw new Error('当前浏览器不支持素材库本地存储');
  const assets = await getAllFromStore<AssetItem>(db, ASSETS_STORE);
  db.close();
  const timestamp = now();
  const updates = assets
    .filter(isImageAsset)
    .filter(asset => idOrder.has(asset.id) && (asset.folderId || '') === (normalizedFolderId || ''))
    .map(asset => ({
      ...asset,
      order: ((idOrder.get(asset.id) || 0) + 1) * 1000,
      updatedAt: timestamp,
    }));
  await putAssets(updates);
}

export async function touchImageAsset(assetId: string): Promise<void> {
  const current = await getImageAsset(assetId);
  if (!current) return;
  await putAssetAndBlob({ ...current, lastUsedAt: now(), updatedAt: now() }, null);
}

export async function touchAsset(assetId: string): Promise<void> {
  const db = await openAssetsDB();
  if (!db) return;
  const asset = await getFromStore<AssetItem>(db, ASSETS_STORE, assetId);
  db.close();
  if (!asset) return;
  await putAssetAndBlob({ ...asset, lastUsedAt: now(), updatedAt: now() }, null);
}

export async function deleteAsset(assetId: string): Promise<void> {
  const db = await openAssetsDB();
  if (!db) throw new Error('当前浏览器不支持素材库本地存储');
  const asset = await getFromStore<AssetItem>(db, ASSETS_STORE, assetId);
  if (!asset) {
    db.close();
    throw new Error('素材不存在');
  }
  const assets = await getAllFromStore<AssetItem>(db, ASSETS_STORE);
  const shouldDeleteBlob = isImageAsset(asset) && assets.filter(item => isImageAsset(item) && item.id !== assetId && item.blobKey === asset.blobKey).length === 0;
  return new Promise((resolve, reject) => {
    const tx = db.transaction([ASSETS_STORE, BLOBS_STORE], 'readwrite');
    tx.objectStore(ASSETS_STORE).delete(assetId);
    if (isImageAsset(asset) && shouldDeleteBlob) tx.objectStore(BLOBS_STORE).delete(asset.blobKey);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => {
      const error = tx.error || new Error('素材删除失败');
      db.close();
      reject(error);
    };
  });
}

export async function deleteImageAsset(assetId: string): Promise<void> {
  await deleteAsset(assetId);
}

export function getSourceKindLabel(kind: AssetSourceKind): string {
  switch (kind) {
    case 'text-to-image': return '文生图';
    case 'image-to-image': return '图生图';
    case 'agent': return 'Agent';
    case 'reverse-prompt': return '反推提示词';
    case 'gif': return 'GIF 工作流';
    case 'upload': return '用户上传';
    case 'random': return '随机图片';
    case 'prompt-gallery': return '提示词广场';
    case 'manual': return '手动导入';
    default: return '图片素材';
  }
}

export function formatAssetSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return '未知大小';
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(2)} MB`;
}
