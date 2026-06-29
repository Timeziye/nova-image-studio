import { createZip, readZip } from "../lib/zip";
import { saveAs } from "../lib/file-save";
import { getImageBlob, setImageBlob } from "../lib/image-storage";
import type { CanvasExportAsset, CanvasExportFile } from "../export-types";
import type { CanvasProject } from "../stores/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "../types";

type CanvasImageExportMode = "all" | "generated";
type CanvasImageExportEntry = {
  name: string;
  nodeTitle: string;
  content?: string;
  storageKey?: string;
  mimeType?: string;
};

export async function exportCanvasProjects(projects: CanvasProject[], fileName = "无限画布") {
  const zipFiles: { name: string; data: BlobPart }[] = [];
  const exportedProjects = await Promise.all(
    projects.map(async (project) => {
      const files: CanvasExportAsset[] = [];
      await Promise.all(
        collectStorageKeys(project).map(async (storageKey) => {
          const blob = storageKey.startsWith("image:") ? await getImageBlob(storageKey) : null;
          if (!blob) return;
          const path = `projects/${project.id}/files/${safeFileName(storageKey)}.${fileExtension(blob.type, storageKey)}`;
          files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
          zipFiles.push({ name: path, data: blob });
        }),
      );
      return { project, files };
    }),
  );

  const data: CanvasExportFile = { app: "nova-image-canvas", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
  const zip = await createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, ...zipFiles]);
  saveAs(zip, `${safeFileName(fileName)}.zip`);
}

export async function exportCanvasProjectImages(project: CanvasProject, mode: CanvasImageExportMode) {
  const images = collectCanvasImages(project.nodes, mode);
  if (!images.length) throw new Error(mode === "generated" ? "没有可下载的生成图" : "没有可下载的图片");

  const zipFiles: { name: string; data: BlobPart }[] = [];
  let index = 1;
  for (const image of images) {
    const blob = await readCanvasImageBlob(image);
    if (!blob) continue;
    const extension = fileExtension(blob.type || image.mimeType || "image/png", image.storageKey || image.name);
    zipFiles.push({
      name: `${String(index).padStart(3, "0")}-${safeFileName(image.name || image.nodeTitle || "image")}.${extension}`,
      data: blob,
    });
    index++;
  }

  if (!zipFiles.length) throw new Error("图片读取失败");
  const suffix = mode === "generated" ? "生成图" : "所有图";
  const zip = await createZip(zipFiles);
  saveAs(zip, `${safeFileName(project.title || "无限画布")}-${suffix}.zip`);
}

/** 从导出 zip 还原图片 blob 到 IndexedDB，并返回可供 importProject 的项目列表。 */
export async function importCanvasProjectsFromZip(file: Blob): Promise<Partial<CanvasProject>[]> {
  const zip = await readZip(file);
  const projectFile = zip.get("projects.json");
  if (!projectFile) throw new Error("缺少 projects.json");
  const data = JSON.parse(await projectFile.text()) as CanvasExportFile;

  await Promise.all(
    (data.projects || []).flatMap((entry) =>
      (entry.files || []).map(async (item) => {
        const blob = zip.get(item.path);
        if (!blob) return;
        const typedBlob = item.mimeType ? new Blob([blob], { type: item.mimeType }) : blob;
        if (item.storageKey.startsWith("image:")) await setImageBlob(item.storageKey, typedBlob);
      }),
    ),
  );

  return (data.projects || []).map((entry) => entry.project);
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
  if (!value || typeof value !== "object") return [...keys];
  if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
  Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
  return [...keys];
}

function collectCanvasImages(nodes: CanvasNodeData[], mode: CanvasImageExportMode): CanvasImageExportEntry[] {
  return nodes.flatMap((node): CanvasImageExportEntry[] => {
    if (node.type !== CanvasNodeType.Image) return [];
    if (mode === "generated" && !isGeneratedImageNode(node)) return [];

    if (node.metadata?.galleryImages?.length) {
      return node.metadata.galleryImages.map((image, index): CanvasImageExportEntry => ({
        nodeTitle: node.title,
        name: image.name || `${node.title}-${index + 1}`,
        content: image.content,
        storageKey: image.storageKey,
        mimeType: image.mimeType,
      }));
    }
    if (!node.metadata?.content && !node.metadata?.storageKey) return [];
    return [{
      name: node.title,
      nodeTitle: node.title,
      content: node.metadata.content,
      storageKey: node.metadata.storageKey,
      mimeType: node.metadata.mimeType,
    }];
  });
}

function isGeneratedImageNode(node: CanvasNodeData) {
  return Boolean(node.metadata?.generationTaskId || node.metadata?.generationStartedAt);
}

async function readCanvasImageBlob(image: { content?: string; storageKey?: string; mimeType?: string }) {
  if (image.storageKey) {
    const blob = await getImageBlob(image.storageKey);
    if (blob) return blob;
  }
  if (!image.content) return null;
  const response = await fetch(image.content);
  return response.blob();
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "_");
}

function fileExtension(mimeType: string, storageKey: string) {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return storageKey.startsWith("image:") ? "png" : "bin";
}
