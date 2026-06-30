"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ArrowLeft } from "lucide-react";
import { nanoid } from "nanoid";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AgentAssetPickerDialog, AgentTextAssetPickerDialog } from "@/components/agent/AgentAssetPickerDialog";
import { addImageAsset, addTextAsset, getAssetBlob, type AssetFolder, type ImageAsset, type TextAsset } from "@/lib/asset-store";
import { InfiniteCanvas } from "./components/infinite-canvas";
import { CanvasNode, type ResizeCorner } from "./components/canvas-node";
import { ActiveConnectionPath, ConnectionPath } from "./components/canvas-connections";
import { Minimap } from "./components/canvas-mini-map";
import { CanvasZoomControls } from "./components/canvas-zoom-controls";
import { CanvasToolbar } from "./components/canvas-toolbar";
import { CanvasPromptGalleryImportDialog } from "./components/canvas-prompt-gallery-import-dialog";
import { CanvasContextMenu } from "./components/canvas-context-menu";
import { CanvasConfigNodePanel } from "./components/canvas-config-node-panel";
import { FullscreenImageViewer } from "./components/fullscreen-image-viewer";
import type { ImageActionPayload } from "@/lib/image-actions";
import { CanvasCropDialog, CanvasUpscaleDialog, CanvasSplitDialog, CanvasAngleDialog } from "./components/canvas-node-dialogs";
import { canvasTheme } from "./lib/canvas-theme";
import { getNodeSpec } from "./constants";
import { flushCanvasStoreSave, useCanvasStore } from "./stores/use-canvas-store";
import { useCanvasConfigStore } from "./stores/use-canvas-config-store";
import { CanvasApiKeyMissingError, cancelNodeTask, submitNodeGeneration, pollNodeTask, checkExistingTask, type CanvasGeneratedImage } from "./canvas-generation-service";
import { buildNodeGenerationContext, buildNodeGenerationInputs, buildPairwiseGenerationContexts, hydrateNodeGenerationContext } from "./components/canvas-node-generation";
import { buildNodeMentionReferences } from "./utils/canvas-resource-references";
import { fitNodeSize } from "./utils/canvas-node-size";
import { getImageBlob, imageToDataUrl, resolveImageUrl, uploadImage, type UploadedImage } from "./lib/image-storage";
import { imageReferenceLabel } from "./lib/image-reference-prompt";
import { compressReferenceDataUrl, readFileAsDataUrl } from "./lib/image-utils";
import { CanvasNodeType, type CanvasConnection, type CanvasGalleryImage, type CanvasGenerationConfig, type CanvasNodeData, type CanvasNodeMetadata, type ContextMenuState, type ConnectionHandle, type Position, type SelectionBox, type ViewportTransform } from "./types";
import type { ReferenceImage } from "./types-media";
import { PromptOptimizeDialog } from "@/components/PromptOptimizeDialog";
import { streamPromptOptimize, type StreamPromptOptimizeHandle, type OptimizeImageInput } from "@/lib/prompt-optimize-client";
import { requireDefaultConfiguredTextModel } from "@/lib/model-endpoints";
import { MODEL_IMAGE_LIMITS } from "@/lib/gemini-config";
import { normalizeModel } from "@/lib/model-capabilities";
import type { PromptWithKey } from "@/lib/prompt-gallery-data";

type DialogState = { type: "crop" | "split" | "upscale" | "angle"; nodeId: string; source: string } | null;

type HistorySnapshot = { nodes: CanvasNodeData[]; connections: CanvasConnection[] };
type PairwiseQueueStats = { running: number; queued: number; total: number; active: boolean };
type PairwiseQueueControl = { cancelled: boolean; paused?: boolean; nodeIds: string[]; cancelledNodeIds: Set<string> };

type CanvasEditorProps = {
  projectId: string;
  onBack: () => void;
  onRequireApiKey: () => void;
  onQueueStatsChange?: (stats: { running: number; queued: number; total: number; active: boolean }) => void;
  showToast: (message: string, type: "success" | "error" | "info") => void;
};

const MAX_HISTORY = 50;
const RESULT_GRID_X_OFFSET = 96;
const RESULT_GRID_COLUMN_GAP = 420;
const RESULT_GRID_ROW_GAP = 300;
const PAIRWISE_GALLERY_ROWS_PER_COLUMN = 15;
const PAIRWISE_GALLERY_GROUP_GAP_X = 240;
const PAIRWISE_GENERATION_CONCURRENCY = 10;
const CANVAS_MENTION_TOKEN_PATTERN = /@\[[^\]]+\]/g;
const ACTIVE_GENERATION_STATUSES = ["submitting", "queued", "processing", "loading"];
const PAIRWISE_QUEUE_BACKOFF_ERROR_PATTERN = /较多任务|排队|请求太频繁|频繁|rate.?limit|too many|queue/i;
const PAIRWISE_QUEUE_BACKOFF_MS = 15_000;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getResultGridColumns(count: number) {
  return count <= 2 ? 1 : 2;
}

function getResultNodePosition(sourceNode: CanvasNodeData, index: number, count: number, yOffset = 0): Position {
  const columns = getResultGridColumns(count);
  const rows = Math.ceil(count / columns);
  const column = index % columns;
  const row = Math.floor(index / columns);
  const centeredYOffset = rows > 1 ? ((rows - 1) * RESULT_GRID_ROW_GAP) / 2 : 0;
  return {
    x: sourceNode.position.x + sourceNode.width + RESULT_GRID_X_OFFSET + column * RESULT_GRID_COLUMN_GAP,
    y: sourceNode.position.y + yOffset - centeredYOffset + row * RESULT_GRID_ROW_GAP,
  };
}

function getPairwiseResultNodePosition(configNode: CanvasNodeData, inputNode: CanvasNodeData | undefined, index: number, count: number, sourceColumnOffset: number, indexInSource: number): Position {
  const resultWidth = 320;
  const resultHeight = 240;
  if (!inputNode) return getResultNodePosition(configNode, index, count);

  const isGalleryNode = Boolean(inputNode.metadata?.galleryImages?.length);
  if (isGalleryNode) {
    const configCenterX = configNode.position.x + configNode.width / 2;
    const inputCenterX = inputNode.position.x + inputNode.width / 2;
    const mirroredDistance = Math.max(configCenterX - inputCenterX, configNode.width / 2 + RESULT_GRID_X_OFFSET + resultWidth / 2);
    const column = Math.floor(indexInSource / PAIRWISE_GALLERY_ROWS_PER_COLUMN);
    const row = indexInSource % PAIRWISE_GALLERY_ROWS_PER_COLUMN;
    return {
      x: configCenterX + mirroredDistance - resultWidth / 2 + sourceColumnOffset + column * RESULT_GRID_COLUMN_GAP,
      y: inputNode.position.y + row * RESULT_GRID_ROW_GAP,
    };
  }

  const configCenterX = configNode.position.x + configNode.width / 2;
  const inputCenterX = inputNode.position.x + inputNode.width / 2;
  const inputCenterY = inputNode.position.y + inputNode.height / 2;
  const mirroredDistance = Math.max(configCenterX - inputCenterX, configNode.width / 2 + RESULT_GRID_X_OFFSET + resultWidth / 2);

  return {
    x: configCenterX + mirroredDistance - resultWidth / 2,
    y: inputCenterY - resultHeight / 2,
  };
}

function getCanvasMentionTokens(text: string) {
  return Array.from(new Set(text.match(CANVAS_MENTION_TOKEN_PATTERN) ?? []));
}

function preserveCanvasMentionTokens(original: string, optimized: string) {
  const missingTokens = getCanvasMentionTokens(original).filter((token) => !optimized.includes(token));
  if (!missingTokens.length) return optimized;
  const trimmedOptimized = optimized.trim();
  return `${missingTokens.join(" ")}${trimmedOptimized ? ` ${trimmedOptimized}` : ""}`;
}

function formatImageLabels(count: number) {
  const labels = Array.from({ length: count }, (_, index) => imageReferenceLabel(index));
  if (labels.length <= 1) return labels[0] || "模板参考图";
  return `${labels.slice(0, -1).join("、")}和${labels[labels.length - 1]}`;
}

function buildPromptGalleryCanvasPrompt(referenceImageCount: number) {
  const referenceLabels = formatImageLabels(referenceImageCount);
  const targetLabel = imageReferenceLabel(referenceImageCount);
  if (referenceImageCount <= 0) {
    return [
      `任务：以${targetLabel}中的角色/OC作为唯一身份来源，结合参考提示词生成画面。`,
      `目标角色图：${targetLabel}。优先保留该角色的脸型、五官、发型、发色、体型、服装、配饰、标志性特征和整体身份辨识度。`,
      "不要凭空替换角色身份，不要混合其他人物特征。",
    ].join("\n");
  }
  return [
    `任务：以${targetLabel}中的角色/OC作为唯一身份来源，将其角色特征覆盖到${referenceLabels}的模板画面中。`,
    `模板参考图：${referenceLabels}。只参考姿势、手势、口型、构图、镜头、背景、光影、材质、风格和行为。`,
    `目标角色图：${targetLabel}。优先保留该角色的脸型、五官、发型、发色、体型、服装、配饰、标志性特征和整体身份辨识度。`,
    "不要把模板参考图中的人物身份、脸、发型、服装或配饰当作最终角色来源，不要混合多个参考图的人物特征；除角色身份替换外，模板参考图的画面结构尽量保持不变。",
  ].join("\n");
}

function storedToMetadata(stored: UploadedImage | CanvasGeneratedImage, extra?: Partial<CanvasNodeMetadata>): CanvasNodeMetadata {
  return { status: "success", content: stored.url, storageKey: stored.storageKey, mimeType: stored.mimeType, naturalWidth: stored.width, naturalHeight: stored.height, bytes: stored.bytes, ...extra };
}

function storedToGalleryImage(stored: UploadedImage, asset: ImageAsset): CanvasGalleryImage {
  return {
    id: asset.id,
    name: asset.name,
    content: stored.url,
    storageKey: stored.storageKey,
    mimeType: stored.mimeType,
    naturalWidth: stored.width,
    naturalHeight: stored.height,
    bytes: stored.bytes,
    prompt: asset.prompt,
  };
}

async function importPromptGalleryImage(url: string, promptContent: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const stored = await uploadImage(blob);
    return {
      downloaded: true,
      metadata: storedToMetadata(stored, { prompt: promptContent, canvasRole: "reference" }),
      width: stored.width,
      height: stored.height,
    };
  } catch {
    return {
      downloaded: false,
      metadata: { status: "success" as const, content: url, prompt: promptContent, canvasRole: "reference" as const },
      width: 320,
      height: 240,
    };
  }
}

async function optimizeImportedPromptContent(prompt: PromptWithKey, referenceImageCount: number): Promise<{ content: string; optimized: boolean }> {
  const original = prompt.content.trim();
  const textModel = requireDefaultConfiguredTextModel("promptOptimize");
  if (!original) return { content: original, optimized: false };

  let output = "";
  let failed = false;
  const handle = streamPromptOptimize(
    {
      apiKey: textModel.apiKey,
      mode: "canvas-prompt-gallery-import",
      prompt: original,
      context: `当前模板包含 ${referenceImageCount} 张参考图。画布会在生成配置里单独放置模板参考图，并用“目标角色图”单独指定用户上传的目标角色/OC图。`,
    },
    {
      onDelta(token) { output += token; },
      onDone(fullText) { if (fullText.trim()) output = fullText; },
      onError() { failed = true; },
    },
    textModel.baseUrl,
  );
  await handle.promise;

  const content = output.trim();
  return failed || !content ? { content: original, optimized: false } : { content, optimized: true };
}

export function CanvasEditor({ projectId, onBack, onRequireApiKey, onQueueStatsChange, showToast }: CanvasEditorProps) {
  const theme = canvasTheme;
  const openProject = useCanvasStore((state) => state.openProject);
  const updateProject = useCanvasStore((state) => state.updateProject);
  const renameProject = useCanvasStore((state) => state.renameProject);
  const projectTitle = useCanvasStore((state) => state.projects.find((item) => item.id === projectId)?.title) ?? "画布";
  const defaultConfig = useCanvasConfigStore((state) => state.config);
  const setStoreConfig = useCanvasConfigStore((state) => state.setConfig);

  const project = useMemo(() => openProject(projectId), [openProject, projectId]);

  const [nodes, setNodes] = useState<CanvasNodeData[]>(() => project?.nodes ?? []);
  const [connections, setConnections] = useState<CanvasConnection[]>(() => project?.connections ?? []);
  const [viewport, setViewport] = useState<ViewportTransform>(() => project?.viewport ?? { x: 0, y: 0, k: 1 });
  const [backgroundMode, setBackgroundMode] = useState(project?.backgroundMode ?? "lines");
  const [showImageInfo, setShowImageInfo] = useState(project?.showImageInfo ?? false);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<string[]>([]);
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
  const [renameNodeDraft, setRenameNodeDraft] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [connecting, setConnecting] = useState<{ handle: ConnectionHandle; mouseWorld: Position; targetId?: string } | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [busyNodeIds, setBusyNodeIds] = useState<string[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [assetPicker, setAssetPicker] = useState<{ open: boolean; nodeId: string | null }>({ open: false, nodeId: null });
  const [textAssetPicker, setTextAssetPicker] = useState<{ open: boolean; nodeId: string | null }>({ open: false, nodeId: null });
  const [promptGalleryOpen, setPromptGalleryOpen] = useState(false);
  const [promptGalleryImporting, setPromptGalleryImporting] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 1280, height: 720 });
  const [miniMapOpen, setMiniMapOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [replaceConfirm, setReplaceConfirm] = useState<{ nodeId: string; stored: UploadedImage; title?: string } | null>(null);
  const [textReplaceConfirm, setTextReplaceConfirm] = useState<{ nodeId: string; content: string } | null>(null);
  const [fullscreenImageUrl, setFullscreenImageUrl] = useState<{ src: string; title: string; actionPayload?: ImageActionPayload } | null>(null);
  const [nodeZIndexMap, setNodeZIndexMap] = useState<Record<string, number>>({});
  const [saveFeedbackVisible, setSaveFeedbackVisible] = useState(false);
  const topZIndexRef = useRef(1);

  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);
  const interaction = useRef<
    | { kind: "drag"; startX: number; startY: number; origin: Map<string, Position> }
    | { kind: "connect"; handle: ConnectionHandle }
    | { kind: "selection"; additive: boolean; initial: string[] }
    | { kind: "resize"; nodeId: string; corner: ResizeCorner; startX: number; startY: number; width: number; height: number; pos: Position }
    | null
  >(null);
  const gestureActive = useRef(false);
  const clipboard = useRef<CanvasNodeData[]>([]);
  const activeGenerationsRef = useRef<Map<string, AbortController>>(new Map());
  const pairwiseQueuesRef = useRef<Map<string, PairwiseQueueControl>>(new Map());
  const retryCooldownRef = useRef<Map<string, number>>(new Map());
  const saveFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [undoStack, setUndoStack] = useState<HistorySnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<HistorySnapshot[]>([]);
  const [pairwiseQueueStats, setPairwiseQueueStats] = useState<Record<string, PairwiseQueueStats>>({});

  // 提示词优化（结合连接的上游图片/文字引用）
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizedText, setOptimizedText] = useState("");
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const [optimizeNodeId, setOptimizeNodeId] = useState<string | null>(null);
  const [optimizeOriginalPrompt, setOptimizeOriginalPrompt] = useState("");
  const optimizeHandleRef = useRef<StreamPromptOptimizeHandle | null>(null);

  // ---- persistence: sync local state to store (store debounces IndexedDB writes) ----
  useEffect(() => {
    if (!project) return;
    updateProject(projectId, { nodes, connections, viewport, backgroundMode, showImageInfo });
  }, [nodes, connections, viewport, backgroundMode, showImageInfo, project, projectId, updateProject]);

  // ---- resolve image blob URLs for nodes that only have a storageKey ----
  useEffect(() => {
    let cancelled = false;
    const missingKeys = new Map<string, string>();
    for (const node of nodes) {
      if (node.type !== CanvasNodeType.Image) continue;
      if (node.metadata?.storageKey && !imageUrls[node.metadata.storageKey]) {
        const content = node.metadata?.content;
        missingKeys.set(node.metadata.storageKey, content && !content.startsWith("blob:") ? content : "");
      }
      for (const image of node.metadata?.galleryImages || []) {
        if (image.storageKey && !imageUrls[image.storageKey]) {
          const content = image.content;
          missingKeys.set(image.storageKey, content && !content.startsWith("blob:") ? content : "");
        }
      }
    }
    if (!missingKeys.size) return;
    void Promise.all(
      Array.from(missingKeys.entries()).map(async ([key, fallback]) => {
        // 持久化的 blob: URL 刷新后已失效，不能作为兜底（否则写回后仍 404）；优先从 IndexedDB 重建
        const url = await resolveImageUrl(key, fallback);
        return [key, url] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setImageUrls((prev) => {
        const next = { ...prev };
        for (const [key, url] of entries) if (url) next[key] = url;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [nodes, imageUrls]);

  // ---- viewport size tracking ----
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setViewportSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const nodeImageUrl = useCallback(
    (node: CanvasNodeData) => {
      const key = node.metadata?.storageKey;
      if (key && imageUrls[key]) return imageUrls[key];
      const content = node.metadata?.content;
      // 刷新后失效的 blob: URL 不渲染，等待 storageKey 异步解析重建，避免 ERR_FILE_NOT_FOUND
      if (content && content.startsWith("blob:")) return undefined;
      return content;
    },
    [imageUrls],
  );

  // ---- history helpers ----
  const snapshot = useCallback((): HistorySnapshot => ({ nodes: nodes.map((node) => ({ ...node, metadata: { ...node.metadata } })), connections: connections.map((connection) => ({ ...connection })) }), [nodes, connections]);
  const pushHistory = useCallback(() => {
    setUndoStack((stack) => {
      const next = [...stack, snapshot()];
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
    });
    setRedoStack([]);
  }, [snapshot]);
  const beginGesture = useCallback(() => {
    if (gestureActive.current) return;
    gestureActive.current = true;
    pushHistory();
  }, [pushHistory]);
  const undo = useCallback(() => {
    if (!undoStack.length) return;
    const previous = undoStack[undoStack.length - 1];
    setRedoStack((redo) => [...redo, snapshot()]);
    setUndoStack((stack) => stack.slice(0, -1));
    setNodes(previous.nodes);
    setConnections(previous.connections);
  }, [snapshot, undoStack]);
  const redo = useCallback(() => {
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack((stack) => [...stack, snapshot()]);
    setRedoStack((redo) => redo.slice(0, -1));
    setNodes(next.nodes);
    setConnections(next.connections);
  }, [snapshot, redoStack]);

  const saveCanvas = useCallback(async () => {
    updateProject(projectId, { nodes, connections, viewport, backgroundMode, showImageInfo });
    await flushCanvasStoreSave();
    setSaveFeedbackVisible(true);
    if (saveFeedbackTimerRef.current) clearTimeout(saveFeedbackTimerRef.current);
    saveFeedbackTimerRef.current = setTimeout(() => {
      setSaveFeedbackVisible(false);
      saveFeedbackTimerRef.current = null;
    }, 1600);
  }, [backgroundMode, connections, nodes, projectId, showImageInfo, updateProject, viewport]);

  useEffect(() => {
    return () => {
      if (saveFeedbackTimerRef.current) clearTimeout(saveFeedbackTimerRef.current);
    };
  }, []);

  const worldFromClient = useCallback(
    (clientX: number, clientY: number): Position => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (clientX - rect.left - viewport.x) / viewport.k, y: (clientY - rect.top - viewport.y) / viewport.k };
    },
    [viewport],
  );

  const viewportCenterWorld = useCallback((): Position => {
    return { x: (viewportSize.width / 2 - viewport.x) / viewport.k, y: (viewportSize.height / 2 - viewport.y) / viewport.k };
  }, [viewport, viewportSize]);

  // ---- node mutations ----
  const patchNode = useCallback((nodeId: string, patch: (node: CanvasNodeData) => CanvasNodeData) => {
    setNodes((prev) => prev.map((node) => (node.id === nodeId ? patch(node) : node)));
  }, []);

  const startRenameNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((item) => item.id === nodeId);
      if (!node) return;
      setSelectedIds([nodeId]);
      setSelectedConnectionIds([]);
      setRenamingNodeId(nodeId);
      setRenameNodeDraft(node.title);
    },
    [nodes],
  );

  const nodeGalleryImageUrls = useCallback(
    (node: CanvasNodeData) => {
      return (node.metadata?.galleryImages || []).map((image) => {
        if (image.storageKey && imageUrls[image.storageKey]) return imageUrls[image.storageKey];
        const content = image.content;
        if (content && !content.startsWith("blob:")) return content;
        return "";
      });
    },
    [imageUrls],
  );

  const commitRenameNode = useCallback(() => {
    if (!renamingNodeId) return;
    const node = nodes.find((item) => item.id === renamingNodeId);
    if (!node) {
      setRenamingNodeId(null);
      setRenameNodeDraft("");
      return;
    }
    const nextTitle = renameNodeDraft.trim();
    if (nextTitle && nextTitle !== node.title) {
      pushHistory();
      patchNode(renamingNodeId, (item) => ({ ...item, title: nextTitle }));
    }
    setRenamingNodeId(null);
    setRenameNodeDraft("");
  }, [nodes, patchNode, pushHistory, renameNodeDraft, renamingNodeId]);

  const cancelRenameNode = useCallback(() => {
    setRenamingNodeId(null);
    setRenameNodeDraft("");
  }, []);

  const createImageNode = useCallback((position: Position, partial?: Partial<CanvasNodeData>): CanvasNodeData => {
    const spec = getNodeSpec(CanvasNodeType.Image);
    return { id: nanoid(), type: CanvasNodeType.Image, title: spec.title, position, width: spec.width, height: spec.height, metadata: { status: "idle" }, ...partial };
  }, []);

  const createTextNode = useCallback((position: Position, content: string): CanvasNodeData => {
    const spec = getNodeSpec(CanvasNodeType.Text);
    return {
      id: nanoid(),
      type: CanvasNodeType.Text,
      title: spec.title,
      position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
      width: spec.width,
      height: spec.height,
      metadata: { ...spec.metadata, content },
    };
  }, []);

  const addNode = useCallback(
    (type: CanvasNodeType) => {
      pushHistory();
      const spec = getNodeSpec(type);
      const center = viewportCenterWorld();
      const metadata: CanvasNodeMetadata = { ...spec.metadata };
      if (type === CanvasNodeType.Config) metadata.genConfig = defaultConfig;
      const node: CanvasNodeData = {
        id: nanoid(),
        type,
        title: spec.title,
        position: { x: center.x - spec.width / 2, y: center.y - spec.height / 2 },
        width: spec.width,
        height: spec.height,
        metadata,
      };
      setNodes((prev) => [...prev, node]);
      setSelectedIds([node.id]);
      setSelectedConnectionIds([]);
    },
    [defaultConfig, pushHistory, viewportCenterWorld],
  );

  const deleteNodes = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      pushHistory();
      const idSet = new Set(ids);
      setNodes((prev) => prev.filter((node) => !idSet.has(node.id)));
      setConnections((prev) => prev.filter((connection) => !idSet.has(connection.fromNodeId) && !idSet.has(connection.toNodeId)));
      setSelectedIds((prev) => prev.filter((id) => !idSet.has(id)));
      setSelectedConnectionIds((prev) => prev.filter((id) => connections.some((connection) => connection.id === id && !idSet.has(connection.fromNodeId) && !idSet.has(connection.toNodeId))));
    },
    [connections, pushHistory],
  );

  const deleteConnections = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      const idSet = new Set(ids);
      pushHistory();
      setConnections((prev) => prev.filter((connection) => !idSet.has(connection.id)));
      setSelectedConnectionIds((prev) => prev.filter((id) => !idSet.has(id)));
    },
    [pushHistory],
  );

  const deleteSelection = useCallback(() => {
    if (!selectedIds.length && !selectedConnectionIds.length) return;
    const nodeIdSet = new Set(selectedIds);
    const connectionIdSet = new Set(selectedConnectionIds);
    pushHistory();
    setNodes((prev) => prev.filter((node) => !nodeIdSet.has(node.id)));
    setConnections((prev) => prev.filter((connection) => !connectionIdSet.has(connection.id) && !nodeIdSet.has(connection.fromNodeId) && !nodeIdSet.has(connection.toNodeId)));
    setSelectedIds([]);
    setSelectedConnectionIds([]);
  }, [pushHistory, selectedConnectionIds, selectedIds]);

  const duplicateNodes = useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids);
      const sources = nodes.filter((node) => idSet.has(node.id));
      if (!sources.length) return;
      pushHistory();
      const clones = sources.map((node) => ({ ...node, id: nanoid(), position: { x: node.position.x + 32, y: node.position.y + 32 }, metadata: { ...node.metadata } }));
      setNodes((prev) => [...prev, ...clones]);
      setSelectedIds(clones.map((node) => node.id));
      setSelectedConnectionIds([]);
    },
    [nodes, pushHistory],
  );

  // ---- image source: upload / asset library / save to assets ----
  const fillNodeWithStored = useCallback(
    (nodeId: string, stored: UploadedImage, title?: string) => {
      pushHistory();
      const size = fitNodeSize(stored.width, stored.height, 360, 360);
      const nextTitle = title?.trim();
      patchNode(nodeId, (node) => ({ ...node, title: nextTitle || node.title, width: size.width, height: size.height, metadata: { ...node.metadata, ...storedToMetadata(stored), galleryImages: undefined } }));
    },
    [patchNode, pushHistory],
  );

  // 填充前若已有图片，先弹「是否替换」确认。
  const fillNodeWithConfirm = useCallback(
    (nodeId: string, stored: UploadedImage, title?: string) => {
      const node = nodes.find((item) => item.id === nodeId);
      if (node?.metadata?.content) {
        setReplaceConfirm({ nodeId, stored, title });
        return;
      }
      fillNodeWithStored(nodeId, stored, title);
    },
    [fillNodeWithStored, nodes],
  );

  // 仅删除节点内图片（保留节点，回到空态）。
  const clearNodeImage = useCallback(
    (nodeId: string) => {
      pushHistory();
      patchNode(nodeId, (node) => ({ ...node, metadata: { status: "idle", ...(node.metadata?.canvasRole === "target" ? { canvasRole: "target" as const } : {}) } }));
    },
    [patchNode, pushHistory],
  );

  const ingestFiles = useCallback(
    async (files: FileList | File[], position?: Position) => {
      const list = Array.from(files).filter((file) => file.type.startsWith("image/"));
      if (!list.length) return;
      pushHistory();
      const base = position ?? viewportCenterWorld();
      let offset = 0;
      for (const file of list) {
        try {
          const dataUrl = await readFileAsDataUrl(file);
          const stored = await uploadImage(dataUrl);
          const size = fitNodeSize(stored.width, stored.height, 320, 320);
          const node = createImageNode({ x: base.x + offset, y: base.y + offset }, { metadata: storedToMetadata(stored), width: size.width, height: size.height });
          setNodes((prev) => [...prev, node]);
          offset += 28;
        } catch {
          showToast("图片读取失败", "error");
        }
      }
    },
    [createImageNode, pushHistory, showToast, viewportCenterWorld],
  );

  const handleNodeUpload = useCallback((nodeId: string) => {
    uploadTargetRef.current = nodeId;
    fileInputRef.current?.click();
  }, []);

  const handleNodeImport = useCallback((nodeId: string) => {
    setAssetPicker({ open: true, nodeId });
  }, []);

  const handleTextNodeImport = useCallback((nodeId: string) => {
    setTextAssetPicker({ open: true, nodeId });
  }, []);

  const handleAssetPickerConfirm = useCallback(
    async (assets: ImageAsset[], options?: { mergeIntoGallery: boolean }) => {
      const targetId = assetPicker.nodeId;
      if (!assets.length || !targetId) return;
      try {
        const imported: Array<{ asset: ImageAsset; stored: UploadedImage; gallery: CanvasGalleryImage }> = [];
        for (const asset of assets) {
          const blob = await getAssetBlob(asset.id);
          if (!blob) continue;
          const stored = await uploadImage(blob);
          imported.push({ asset, stored, gallery: storedToGalleryImage(stored, asset) });
        }
        if (!imported.length) {
          showToast("素材读取失败", "error");
          return;
        }
        if (imported.length === 1) {
          const only = imported[0];
          fillNodeWithConfirm(targetId, only.stored, only.asset.name);
          return;
        }
        if (options?.mergeIntoGallery === false) {
          const targetNode = nodes.find((node) => node.id === targetId);
          const base = targetNode ? {
            x: targetNode.position.x + targetNode.width + 72,
            y: targetNode.position.y,
          } : viewportCenterWorld();
          const [targetImport, ...remainingImports] = imported;
          const cols = remainingImports.length > 6 ? 3 : 2;
          const gapX = 360;
          const gapY = 300;
          const newNodes = remainingImports.map((item, index): CanvasNodeData => {
            const size = fitNodeSize(item.stored.width, item.stored.height, 320, 320);
            return createImageNode(
              {
                x: base.x + (index % cols) * gapX,
                y: base.y + Math.floor(index / cols) * gapY,
              },
              {
                title: item.asset.name,
                width: size.width,
                height: size.height,
                metadata: storedToMetadata(item.stored, { prompt: item.asset.prompt }),
              },
            );
          });
          const targetSize = fitNodeSize(targetImport.stored.width, targetImport.stored.height, 320, 320);
          pushHistory();
          setNodes((prev) => [
            ...prev.map((node) => (
              node.id === targetId
                ? {
                    ...node,
                    title: targetImport.asset.name,
                    width: targetSize.width,
                    height: targetSize.height,
                    metadata: {
                      ...node.metadata,
                      ...storedToMetadata(targetImport.stored, { prompt: targetImport.asset.prompt }),
                      galleryImages: undefined,
                      assetFolderId: undefined,
                      assetFolderName: undefined,
                    },
                  }
                : node
            )),
            ...newNodes,
          ]);
          setSelectedIds([targetId, ...newNodes.map((node) => node.id)]);
          setSelectedConnectionIds([]);
          showToast(`已导入 ${imported.length} 张图片`, "success");
          return;
        }
        pushHistory();
        patchNode(targetId, (node) => ({
          ...node,
          title: "图片集合",
          width: Math.max(node.width, 520),
          height: Math.max(node.height, 360),
          metadata: {
            ...node.metadata,
            status: "success",
            content: undefined,
            storageKey: undefined,
            mimeType: undefined,
            naturalWidth: undefined,
            naturalHeight: undefined,
            bytes: undefined,
            galleryImages: imported.map((item) => item.gallery),
          },
        }));
      } catch {
        showToast("从素材库导入失败", "error");
      }
    },
    [assetPicker.nodeId, createImageNode, fillNodeWithConfirm, nodes, patchNode, pushHistory, showToast, viewportCenterWorld],
  );

  const handleAssetFolderPickerConfirm = useCallback(
    async (folder: AssetFolder, folderAssets: ImageAsset[]) => {
      if (!folderAssets.length) return;
      const targetId = assetPicker.nodeId;
      if (!targetId) return;
      const imported: CanvasGalleryImage[] = [];

      try {
        for (const asset of folderAssets) {
          const blob = await getAssetBlob(asset.id);
          if (!blob) continue;
          imported.push(storedToGalleryImage(await uploadImage(blob), asset));
        }
        if (!imported.length) {
          showToast("素材读取失败", "error");
          return;
        }

        pushHistory();
        patchNode(targetId, (node) => ({
          ...node,
          title: folder.name,
          width: Math.max(node.width, 560),
          height: Math.max(node.height, 380),
          metadata: {
            ...node.metadata,
            status: "success",
            content: undefined,
            storageKey: undefined,
            mimeType: undefined,
            naturalWidth: undefined,
            naturalHeight: undefined,
            bytes: undefined,
            prompt: undefined,
            galleryImages: imported,
            assetFolderId: folder.id,
            assetFolderName: folder.name,
          },
        }));
        setSelectedIds([targetId]);
        setSelectedConnectionIds([]);
        showToast(`已从文件夹 ${folder.name} 导入 ${imported.length} 张图片`, "success");
      } catch {
        showToast("从素材库导入文件夹失败", "error");
      }
    },
    [assetPicker.nodeId, patchNode, pushHistory, showToast],
  );

  const fillTextNode = useCallback(
    (nodeId: string, content: string) => {
      pushHistory();
      patchNode(nodeId, (node) => ({ ...node, metadata: { ...node.metadata, content } }));
    },
    [patchNode, pushHistory],
  );

  const fillTextNodeWithConfirm = useCallback(
    (nodeId: string, content: string) => {
      const node = nodes.find((item) => item.id === nodeId);
      const current = (node?.metadata?.content || "").trim();
      if (current && current !== content.trim()) {
        setTextReplaceConfirm({ nodeId, content });
        return;
      }
      fillTextNode(nodeId, content);
    },
    [fillTextNode, nodes],
  );

  const handleTextAssetPickerConfirm = useCallback(
    (asset: TextAsset) => {
      const targetId = textAssetPicker.nodeId;
      if (!targetId) return;
      fillTextNodeWithConfirm(targetId, asset.content);
    },
    [fillTextNodeWithConfirm, textAssetPicker.nodeId],
  );

  const handleSaveTextToAssets = useCallback(
    async (node: CanvasNodeData) => {
      const content = (node.metadata?.content || "").trim();
      if (!content) return;
      try {
        await addTextAsset({
          content,
          sourceKind: 'manual',
          sourceLabel: '无限画布',
          sourceRef: node.id,
        });
        showToast("提示词素材已保存", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "保存提示词素材失败", "error");
      }
    },
    [showToast],
  );

  const importPromptGalleryTemplate = useCallback(
    async (prompt: PromptWithKey) => {
      if (promptGalleryImporting) return;
      setPromptGalleryImporting(true);
      try {
        const imageUrls = prompt.images.filter(Boolean);
        const optimizedPrompt = await optimizeImportedPromptContent(prompt, imageUrls.length);
        const promptContent = optimizedPrompt.content || prompt.content;
        const importedImages = await Promise.all(imageUrls.map((url) => importPromptGalleryImage(url, promptContent)));
        const failedCount = importedImages.filter((image) => !image.downloaded).length;
        const center = viewportCenterWorld();
        const cols = imageUrls.length > 4 ? 3 : 2;
        const cellWidth = 280;
        const cellHeight = 260;
        const baseX = center.x - (cols * cellWidth + 540) / 2;
        const baseY = center.y - 220;
        const positionForInput = (index: number): Position => ({
          x: baseX + (index % cols) * cellWidth,
          y: baseY + Math.floor(index / cols) * cellHeight,
        });

        const referenceNodes = importedImages.map((image, index) => {
          const size = fitNodeSize(image.width, image.height, 240, 240);
          return createImageNode(positionForInput(index), {
            title: `参考图 ${index + 1}`,
            width: size.width,
            height: size.height,
            metadata: image.metadata,
          });
        });

        const targetNode = createImageNode(positionForInput(referenceNodes.length), {
          title: "目标人物/OC图",
          width: 260,
          height: 220,
          metadata: { status: "idle", canvasRole: "target" },
        });

        const inputRows = Math.max(1, Math.ceil((referenceNodes.length + 1) / cols));
        const textNode: CanvasNodeData = {
          id: nanoid(),
          type: CanvasNodeType.Text,
          title: "参考提示词",
          position: { x: baseX, y: baseY + inputRows * cellHeight + 36 },
          width: Math.max(340, cols * cellWidth - 24),
          height: 200,
          metadata: { content: promptContent, status: "idle", fontSize: 14, canvasRole: "reference-prompt" },
        };

        const upstreamNodes = [...referenceNodes, targetNode, textNode];
        const referenceTokens = referenceNodes.map((node) => `@[node:${node.id}]`).join(" ");
        const promptToken = `@[node:${textNode.id}]`;
        const targetToken = `@[node:${targetNode.id}]`;
        const composerContent = [
          referenceTokens ? `模板参考图：${referenceTokens}` : "",
          `参考提示词：${promptToken}`,
          `目标角色图：${targetToken}`,
          "",
          buildPromptGalleryCanvasPrompt(referenceNodes.length),
        ].join("\n");
        const configSpec = getNodeSpec(CanvasNodeType.Config);
        const configNode: CanvasNodeData = {
          id: nanoid(),
          type: CanvasNodeType.Config,
          title: "提示词广场生成配置",
          position: { x: baseX + cols * cellWidth + 96, y: baseY },
          width: configSpec.width,
          height: configSpec.height,
          metadata: {
            ...configSpec.metadata,
            genConfig: defaultConfig,
            composerContent,
          },
        };
        const newConnections = upstreamNodes.map((node) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id }));

        pushHistory();
        setNodes((prev) => [...prev, ...upstreamNodes, configNode]);
        setConnections((prev) => [...prev, ...newConnections]);
        setSelectedIds([configNode.id]);
        setPromptGalleryOpen(false);
        showToast(
          failedCount > 0
            ? `已导入模板，${failedCount} 张参考图使用远程 URL 兜底`
            : optimizedPrompt.optimized
              ? "已从提示词广场导入并优化提示词"
              : "已从提示词广场导入模板",
          "success",
        );
      } catch {
        showToast("从提示词广场导入失败", "error");
      } finally {
        setPromptGalleryImporting(false);
      }
    },
    [createImageNode, defaultConfig, promptGalleryImporting, pushHistory, showToast, viewportCenterWorld],
  );

  const saveImageNodeToAssets = useCallback(
    async (node: CanvasNodeData) => {
      if (node.metadata?.galleryImages?.length) {
        let savedCount = 0;
        for (const image of node.metadata.galleryImages) {
          const key = image.storageKey;
          let blob: Blob | null = key ? await getImageBlob(key) : null;
          if (!blob && image.content) blob = await (await fetch(image.content)).blob();
          if (!blob) continue;
          await addImageAsset({
            blob,
            sourceKind: "manual",
            sourceLabel: "无限画布",
            name: image.name,
            prompt: image.prompt || node.metadata?.prompt,
            folderId: node.metadata?.assetFolderId,
          });
          savedCount++;
        }
        return savedCount;
      }

      const key = node.metadata?.storageKey;
      let blob: Blob | null = key ? await getImageBlob(key) : null;
      if (!blob) {
        const url = nodeImageUrl(node);
        if (url) blob = await (await fetch(url)).blob();
      }
      if (!blob) return 0;
      await addImageAsset({ blob, sourceKind: "manual", sourceLabel: "无限画布", name: node.title, prompt: node.metadata?.prompt });
      return 1;
    },
    [nodeImageUrl],
  );

  const handleSaveToAssets = useCallback(
    async (node: CanvasNodeData) => {
      try {
        const savedCount = await saveImageNodeToAssets(node);
        showToast(savedCount ? (savedCount > 1 ? `已存入 ${savedCount} 张素材` : "已存入我的素材") : "无法读取图片", savedCount ? "success" : "error");
      } catch {
        showToast("存入素材失败", "error");
      }
    },
    [saveImageNodeToAssets, showToast],
  );

  const selectedImportableImageCount = useMemo(
    () => nodes.filter((node) => selectedIds.includes(node.id) && node.type === CanvasNodeType.Image && (node.metadata?.galleryImages?.length || node.metadata?.storageKey || node.metadata?.content)).length,
    [nodes, selectedIds],
  );

  const handleToolbarImportToAssets = useCallback(async () => {
    const selectedImageNodes = nodes.filter((node) => selectedIds.includes(node.id) && node.type === CanvasNodeType.Image && (node.metadata?.galleryImages?.length || node.metadata?.storageKey || node.metadata?.content));
    const configNodeIds = new Set(nodes.filter((node) => node.type === CanvasNodeType.Config).map((node) => node.id));
    const generatedImageNodeIds = new Set(connections.filter((connection) => configNodeIds.has(connection.fromNodeId)).map((connection) => connection.toNodeId));
    const targetNodes = selectedImageNodes.length > 0
      ? selectedImageNodes
      : nodes.filter((node) => node.type === CanvasNodeType.Image && generatedImageNodeIds.has(node.id) && !node.metadata?.galleryImages?.length && node.metadata?.status === "success" && (node.metadata?.storageKey || node.metadata?.content));

    if (targetNodes.length === 0) {
      showToast(selectedIds.length > 0 ? "选中的图片节点没有可导入图片" : "没有可导入的生成图片", "info");
      return;
    }

    try {
      let savedCount = 0;
      for (const node of targetNodes) savedCount += await saveImageNodeToAssets(node);
      showToast(savedCount ? `已导入 ${savedCount} 张图片到素材` : "无法读取图片", savedCount ? "success" : "error");
    } catch {
      showToast("导入素材失败", "error");
    }
  }, [connections, nodes, saveImageNodeToAssets, selectedIds, showToast]);

  // ---- generation (编排节点 → 输出图片节点；走宿主任务队列；逐节点独立并发) ----
  const setBusy = useCallback((nodeId: string, busy: boolean) => {
    setBusyNodeIds((prev) => (busy ? [...new Set([...prev, nodeId])] : prev.filter((id) => id !== nodeId)));
  }, []);

  const getConfigReferenceLimit = useCallback(
    (configNode: CanvasNodeData) => {
      const promptText = configNode.metadata?.composerContent ?? configNode.metadata?.prompt ?? "";
      const genConfig: CanvasGenerationConfig = configNode.metadata?.genConfig ?? defaultConfig;
      const model = normalizeModel(genConfig.model);
      const max = MODEL_IMAGE_LIMITS[model]?.max || 1;
      const context = buildNodeGenerationContext(configNode.id, nodes, connections, promptText);
      return { imageCount: context.imageCount, max, exceeded: context.imageCount > max };
    },
    [connections, defaultConfig, nodes],
  );

  const getConfigPairwiseInfo = useCallback(
    (configNode: CanvasNodeData) => {
      const count = buildNodeGenerationInputs(configNode.id, nodes, connections).filter((input) => input.type === "image" && input.image).length;
      return { count, available: count > 1 };
    },
    [connections, nodes],
  );

  const updatePairwiseQueueStats = useCallback((nodeId: string, patch: Partial<PairwiseQueueStats> | ((current: PairwiseQueueStats) => PairwiseQueueStats)) => {
    setPairwiseQueueStats((prev) => {
      const current = prev[nodeId] || { running: 0, queued: 0, total: 0, active: false };
      const next = typeof patch === "function" ? patch(current) : { ...current, ...patch };
      return { ...prev, [nodeId]: next };
    });
  }, []);

  const clearPairwiseQueueStats = useCallback((nodeId: string) => {
    setPairwiseQueueStats((prev) => {
      if (!prev[nodeId]) return prev;
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
  }, []);

  const cancelBackendTasksForNodeIds = useCallback((nodeIds: Iterable<string>) => {
    const nodeIdSet = new Set(nodeIds);
    const taskIds = Array.from(new Set(
      nodes
        .filter((node) => nodeIdSet.has(node.id))
        .map((node) => node.metadata?.generationTaskId)
        .filter((taskId): taskId is string => Boolean(taskId)),
    ));
    if (!taskIds.length) return;
    void Promise.all(taskIds.map((taskId) => cancelNodeTask(taskId)));
  }, [nodes]);

  const cancelGenerationForConfig = useCallback((configNodeId: string) => {
    const queue = pairwiseQueuesRef.current.get(configNodeId);
    if (queue) {
      queue.cancelled = true;
      cancelBackendTasksForNodeIds(queue.nodeIds);
      for (const nodeId of queue.nodeIds) activeGenerationsRef.current.get(nodeId)?.abort();
      const queueNodeIds = new Set(queue.nodeIds);
      setNodes((prev) => prev.map((node) => (
        queueNodeIds.has(node.id) && ["submitting", "queued", "processing", "loading"].includes(node.metadata?.status || "")
          ? { ...node, metadata: { ...node.metadata, status: "error", errorDetails: "已终止", generationTaskId: undefined, generationStartedAt: undefined } }
          : node
      )));
      pairwiseQueuesRef.current.delete(configNodeId);
      clearPairwiseQueueStats(configNodeId);
      setBusy(configNodeId, false);
      showToast("已终止当前生成和排队任务", "info");
      return;
    }

    const activeTargetIds = connections
      .filter((connection) => connection.fromNodeId === configNodeId)
      .map((connection) => connection.toNodeId);
    cancelBackendTasksForNodeIds(activeTargetIds);
    for (const nodeId of activeTargetIds) activeGenerationsRef.current.get(nodeId)?.abort();
    const activeTargetIdSet = new Set(activeTargetIds);
    setNodes((prev) => prev.map((node) => (
      activeTargetIdSet.has(node.id) && ["submitting", "queued", "processing", "loading"].includes(node.metadata?.status || "")
        ? { ...node, metadata: { ...node.metadata, status: "error", errorDetails: "已终止", generationTaskId: undefined, generationStartedAt: undefined } }
        : node
    )));
    setBusy(configNodeId, false);
    showToast("已终止当前生成", "info");
  }, [cancelBackendTasksForNodeIds, clearPairwiseQueueStats, connections, setBusy, showToast]);

  const cancelAllGeneration = useCallback(() => {
    const activeNodeIds = Array.from(activeGenerationsRef.current.keys());
    const cancellableNodeIds = nodes
      .filter((node) => ACTIVE_GENERATION_STATUSES.includes(node.metadata?.status || ""))
      .map((node) => node.id);
    const cancelledNodeIds = new Set<string>([...activeNodeIds, ...cancellableNodeIds]);
    cancelBackendTasksForNodeIds(cancelledNodeIds);
    for (const controller of activeGenerationsRef.current.values()) controller.abort();
    activeGenerationsRef.current.clear();

    for (const queue of pairwiseQueuesRef.current.values()) {
      queue.cancelled = true;
      for (const nodeId of queue.nodeIds) cancelledNodeIds.add(nodeId);
    }
    pairwiseQueuesRef.current.clear();
    setPairwiseQueueStats({});
    setBusyNodeIds([]);

    setNodes((prev) => prev.map((node) => (
      ACTIVE_GENERATION_STATUSES.includes(node.metadata?.status || "")
        ? { ...node, metadata: { ...node.metadata, status: "error", errorDetails: "已终止", generationTaskId: undefined, generationStartedAt: undefined } }
        : node
    )));
    showToast(cancelledNodeIds.size > 0 ? "已终止全部生成和排队任务" : "当前没有生成任务", "info");
  }, [cancelBackendTasksForNodeIds, nodes, showToast]);

  const cancelSelectedGeneration = useCallback((targetNodeIds: string[]) => {
    const targetSet = new Set(targetNodeIds);
    if (!targetSet.size) return false;

    const cancelledNodeIds = new Set<string>();
    const queuedCancelledByConfig = new Map<string, number>();
    const runningCancelledByConfig = new Map<string, number>();
    cancelBackendTasksForNodeIds(targetSet);
    for (const node of nodes) {
      if (targetSet.has(node.id) && (node.metadata?.generationTaskId || ACTIVE_GENERATION_STATUSES.includes(node.metadata?.status || ""))) cancelledNodeIds.add(node.id);
    }
    for (const nodeId of targetSet) {
      const controller = activeGenerationsRef.current.get(nodeId);
      if (controller) {
        controller.abort();
        cancelledNodeIds.add(nodeId);
      }
    }

    for (const [configNodeId, queue] of pairwiseQueuesRef.current.entries()) {
      for (const nodeId of queue.nodeIds) {
        if (!targetSet.has(nodeId) || queue.cancelledNodeIds.has(nodeId)) continue;
        queue.cancelledNodeIds.add(nodeId);
        if (!activeGenerationsRef.current.has(nodeId)) {
          queuedCancelledByConfig.set(configNodeId, (queuedCancelledByConfig.get(configNodeId) || 0) + 1);
        } else {
          runningCancelledByConfig.set(configNodeId, (runningCancelledByConfig.get(configNodeId) || 0) + 1);
        }
        cancelledNodeIds.add(nodeId);
      }
    }

    for (const configNodeId of new Set([...queuedCancelledByConfig.keys(), ...runningCancelledByConfig.keys()])) {
      const queuedCount = queuedCancelledByConfig.get(configNodeId) || 0;
      const runningCount = runningCancelledByConfig.get(configNodeId) || 0;
      updatePairwiseQueueStats(configNodeId, (current) => ({
        ...current,
        running: Math.max(0, current.running - runningCount),
        queued: Math.max(0, current.queued - queuedCount),
      }));
    }

    if (cancelledNodeIds.size <= 0) return false;
    setNodes((prev) => prev.map((node) => (
      targetSet.has(node.id) && ACTIVE_GENERATION_STATUSES.includes(node.metadata?.status || "")
        ? { ...node, metadata: { ...node.metadata, status: "error", errorDetails: "已终止", generationTaskId: undefined, generationStartedAt: undefined } }
        : node
    )));
    showToast(`已终止选中的 ${cancelledNodeIds.size} 个生成任务`, "info");
    return true;
  }, [cancelBackendTasksForNodeIds, nodes, showToast, updatePairwiseQueueStats]);

  const cancelToolbarGeneration = useCallback(() => {
    const selectedGenerationNodeIds = nodes
      .filter((node) => selectedIds.includes(node.id) && ACTIVE_GENERATION_STATUSES.includes(node.metadata?.status || ""))
      .map((node) => node.id);
    if (selectedGenerationNodeIds.length && cancelSelectedGeneration(selectedGenerationNodeIds)) return;
    cancelAllGeneration();
  }, [cancelAllGeneration, cancelSelectedGeneration, nodes, selectedIds]);

  // 对单个结果图片节点启动独立生成任务（提交 + 轮询）。
  const startNodeGeneration = useCallback(
    async (nodeId: string, promptText: string, referenceImages: ReferenceImage[], genConfig: CanvasGenerationConfig, sourceNodeId: string, options?: { waitForCompletion?: boolean; throwOnSubmitError?: boolean }) => {
      // 取消该节点之前的任务（如有）
      cancelBackendTasksForNodeIds([nodeId]);
      activeGenerationsRef.current.get(nodeId)?.abort();
      const controller = new AbortController();
      activeGenerationsRef.current.set(nodeId, controller);

      // 立即标记节点为提交中状态（同步，确保 UI 即时更新）
      setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: "submitting", errorDetails: undefined, generationTaskId: undefined, generationStartedAt: Date.now() } } : node)));
      setBusy(sourceNodeId, true);

      try {
        const taskId = await submitNodeGeneration({ prompt: promptText, referenceImages, config: genConfig }, controller.signal);
        if (controller.signal.aborted) {
          void cancelNodeTask(taskId);
          return;
        }
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, generationTaskId: taskId, status: "queued" } } : node)));

        const pollPromise = (async () => {
          try {
            const images = await pollNodeTask(taskId, (taskStatus) => {
              if (controller.signal.aborted) return;
              setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: taskStatus as CanvasNodeMetadata["status"] } } : node)));
            }, controller.signal);

            if (controller.signal.aborted) return;
            const image = images[0];
            if (image) {
              const size = fitNodeSize(image.width, image.height, 360, 360);
              setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width: size.width, height: size.height, metadata: { ...node.metadata, ...storedToMetadata(image, { prompt: promptText }), generationTaskId: node.metadata?.generationTaskId, generationStartedAt: node.metadata?.generationStartedAt } } : node)));
            }
          } catch (error) {
            if (controller.signal.aborted) return;
            const message = error instanceof Error ? error.message : "生成失败";
            setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: "error", errorDetails: message } } : node)));
          } finally {
            activeGenerationsRef.current.delete(nodeId);
            if (!pairwiseQueuesRef.current.has(sourceNodeId)) {
              let hasActive = false;
              for (const key of activeGenerationsRef.current.keys()) {
                if (key === nodeId) continue;
                const n = nodes.find((item) => item.id === key);
                if (n && n.metadata?.generationStartedAt) { hasActive = true; break; }
              }
              if (!hasActive) setBusy(sourceNodeId, false);
            }
          }
        })();

        if (options?.waitForCompletion === false) {
          void pollPromise;
          return;
        }
        await pollPromise;
      } catch (error) {
        activeGenerationsRef.current.delete(nodeId);
        if (controller.signal.aborted) return;
        if (error instanceof CanvasApiKeyMissingError) {
          setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: "idle", generationTaskId: undefined, generationStartedAt: undefined } } : node)));
          onRequireApiKey();
        } else {
          const message = error instanceof Error ? error.message : "生成失败";
          setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: "error", errorDetails: message } } : node)));
        }
        if (!pairwiseQueuesRef.current.has(sourceNodeId)) setBusy(sourceNodeId, false);
        if (options?.throwOnSubmitError) throw error;
      }
    },
    [cancelBackendTasksForNodeIds, nodes, onRequireApiKey, setBusy],
  );

  const runGeneration = useCallback(
    async (sourceNode: CanvasNodeData) => {
      const promptText = (sourceNode.metadata?.composerContent ?? sourceNode.metadata?.prompt ?? "").trim();
      if (!promptText) { showToast("请输入提示词", "info"); return; }
      const genConfig: CanvasGenerationConfig = sourceNode.metadata?.genConfig ?? defaultConfig;
      const locked = Boolean(sourceNode.metadata?.lockResultNodes);
      const count = genConfig.count;
      const context = buildNodeGenerationContext(sourceNode.id, nodes, connections, promptText);
      const model = normalizeModel(genConfig.model);
      const maxReferenceImages = MODEL_IMAGE_LIMITS[model]?.max || 1;

      const pairwiseContexts = sourceNode.metadata?.pairwiseGeneration ? buildPairwiseGenerationContexts(sourceNode.id, nodes, connections, promptText) : [];
      if (pairwiseContexts.length > 1) {
        if (pairwiseContexts.some((item) => item.context.imageCount > maxReferenceImages)) {
          showToast("参考图超过模型限制", "error");
          return;
        }

        const pairwiseConfig: CanvasGenerationConfig = { ...genConfig, count: 1 };
        const sourceNodeIds = Array.from(new Set(pairwiseContexts.map((item) => item.input.nodeId)));
        const sourceTotals = new Map<string, number>();
        for (const item of pairwiseContexts) sourceTotals.set(item.input.nodeId, (sourceTotals.get(item.input.nodeId) || 0) + 1);
        const sourceColumnOffsets = new Map<string, number>();
        let nextSourceColumnOffset = 0;
        for (const sourceNodeId of sourceNodeIds) {
          sourceColumnOffsets.set(sourceNodeId, nextSourceColumnOffset);
          const inputNode = nodes.find((node) => node.id === sourceNodeId);
          const isGalleryNode = Boolean(inputNode?.metadata?.galleryImages?.length);
          const columns = isGalleryNode ? Math.ceil((sourceTotals.get(sourceNodeId) || 0) / PAIRWISE_GALLERY_ROWS_PER_COLUMN) : 1;
          nextSourceColumnOffset += columns * RESULT_GRID_COLUMN_GAP + PAIRWISE_GALLERY_GROUP_GAP_X;
        }
        const sourceCounts = new Map<string, number>();
        const planned = pairwiseContexts.map((item, index) => {
          const inputNode = nodes.find((node) => node.id === item.input.nodeId);
          const indexInSource = sourceCounts.get(item.input.nodeId) || 0;
          sourceCounts.set(item.input.nodeId, indexInSource + 1);
          const sourceColumnOffset = sourceColumnOffsets.get(item.input.nodeId) || 0;
          const node = createImageNode(
            getPairwiseResultNodePosition(sourceNode, inputNode, index, pairwiseContexts.length, sourceColumnOffset, indexInSource),
            { metadata: { status: "queued", pairwiseGenerationContext: item.context } },
          );
          return { item, node };
        });
        const newConnections = planned.map(({ node }) => ({ id: nanoid(), fromNodeId: sourceNode.id, toNodeId: node.id }));

        pushHistory();
        setNodes((prev) => [...prev, ...planned.map(({ node }) => node)]);
        setConnections((prev) => [...prev, ...newConnections]);
        setSelectedIds([sourceNode.id]);
        setSelectedConnectionIds([]);

        showToast(`已创建 ${planned.length} 个对应生成任务，最多同时提交 ${PAIRWISE_GENERATION_CONCURRENCY} 个`, "info");
        pairwiseQueuesRef.current.set(sourceNode.id, { cancelled: false, nodeIds: planned.map(({ node }) => node.id), cancelledNodeIds: new Set() });
        updatePairwiseQueueStats(sourceNode.id, { running: 0, queued: planned.length, total: planned.length, active: true });
        setBusy(sourceNode.id, true);
        const queue = [...planned];
        const workers = Array.from({ length: Math.min(PAIRWISE_GENERATION_CONCURRENCY, queue.length) }, async () => {
          while (queue.length) {
            const control = pairwiseQueuesRef.current.get(sourceNode.id);
            if (!control || control.cancelled) return;
            if (control.paused) {
              await wait(500);
              continue;
            }
            const next = queue.shift();
            if (!next) return;
            if (control.cancelledNodeIds.has(next.node.id)) continue;
            updatePairwiseQueueStats(sourceNode.id, (current) => ({ ...current, running: current.running + 1, queued: Math.max(0, current.queued - 1), active: true }));
            try {
              const hydrated = await hydrateNodeGenerationContext(next.item.context);
              const latestControl = pairwiseQueuesRef.current.get(sourceNode.id);
              if (!latestControl || latestControl.cancelled || latestControl.paused || latestControl.cancelledNodeIds.has(next.node.id)) return;
              await startNodeGeneration(next.node.id, hydrated.prompt || promptText, hydrated.referenceImages, pairwiseConfig, sourceNode.id, { throwOnSubmitError: true });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (PAIRWISE_QUEUE_BACKOFF_ERROR_PATTERN.test(message)) {
                const latestControl = pairwiseQueuesRef.current.get(sourceNode.id);
                if (latestControl && !latestControl.cancelled) {
                  latestControl.paused = true;
                  queue.unshift(next);
                  updatePairwiseQueueStats(sourceNode.id, (current) => ({ ...current, queued: current.queued + 1, active: true }));
                  setNodes((prev) => prev.map((node) => (
                    node.id === next.node.id
                      ? { ...node, metadata: { ...node.metadata, status: "queued", errorDetails: undefined, generationTaskId: undefined, generationStartedAt: undefined } }
                      : node
                  )));
                  showToast("后端队列已满或请求过快，稍后继续提交排队任务", "info");
                  await wait(PAIRWISE_QUEUE_BACKOFF_MS);
                  const resumedControl = pairwiseQueuesRef.current.get(sourceNode.id);
                  if (resumedControl && !resumedControl.cancelled) resumedControl.paused = false;
                }
              }
            } finally {
              const latestControl = pairwiseQueuesRef.current.get(sourceNode.id);
              if (latestControl && !latestControl.cancelled && !latestControl.cancelledNodeIds.has(next.node.id)) {
                updatePairwiseQueueStats(sourceNode.id, (current) => ({ ...current, running: Math.max(0, current.running - 1), active: true }));
              }
            }
          }
        });
        void Promise.all(workers).finally(() => {
          const control = pairwiseQueuesRef.current.get(sourceNode.id);
          if (!control || control.cancelled) return;
          pairwiseQueuesRef.current.delete(sourceNode.id);
          clearPairwiseQueueStats(sourceNode.id);
          setBusy(sourceNode.id, false);
        });
        return;
      }

      if (context.imageCount > maxReferenceImages) {
        showToast("参考图超过模型限制", "error");
        return;
      }

      pushHistory();

      // 确定目标结果节点（并补齐不足的节点）
      let targetIds: string[] = [];
      const newConnections: CanvasConnection[] = [];

      if (locked) {
        // 锁定模式：复用已连接的下游图片节点，不足则新建补齐
        const existingTargets = connections
          .filter((c) => c.fromNodeId === sourceNode.id)
          .map((c) => nodes.find((n) => n.id === c.toNodeId))
          .filter((n): n is CanvasNodeData => Boolean(n && n.type === CanvasNodeType.Image));
        targetIds = existingTargets.map((n) => n.id);

        if (targetIds.length < count) {
          const needed = count - targetIds.length;
          for (let i = 0; i < needed; i++) {
            const node = createImageNode(getResultNodePosition(sourceNode, targetIds.length + i, count, sourceNode.height + 72));
            targetIds.push(node.id);
            newConnections.push({ id: nanoid(), fromNodeId: sourceNode.id, toNodeId: node.id });
            setNodes((prev) => [...prev, node]);
          }
        } else if (targetIds.length > count) {
          // 多余的锁定节点不参与本轮生成（保持原状态）
          targetIds = targetIds.slice(0, count);
        }
      } else {
        // 非锁定模式：新建 count 个结果节点
        for (let i = 0; i < count; i++) {
          const node = createImageNode(getResultNodePosition(sourceNode, i, count));
          targetIds.push(node.id);
          newConnections.push({ id: nanoid(), fromNodeId: sourceNode.id, toNodeId: node.id });
          setNodes((prev) => [...prev, node]);
        }
      }

      if (newConnections.length) {
        setConnections((prev) => [...prev, ...newConnections]);
      }

      const hydrated = await hydrateNodeGenerationContext(context);

      // 逐节点独立并发提交
      for (const nodeId of targetIds) {
        void startNodeGeneration(nodeId, hydrated.prompt || promptText, hydrated.referenceImages, genConfig, sourceNode.id);
      }
    },
    [clearPairwiseQueueStats, connections, createImageNode, defaultConfig, nodes, pushHistory, startNodeGeneration, showToast, updatePairwiseQueueStats, setBusy],
  );

  // 单节点重试（带冷却）
  const RETRY_COOLDOWN_MS = 3000;
  const handleNodeRetry = useCallback(
    (node: CanvasNodeData) => {
      const now = Date.now();
      const lastRetry = retryCooldownRef.current.get(node.id) ?? 0;
      if (now - lastRetry < RETRY_COOLDOWN_MS) return;
      retryCooldownRef.current.set(node.id, now);

      // 找到连接的编排节点，取其 prompt 和 config
      const configConnection = connections.find((c) => c.toNodeId === node.id);
      const sourceNode = configConnection ? nodes.find((n) => n.id === configConnection.fromNodeId) : undefined;
      const promptText = sourceNode?.metadata?.composerContent ?? sourceNode?.metadata?.prompt ?? node.metadata?.prompt ?? "";
      const genConfig = sourceNode?.metadata?.genConfig ?? defaultConfig;
      if (!promptText) { showToast("无法获取提示词", "info"); return; }

      void (async () => {
        const context = node.metadata?.pairwiseGenerationContext
          || (sourceNode ? buildNodeGenerationContext(sourceNode.id, nodes, connections, promptText) : { prompt: promptText, referenceImages: [], textCount: 0, imageCount: 0 });
        const hydrated = await hydrateNodeGenerationContext(context);
        void startNodeGeneration(node.id, hydrated.prompt || promptText, hydrated.referenceImages, genConfig, sourceNode?.id ?? "");
      })();
    },
    [connections, defaultConfig, nodes, startNodeGeneration, showToast],
  );

  const handleRefreshProgress = useCallback(
    async (node: CanvasNodeData) => {
      const taskId = node.metadata?.generationTaskId;
      if (!taskId) {
        showToast("该节点没有可查询的任务", "info");
        return;
      }
      try {
        const result = await checkExistingTask(taskId);
        if (result.status === "completed" && result.images?.length) {
          const image = result.images[0];
          const size = fitNodeSize(image.width, image.height, 360, 360);
          activeGenerationsRef.current.get(node.id)?.abort();
          activeGenerationsRef.current.delete(node.id);
          patchNode(node.id, (n) => ({ ...n, width: size.width, height: size.height, metadata: { ...n.metadata, ...storedToMetadata(image, { prompt: n.metadata?.prompt }), generationTaskId: n.metadata?.generationTaskId, generationStartedAt: n.metadata?.generationStartedAt } }));
          showToast("已取回生成结果", "success");
          return;
        }
        if (result.status === "failed" || result.status === "expired") {
          patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: "error", errorDetails: result.error || "生成失败" } }));
          showToast("任务已失败", "error");
          return;
        }
        patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: result.status as CanvasNodeMetadata["status"] } }));
        showToast("已获取当前进度", "info");
      } catch {
        showToast("获取进度失败", "error");
      }
    },
    [patchNode, showToast],
  );

  // 刷新页面后恢复进行中的生成任务（检查已有 taskId 的状态）
  useEffect(() => {
    const activeNodes = nodes.filter((node) => {
      const s = node.metadata?.status;
      return node.metadata?.generationTaskId && (s === "submitting" || s === "queued" || s === "processing");
    });
    if (!activeNodes.length) return;

    for (const node of activeNodes) {
      const taskId = node.metadata!.generationTaskId!;
      const controller = new AbortController();
      activeGenerationsRef.current.set(node.id, controller);

      void (async () => {
        try {
          // 先检查当前状态
          const result = await checkExistingTask(taskId);
          if (controller.signal.aborted) return;

          if (result.status === "completed" && result.images?.length) {
            const image = result.images[0];
            const size = fitNodeSize(image.width, image.height, 360, 360);
            patchNode(node.id, (n) => ({ ...n, width: size.width, height: size.height, metadata: { ...n.metadata, ...storedToMetadata(image, { prompt: n.metadata?.prompt }), generationTaskId: n.metadata?.generationTaskId, generationStartedAt: n.metadata?.generationStartedAt } }));
            return;
          }
          if (result.status === "failed" || result.status === "expired") {
            patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: "error", errorDetails: result.error } }));
            return;
          }

          // 仍在进行中 → 继续轮询
          patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: result.status as CanvasNodeMetadata["status"] } }));
          await pollNodeTask(taskId, (taskStatus) => {
            if (controller.signal.aborted) return;
            patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: taskStatus as CanvasNodeMetadata["status"] } }));
          }, controller.signal);

          if (controller.signal.aborted) return;
          const finalResult = await checkExistingTask(taskId);
          if (finalResult.images?.length) {
            const image = finalResult.images[0];
            const size = fitNodeSize(image.width, image.height, 360, 360);
            patchNode(node.id, (n) => ({ ...n, width: size.width, height: size.height, metadata: { ...n.metadata, ...storedToMetadata(image, { prompt: n.metadata?.prompt }), generationTaskId: n.metadata?.generationTaskId, generationStartedAt: n.metadata?.generationStartedAt } }));
          }
        } catch {
          if (controller.signal.aborted) return;
          patchNode(node.id, (n) => ({ ...n, metadata: { ...n.metadata, status: "error", errorDetails: "恢复生成状态失败" } }));
        } finally {
          activeGenerationsRef.current.delete(node.id);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 仅在挂载时运行一次

  // ---- node ops (dialogs) ----
  const openDialog = useCallback(
    (type: NonNullable<DialogState>["type"], node: CanvasNodeData) => {
      const source = nodeImageUrl(node);
      if (!source) return;
      setDialog({ type, nodeId: node.id, source });
    },
    [nodeImageUrl],
  );

  const applyOpResult = useCallback(
    async (nodeId: string, dataUrl: string) => {
      const stored = await uploadImage(dataUrl);
      fillNodeWithStored(nodeId, stored);
    },
    [fillNodeWithStored],
  );

  const applySplitResult = useCallback(
    async (sourceNode: CanvasNodeData, pieces: { row: number; column: number; dataUrl: string }[]) => {
      pushHistory();
      const created: CanvasNodeData[] = [];
      for (const piece of pieces) {
        const stored = await uploadImage(piece.dataUrl);
        const size = fitNodeSize(stored.width, stored.height, 220, 220);
        created.push(createImageNode({ x: sourceNode.position.x + sourceNode.width + 60 + piece.column * (size.width + 16), y: sourceNode.position.y + piece.row * (size.height + 16) }, { metadata: storedToMetadata(stored), width: size.width, height: size.height }));
      }
      setNodes((prev) => [...prev, ...created]);
    },
    [createImageNode, pushHistory],
  );

  // ---- pointer interactions (drag / connect / selection / resize) ----
  const handleNodePointerDown = useCallback(
    (event: React.PointerEvent, nodeId: string) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      setContextMenu(null); // 点击节点时关闭右键菜单

      // 点击节点时自动置顶（Fix 2: z-index stacking）
      topZIndexRef.current += 1;
      setNodeZIndexMap((prev) => ({ ...prev, [nodeId]: topZIndexRef.current }));

      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      let nextSelection = selectedIds;
      if (additive) {
        nextSelection = selectedIds.includes(nodeId) ? selectedIds.filter((id) => id !== nodeId) : [...selectedIds, nodeId];
      } else if (!selectedIds.includes(nodeId)) {
        nextSelection = [nodeId];
      }
      setSelectedIds(nextSelection);
      if (!additive) setSelectedConnectionIds([]);

      // 点击交互元素（按钮 / 输入框 / 可编辑区 / 标记 data-no-drag 的区域）时只选中、不启动拖拽；
      // 其余区域（节点空白、面板留白、标题栏、图片）均可拖动整块节点。
      const target = event.target as HTMLElement | null;
      const isInteractive =
        Boolean(target?.isContentEditable) ||
        Boolean(target?.closest('button, a, input, textarea, select, [role="slider"], [role="textbox"], [data-no-drag]'));
      if (isInteractive) return;

      beginGesture();
      const origin = new Map<string, Position>();
      for (const id of nextSelection.length ? nextSelection : [nodeId]) {
        const target = nodes.find((item) => item.id === id);
        if (target) origin.set(id, { ...target.position });
      }
      interaction.current = { kind: "drag", startX: event.clientX, startY: event.clientY, origin };
    },
    [beginGesture, nodes, selectedIds],
  );

  const handleConnectionSelect = useCallback((event: ReactMouseEvent<SVGPathElement>, connectionId: string) => {
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    setContextMenu(null);
    setSelectedConnectionIds((prev) => {
      if (additive) return prev.includes(connectionId) ? prev.filter((id) => id !== connectionId) : [...prev, connectionId];
      return [connectionId];
    });
    if (!additive) setSelectedIds([]);
  }, []);

  const handleConnectStart = useCallback(
    (event: React.PointerEvent, nodeId: string, handleType: "source" | "target") => {
      event.stopPropagation();
      interaction.current = { kind: "connect", handle: { nodeId, handleType } };
      setConnecting({ handle: { nodeId, handleType }, mouseWorld: worldFromClient(event.clientX, event.clientY) });
    },
    [worldFromClient],
  );

  const handleResizeStart = useCallback(
    (event: React.PointerEvent, nodeId: string, corner: ResizeCorner) => {
      const node = nodes.find((item) => item.id === nodeId);
      if (!node) return;
      beginGesture();
      interaction.current = { kind: "resize", nodeId, corner, startX: event.clientX, startY: event.clientY, width: node.width, height: node.height, pos: { ...node.position } };
    },
    [beginGesture, nodes],
  );

  const handleCanvasSelectionStart = useCallback(
    (event: React.PointerEvent) => {
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      if (!additive) setSelectedConnectionIds([]);
      const world = worldFromClient(event.clientX, event.clientY);
      interaction.current = { kind: "selection", additive, initial: additive ? selectedIds : [] };
      setSelectionBox({ startWorldX: world.x, startWorldY: world.y, currentWorldX: world.x, currentWorldY: world.y, additive, initialSelectedNodeIds: additive ? selectedIds : [] });
    },
    [selectedIds, worldFromClient],
  );

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const current = interaction.current;
      if (!current) return;
      if (current.kind === "drag") {
        const dx = (event.clientX - current.startX) / viewport.k;
        const dy = (event.clientY - current.startY) / viewport.k;
        setNodes((prev) => prev.map((node) => (current.origin.has(node.id) ? { ...node, position: { x: current.origin.get(node.id)!.x + dx, y: current.origin.get(node.id)!.y + dy } } : node)));
      } else if (current.kind === "connect") {
        const world = worldFromClient(event.clientX, event.clientY);
        const overEl = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-node-id]") as HTMLElement | null;
        const targetId = overEl?.getAttribute("data-node-id") || undefined;
        setConnecting({ handle: current.handle, mouseWorld: world, targetId: targetId && targetId !== current.handle.nodeId ? targetId : undefined });
      } else if (current.kind === "selection") {
        const world = worldFromClient(event.clientX, event.clientY);
        setSelectionBox((prev) => (prev ? { ...prev, currentWorldX: world.x, currentWorldY: world.y } : prev));
      } else if (current.kind === "resize") {
        const dx = (event.clientX - current.startX) / viewport.k;
        const dy = (event.clientY - current.startY) / viewport.k;
        const minSize = 80;
        let width = current.width;
        let height = current.height;
        const position = { ...current.pos };
        if (current.corner.includes("right")) width = Math.max(minSize, current.width + dx);
        if (current.corner.includes("left")) {
          width = Math.max(minSize, current.width - dx);
          position.x = current.pos.x + (current.width - width);
        }
        if (current.corner.includes("bottom")) height = Math.max(minSize, current.height + dy);
        if (current.corner.includes("top")) {
          height = Math.max(minSize, current.height - dy);
          position.y = current.pos.y + (current.height - height);
        }
        setNodes((prev) => prev.map((node) => (node.id === current.nodeId ? { ...node, width, height, position } : node)));
      }
    };

    const handleUp = () => {
      const current = interaction.current;
      if (current?.kind === "connect") {
        setConnecting((conn) => {
          if (conn?.targetId) {
            const sourceIds = current.handle.handleType === "source" && selectedIds.includes(current.handle.nodeId)
              ? selectedIds
              : [current.handle.handleType === "source" ? current.handle.nodeId : conn.targetId];
            const targetIds = current.handle.handleType === "target" && selectedIds.includes(current.handle.nodeId)
              ? selectedIds
              : [current.handle.handleType === "source" ? conn.targetId : current.handle.nodeId];
            const nextConnections = sourceIds.flatMap((from) => targetIds
              .filter((to) => from !== to)
              .map((to) => ({ from, to })));
            if (nextConnections.length) {
              setConnections((prev) => {
                const next = [...prev];
                for (const connection of nextConnections) {
                  if (!next.some((item) => item.fromNodeId === connection.from && item.toNodeId === connection.to)) {
                    next.push({ id: nanoid(), fromNodeId: connection.from, toNodeId: connection.to });
                  }
                }
                return next;
              });
            }
          }
          return null;
        });
      } else if (current?.kind === "selection") {
        setSelectionBox((box) => {
          if (box) {
            const minX = Math.min(box.startWorldX, box.currentWorldX);
            const maxX = Math.max(box.startWorldX, box.currentWorldX);
            const minY = Math.min(box.startWorldY, box.currentWorldY);
            const maxY = Math.max(box.startWorldY, box.currentWorldY);
            const inside = nodes.filter((node) => node.position.x + node.width >= minX && node.position.x <= maxX && node.position.y + node.height >= minY && node.position.y <= maxY).map((node) => node.id);
            setSelectedIds([...new Set([...box.initialSelectedNodeIds, ...inside])]);
          }
          return null;
        });
      }
      interaction.current = null;
      gestureActive.current = false;
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [nodes, selectedIds, viewport.k, worldFromClient]);

  // ---- keyboard ----
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (editing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        clipboard.current = nodes.filter((node) => selectedIds.includes(node.id)).map((node) => ({ ...node, metadata: { ...node.metadata } }));
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
        if (!clipboard.current.length) return;
        pushHistory();
        const clones = clipboard.current.map((node) => ({ ...node, id: nanoid(), position: { x: node.position.x + 40, y: node.position.y + 40 }, metadata: { ...node.metadata } }));
        setNodes((prev) => [...prev, ...clones]);
        setSelectedIds(clones.map((node) => node.id));
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedIds.length || selectedConnectionIds.length) {
          event.preventDefault();
          deleteSelection();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [deleteSelection, nodes, pushHistory, redo, selectedConnectionIds.length, selectedIds, undo]);

  // ---- 粘贴图片/文本：选中单个同类节点则填充，否则在视口中心新建 ----
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const items = event.clipboardData?.items;
      if (!items) return;
      let imageFile: File | null = null;
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item.kind === "file" && item.type.startsWith("image/")) {
          imageFile = item.getAsFile();
          break;
        }
      }
      if (!imageFile) return;
      event.preventDefault();
      const file = imageFile;
      const selectedImageNodes = nodes.filter((node) => node.type === CanvasNodeType.Image && selectedIds.includes(node.id));
      void (async () => {
        try {
          const dataUrl = await readFileAsDataUrl(file);
          const stored = await uploadImage(dataUrl);
          if (selectedImageNodes.length === 1) {
            fillNodeWithConfirm(selectedImageNodes[0].id, stored);
            return;
          }
          pushHistory();
          const size = fitNodeSize(stored.width, stored.height, 320, 320);
          const node = createImageNode(viewportCenterWorld(), { metadata: storedToMetadata(stored), width: size.width, height: size.height });
          setNodes((prev) => [...prev, node]);
          setSelectedIds([node.id]);
        } catch {
          showToast("粘贴图片失败", "error");
        }
      })();
      return;
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [createImageNode, fillNodeWithConfirm, nodes, pushHistory, selectedIds, showToast, viewportCenterWorld]);

  useEffect(() => {
    const handlePasteText = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const items = event.clipboardData?.items;
      if (items) {
        for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          if (item.kind === "file" && item.type.startsWith("image/")) return;
        }
      }
      const text = event.clipboardData?.getData("text/plain").trim();
      if (!text) return;
      event.preventDefault();
      const selectedTextNodes = nodes.filter((node) => node.type === CanvasNodeType.Text && selectedIds.includes(node.id));
      if (selectedTextNodes.length === 1) {
        fillTextNodeWithConfirm(selectedTextNodes[0].id, text);
        return;
      }
      pushHistory();
      const node = createTextNode(viewportCenterWorld(), text);
      setNodes((prev) => [...prev, node]);
      setSelectedIds([node.id]);
    };
    window.addEventListener("paste", handlePasteText);
    return () => window.removeEventListener("paste", handlePasteText);
  }, [createTextNode, fillTextNodeWithConfirm, nodes, pushHistory, selectedIds, viewportCenterWorld]);

  const relatedIds = useMemo(() => {
    const set = new Set<string>();
    for (const connection of connections) {
      if (selectedIds.includes(connection.fromNodeId)) set.add(connection.toNodeId);
      if (selectedIds.includes(connection.toNodeId)) set.add(connection.fromNodeId);
    }
    return set;
  }, [connections, selectedIds]);

  const nodeById = useCallback((id: string) => nodes.find((node) => node.id === id), [nodes]);
  const contextNode = contextMenu?.type === "node" ? nodeById(contextMenu.nodeId) : undefined;

  const handleTextChange = useCallback(
    (nodeId: string, content: string) => {
      patchNode(nodeId, (node) => ({ ...node, metadata: { ...node.metadata, content } }));
    },
    [patchNode],
  );

  const handleConfigChange = useCallback(
    (nodeId: string, patch: Partial<CanvasGenerationConfig>) => {
      patchNode(nodeId, (node) => ({ ...node, metadata: { ...node.metadata, genConfig: { ...(node.metadata?.genConfig ?? defaultConfig), ...patch } } }));
      setStoreConfig(patch);
    },
    [defaultConfig, patchNode, setStoreConfig],
  );

  // ---- 提示词优化：结合连接的上游图片（vision）/ 文字（context） ----
  const handleOptimizePrompt = useCallback(
    async (configNode: CanvasNodeData) => {
      let textModel;
      try {
        textModel = requireDefaultConfiguredTextModel("promptOptimize");
      } catch {
        onRequireApiKey();
        return;
      }
      const promptText = (configNode.metadata?.composerContent ?? configNode.metadata?.prompt ?? "").trim();
      if (!promptText) { showToast("请输入提示词", "info"); return; }

      optimizeHandleRef.current?.abort();
      setOptimizeNodeId(configNode.id);
      setOptimizeOriginalPrompt(promptText);
      setOptimizedText("");
      setOptimizeError(null);
      setOptimizing(true);
      setOptimizeOpen(true);

      try {
        const inputs = buildNodeGenerationInputs(configNode.id, nodes, connections);
        const upstreamText = inputs
          .filter((input) => input.type === "text")
          .map((input) => input.text)
          .filter((text): text is string => Boolean(text))
          .join("\n\n");
        const imageInputs = inputs.filter((input) => Boolean(input.image));
        const hasPromptGalleryRoles = inputs.some((input) => {
          const role = nodeById(input.nodeId)?.metadata?.canvasRole;
          return role === "reference" || role === "target" || role === "reference-prompt";
        });
        const upstreamImages = (hasPromptGalleryRoles
          ? imageInputs.filter((input) => nodeById(input.nodeId)?.metadata?.canvasRole === "target")
          : imageInputs
        )
          .map((input) => input.image)
          .filter((image): image is ReferenceImage => Boolean(image));

        const images: OptimizeImageInput[] = [];
        for (const image of upstreamImages) {
          try {
            const dataUrl = await imageToDataUrl(image);
            const compressed = await compressReferenceDataUrl(dataUrl);
            images.push({ dataUrl: compressed.dataUrl, mimeType: compressed.mimeType });
          } catch {
            // 跳过无法读取的上游图片
          }
        }

        const mode = hasPromptGalleryRoles ? "canvas-prompt-gallery-config" : images.length > 0 ? "image-to-image" : "text-to-image";
        const mentionTokens = getCanvasMentionTokens(promptText);
        const context = [
          mentionTokens.length
            ? `必须原样保留这些画布引用 token，不要删除、改写、翻译或替换成节点名称：${mentionTokens.join(" ")}。这些 token 会在画布里渲染为 @图片/@文本/@所有图片 芯片。`
            : "",
          hasPromptGalleryRoles
            ? "这是提示词广场导入的配置节点。优化时不要读取模板参考图，只使用已提供的目标角色/OC图；不要把目标角色/OC图转写成外貌文字，请保留并强化对用户上传角色图的引用，让生图模型直接参考图片理解角色。"
            : "",
          upstreamText ? `已连接的上游文字参考：\n${upstreamText}` : "",
        ].filter(Boolean).join("\n\n") || undefined;

        optimizeHandleRef.current = streamPromptOptimize(
          { apiKey: textModel.apiKey, mode, prompt: promptText, images, context },
          {
            onDelta(token) { setOptimizedText((prev) => prev + token); },
            onDone() { setOptimizing(false); },
            onError(err) { setOptimizeError(err.message); setOptimizing(false); },
          },
          textModel.baseUrl,
        );
      } catch (err) {
        setOptimizeError(err instanceof Error ? err.message : String(err));
        setOptimizing(false);
      }
    },
    [connections, nodeById, nodes, onRequireApiKey, showToast],
  );

  const handleOptimizeCancel = useCallback(() => {
    optimizeHandleRef.current?.abort();
    optimizeHandleRef.current = null;
    setOptimizing(false);
    setOptimizedText("");
    setOptimizeError(null);
  }, []);

  const handleOptimizeAccept = useCallback(() => {
    if (optimizedText && optimizeNodeId) {
      const nextPrompt = preserveCanvasMentionTokens(optimizeOriginalPrompt, optimizedText);
      patchNode(optimizeNodeId, (node) => ({ ...node, metadata: { ...node.metadata, composerContent: nextPrompt } }));
    }
    optimizeHandleRef.current = null;
    setOptimizedText("");
    setOptimizeError(null);
  }, [optimizedText, optimizeNodeId, optimizeOriginalPrompt, patchNode]);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedConnectionIdSet = useMemo(() => new Set(selectedConnectionIds), [selectedConnectionIds]);
  const nodeByIdMap = useMemo(() => {
    const map = new Map<string, CanvasNodeData>();
    for (const node of nodes) map.set(node.id, node);
    return map;
  }, [nodes]);

  const connectionActions = useMemo(() => {
    const map = new Map<string, {
      onSelect: (event: ReactMouseEvent<SVGPathElement>) => void;
      onContextMenu: (event: ReactMouseEvent<SVGPathElement>) => void;
    }>();
    for (const connection of connections) {
      map.set(connection.id, {
        onSelect: (event) => handleConnectionSelect(event, connection.id),
        onContextMenu: (event) => {
          event.preventDefault();
          setSelectedIds([]);
          setSelectedConnectionIds([connection.id]);
          setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: connection.id });
        },
      });
    }
    return map;
  }, [connections, handleConnectionSelect]);

  const selectionRect = useMemo(() => {
    if (!selectionBox) return null;
    return {
      x: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
      y: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
      width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
      height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
    };
  }, [selectionBox]);

  const canvasGenerationStatus = useMemo(() => {
    const queueStats = Object.values(pairwiseQueueStats).reduce(
      (acc, status) => ({
        running: acc.running + status.running,
        queued: acc.queued + status.queued,
        total: acc.total + status.total,
        active: acc.active || status.active,
      }),
      { running: 0, queued: 0, total: 0, active: false },
    );
    let activeNodeCount = 0;
    let selectedActiveNodeCount = 0;
    for (const node of nodes) {
      if (!ACTIVE_GENERATION_STATUSES.includes(node.metadata?.status || "")) continue;
      activeNodeCount += 1;
      if (selectedIdSet.has(node.id)) selectedActiveNodeCount += 1;
    }
    return {
      queueStats,
      activeNodeCount,
      selectedActiveNodeCount,
      hasActiveGeneration: busyNodeIds.length > 0 || queueStats.active || activeNodeCount > 0,
    };
  }, [busyNodeIds.length, nodes, pairwiseQueueStats, selectedIdSet]);

  useEffect(() => {
    onQueueStatsChange?.(canvasGenerationStatus.queueStats);
  }, [canvasGenerationStatus.queueStats, onQueueStatsChange]);

  return (
    <div className="relative h-full w-full">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          const files = event.target.files;
          const targetId = uploadTargetRef.current;
          uploadTargetRef.current = null;
          if (files && files.length) {
            if (targetId) {
              const file = Array.from(files).find((item) => item.type.startsWith("image/"));
              if (file) {
                void (async () => {
                  try {
                    const dataUrl = await readFileAsDataUrl(file);
                    const stored = await uploadImage(dataUrl);
                    fillNodeWithConfirm(targetId, stored);
                  } catch {
                    showToast("图片读取失败", "error");
                  }
                })();
              }
            } else {
              void ingestFiles(files);
            }
          }
          event.target.value = "";
        }}
      />

      <InfiniteCanvas
        containerRef={containerRef}
        viewport={viewport}
        backgroundMode={backgroundMode}
        onViewportChange={setViewport}
        onCanvasMouseDown={handleCanvasSelectionStart}
        onCanvasDeselect={() => { setSelectedIds([]); setSelectedConnectionIds([]); setContextMenu(null); if (titleDraft !== null) { renameProject(projectId, titleDraft); setTitleDraft(null); } }}
        onContextMenu={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (event.dataTransfer?.files?.length) void ingestFiles(event.dataTransfer.files, worldFromClient(event.clientX, event.clientY));
        }}
      >
        <svg className="pointer-events-none absolute overflow-visible" style={{ width: 1, height: 1 }}>
          {connections.map((connection) => {
            const from = nodeByIdMap.get(connection.fromNodeId);
            const to = nodeByIdMap.get(connection.toNodeId);
            if (!from || !to) return null;
            const active = selectedConnectionIdSet.has(connection.id);
            const actions = connectionActions.get(connection.id);
            if (!actions) return null;
            return (
              <g key={connection.id} className="pointer-events-auto">
                <ConnectionPath
                  connection={connection}
                  startX={from.position.x + from.width}
                  startY={from.position.y + from.height / 2}
                  endX={to.position.x}
                  endY={to.position.y + to.height / 2}
                  active={active}
                  onSelect={actions.onSelect}
                  onContextMenu={actions.onContextMenu}
                />
              </g>
            );
          })}
          {connecting && <ActiveConnectionPath node={nodeById(connecting.handle.nodeId)} handle={connecting.handle} mouseWorld={connecting.mouseWorld} target={connecting.targetId ? nodeById(connecting.targetId) : undefined} />}
        </svg>

        {nodes.map((node) => {
          const referenceLimit = node.type === CanvasNodeType.Config ? getConfigReferenceLimit(node) : null;
          return (
            <CanvasNode
              key={node.id}
              data={node}
              imageUrl={nodeImageUrl(node)}
              galleryImageUrls={nodeGalleryImageUrls(node)}
              isSelected={selectedIdSet.has(node.id)}
              isRelated={relatedIds.has(node.id)}
              isConnectionTarget={connecting?.targetId === node.id}
              referenceLimitExceeded={Boolean(referenceLimit?.exceeded)}
              zIndex={nodeZIndexMap[node.id] ?? 1}
              showImageInfo={showImageInfo}
              onPointerDownNode={handleNodePointerDown}
              onSelectNode={(id) => { if (!selectedIdSet.has(id)) setSelectedIds([id]); setSelectedConnectionIds([]); }}
              onContextMenu={(event, id) => {
                event.preventDefault();
                if (!selectedIdSet.has(id)) {
                  setSelectedIds([id]);
                  setSelectedConnectionIds([]);
                }
                setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId: id });
              }}
              onConnectStart={handleConnectStart}
              onResizeStart={handleResizeStart}
              onContentChange={handleTextChange}
              isRenaming={renamingNodeId === node.id}
              renameDraft={renamingNodeId === node.id ? renameNodeDraft : node.title}
              onRenameStart={startRenameNode}
              onRenameDraftChange={setRenameNodeDraft}
              onRenameCommit={commitRenameNode}
              onRenameCancel={cancelRenameNode}
              onUploadToNode={handleNodeUpload}
              onImportToNode={handleNodeImport}
              onImportTextToNode={handleTextNodeImport}
              onSaveToAssets={handleSaveToAssets}
              onSaveTextToAssets={handleSaveTextToAssets}
              onRetry={handleNodeRetry}
              onRefreshProgress={handleRefreshProgress}
              onOpenImage={(target) => {
                const url = nodeImageUrl(target);
                if (url) {
                  const payload: ImageActionPayload = {
                    id: target.id,
                    name: target.title,
                    src: url,
                    sourceKind: 'manual',
                    sourceLabel: '无限画布',
                    sourceRef: target.metadata?.storageKey ?? target.id,
                    prompt: target.metadata?.prompt,
                  };
                  setFullscreenImageUrl({ src: url, title: target.title, actionPayload: payload });
                }
              }}
              renderPanel={(configNode, onSelect) => {
                const pairwiseInfo = getConfigPairwiseInfo(configNode);
                return (
                  <CanvasConfigNodePanel
                    prompt={configNode.metadata?.composerContent || ""}
                    references={buildNodeMentionReferences(configNode, nodes, connections, imageUrls)}
                    config={configNode.metadata?.genConfig ?? defaultConfig}
                    lockResultNodes={Boolean(configNode.metadata?.lockResultNodes)}
                    pairwiseGeneration={Boolean(configNode.metadata?.pairwiseGeneration)}
                    pairwiseAvailable={pairwiseInfo.available}
                    pairwiseCount={pairwiseInfo.count}
                    referenceLimit={referenceLimit ?? getConfigReferenceLimit(configNode)}
                    queueStatus={pairwiseQueueStats[configNode.id]}
                    busy={busyNodeIds.includes(configNode.id)}
                    optimizing={optimizing && optimizeNodeId === configNode.id}
                    onPromptChange={(value) => patchNode(configNode.id, (n) => ({ ...n, metadata: { ...n.metadata, composerContent: value } }))}
                    onConfigChange={(patch) => handleConfigChange(configNode.id, patch)}
                    onToggleLock={() => patchNode(configNode.id, (n) => ({ ...n, metadata: { ...n.metadata, lockResultNodes: !n.metadata?.lockResultNodes } }))}
                    onTogglePairwiseGeneration={() => patchNode(configNode.id, (n) => ({ ...n, metadata: { ...n.metadata, pairwiseGeneration: !n.metadata?.pairwiseGeneration } }))}
                    onCancelGeneration={() => cancelGenerationForConfig(configNode.id)}
                    onSelect={onSelect}
                    onOptimizePrompt={() => void handleOptimizePrompt(configNode)}
                    onGenerate={() => void runGeneration(configNode)}
                  />
                );
              }}
            />
          );
        })}

        {selectionRect && (
          <div
            className="pointer-events-none absolute rounded-md border-2"
            style={{ left: selectionRect.x, top: selectionRect.y, width: selectionRect.width, height: selectionRect.height, borderColor: theme.canvas.selectionStroke, background: theme.canvas.selectionFill }}
          />
        )}
      </InfiniteCanvas>

      {/* 顶部返回 + 标题（点击重命名） */}
      <div data-canvas-no-zoom className="absolute top-4 left-4 z-50 flex items-center gap-2" onPointerDown={(event) => event.stopPropagation()}>
        <Button variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" />
          画布列表
        </Button>
        {titleDraft !== null ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              renameProject(projectId, titleDraft);
              setTitleDraft(null);
            }}
          >
            <Input
              autoFocus
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={() => {
                renameProject(projectId, titleDraft);
                setTitleDraft(null);
              }}
              className="h-7 w-44 text-xs"
            />
          </form>
        ) : (
          <button
            type="button"
            title="点击重命名"
            onClick={() => setTitleDraft(projectTitle)}
            className="max-w-44 truncate rounded-lg border border-border bg-card/90 px-2.5 py-1 text-xs text-muted-foreground shadow-sm transition-colors hover:text-foreground"
          >
            {projectTitle}
          </button>
        )}
      </div>

      <CanvasToolbar
        selectedCount={selectedIds.length + selectedConnectionIds.length}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        selectedImportableImageCount={selectedImportableImageCount}
        hasActiveGeneration={canvasGenerationStatus.hasActiveGeneration}
        selectedGenerationCount={canvasGenerationStatus.selectedActiveNodeCount}
        saveFeedbackVisible={saveFeedbackVisible}
        backgroundMode={backgroundMode}
        showImageInfo={showImageInfo}
        onAddImage={() => addNode(CanvasNodeType.Image)}
        onAddText={() => addNode(CanvasNodeType.Text)}
        onAddConfig={() => addNode(CanvasNodeType.Config)}
        onImportPromptGallery={() => setPromptGalleryOpen(true)}
        onImportToAssets={handleToolbarImportToAssets}
        onUndo={undo}
        onRedo={redo}
        onSave={() => void saveCanvas()}
        onCancelGeneration={cancelToolbarGeneration}
        onDelete={deleteSelection}
        onBackgroundModeChange={setBackgroundMode}
        onShowImageInfoChange={setShowImageInfo}
      />

      <CanvasZoomControls
        scale={viewport.k}
        onScaleChange={(scale) => {
          const center = { x: viewportSize.width / 2, y: viewportSize.height / 2 };
          const worldX = (center.x - viewport.x) / viewport.k;
          const worldY = (center.y - viewport.y) / viewport.k;
          setViewport({ k: scale, x: center.x - worldX * scale, y: center.y - worldY * scale });
        }}
        onReset={() => {
          // 重置视图：将所有节点内容居中并自动缩放，保证全部可见（Fix 7）
          if (!nodes.length) { setViewport({ x: 0, y: 0, k: 1 }); return; }
          const PAD = 80;
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          nodes.forEach((node) => {
            minX = Math.min(minX, node.position.x);
            minY = Math.min(minY, node.position.y);
            maxX = Math.max(maxX, node.position.x + node.width);
            maxY = Math.max(maxY, node.position.y + node.height);
          });
          const contentW = maxX - minX + PAD * 2;
          const contentH = maxY - minY + PAD * 2;
          const scale = Math.min(viewportSize.width / contentW, viewportSize.height / contentH, 1);
          const centeredX = (viewportSize.width - (maxX + minX) * scale) / 2;
          const centeredY = (viewportSize.height - (maxY + minY) * scale) / 2;
          setViewport({ x: centeredX, y: centeredY, k: scale });
        }}
        isMiniMapOpen={miniMapOpen}
        onToggleMiniMap={() => setMiniMapOpen((open) => !open)}
      />

      {miniMapOpen && <Minimap nodes={nodes} viewport={viewport} viewportSize={viewportSize} onViewportChange={setViewport} />}

      <CanvasContextMenu
        state={contextMenu}
        node={contextNode}
        onClose={() => setContextMenu(null)}
        actions={{
          onGenerate: () => contextNode?.type === CanvasNodeType.Config && void runGeneration(contextNode),
          onDuplicate: () => contextMenu?.type === "node" && duplicateNodes([contextMenu.nodeId]),
          onDelete: () => contextMenu?.type === "node" && deleteNodes(selectedIds.length ? selectedIds : [contextMenu.nodeId]),
          onDeleteImageOnly: () => contextNode && clearNodeImage(contextNode.id),
          onRetry: () => contextNode && handleNodeRetry(contextNode),
          onCrop: () => contextNode && openDialog("crop", contextNode),
          onSplit: () => contextNode && openDialog("split", contextNode),
          onUpscale: () => contextNode && openDialog("upscale", contextNode),
          onAngle: () => contextNode && openDialog("angle", contextNode),
          onDeleteConnection: () => {
            if (contextMenu?.type === "connection") {
              deleteConnections([contextMenu.connectionId]);
            }
          },
        }}
      />

      <AgentAssetPickerDialog
        open={assetPicker.open}
        maxSelected={200}
        allowFolderSelection
        onOpenChange={(open) => setAssetPicker((prev) => ({ ...prev, open }))}
        onConfirm={(assets, options) => void handleAssetPickerConfirm(assets, options)}
        onConfirmFolder={(folder, assets) => void handleAssetFolderPickerConfirm(folder, assets)}
      />
      <AgentTextAssetPickerDialog open={textAssetPicker.open} onOpenChange={(open) => setTextAssetPicker((prev) => ({ ...prev, open }))} onConfirm={handleTextAssetPickerConfirm} />

      <CanvasPromptGalleryImportDialog open={promptGalleryOpen} importing={promptGalleryImporting} onOpenChange={setPromptGalleryOpen} onConfirm={(prompt) => void importPromptGalleryTemplate(prompt)} />

      <PromptOptimizeDialog
        open={optimizeOpen}
        onOpenChange={(open) => { if (!open) handleOptimizeCancel(); setOptimizeOpen(open); }}
        originalPrompt={optimizeOriginalPrompt}
        optimizedPrompt={optimizedText}
        loading={optimizing}
        error={optimizeError}
        onAccept={handleOptimizeAccept}
        onCancel={handleOptimizeCancel}
      />

      <Dialog open={Boolean(replaceConfirm)} onOpenChange={(open) => !open && setReplaceConfirm(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>替换图片</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">该节点已有图片，是否替换为新图片？</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplaceConfirm(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (replaceConfirm) fillNodeWithStored(replaceConfirm.nodeId, replaceConfirm.stored, replaceConfirm.title);
                setReplaceConfirm(null);
              }}
            >
              替换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(textReplaceConfirm)} onOpenChange={(open) => !open && setTextReplaceConfirm(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>覆盖文本</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">该文本节点已有内容，是否用素材内容覆盖？</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTextReplaceConfirm(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (textReplaceConfirm) fillTextNode(textReplaceConfirm.nodeId, textReplaceConfirm.content);
                setTextReplaceConfirm(null);
              }}
            >
              覆盖
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {dialog?.type === "crop" && <CanvasCropDialog open source={dialog.source} onClose={() => setDialog(null)} onApply={(dataUrl) => void applyOpResult(dialog.nodeId, dataUrl)} />}
      {dialog?.type === "upscale" && <CanvasUpscaleDialog open source={dialog.source} onClose={() => setDialog(null)} onApply={(dataUrl) => void applyOpResult(dialog.nodeId, dataUrl)} />}
      {dialog?.type === "angle" && <CanvasAngleDialog open source={dialog.source} onClose={() => setDialog(null)} onApply={(dataUrl) => void applyOpResult(dialog.nodeId, dataUrl)} />}
      {dialog?.type === "split" && (
        <CanvasSplitDialog
          open
          source={dialog.source}
          onClose={() => setDialog(null)}
          onApply={(pieces) => {
            const node = nodeById(dialog.nodeId);
            if (node) void applySplitResult(node, pieces);
          }}
        />
      )}

      {fullscreenImageUrl && (
        <FullscreenImageViewer src={fullscreenImageUrl.src} title={fullscreenImageUrl.title} onClose={() => setFullscreenImageUrl(null)} actionPayload={fullscreenImageUrl.actionPayload} />
      )}
    </div>
  );
}
