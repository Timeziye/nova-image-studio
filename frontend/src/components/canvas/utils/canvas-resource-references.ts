import { imageReferenceLabel } from "../lib/image-reference-prompt";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";

export type CanvasResourceKind = "image" | "text" | "image-group";
type CanvasNodeResourceKind = Exclude<CanvasResourceKind, "image-group">;

export type CanvasResourceReference = {
  id: string;
  nodeId: string;
  token: string;
  kind: CanvasResourceKind;
  label: string;
  title: string;
  previewUrl?: string;
  text?: string;
  active: boolean;
};

export function buildCanvasResourceReferences(nodes: CanvasNodeData[], connections: CanvasConnection[], contextNodeId?: string | null, imageUrls?: Record<string, string>) {
  const contextNodes = contextNodeId ? getMentionResourceNodes(contextNodeId, nodes, connections) : [];
  const globalReferences = labelResourceNodes(nodes.filter(isResourceNode), false, imageUrls);
  const activeByToken = new Map(labelResourceNodes(contextNodes, true, imageUrls).map((reference) => [reference.token, reference]));
  return globalReferences.map((reference) => activeByToken.get(reference.token) || reference);
}

export function buildNodeMentionReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[], imageUrls?: Record<string, string>) {
  return withAllImagesReference(labelResourceNodes(getMentionResourceNodes(node.id, nodes, connections), true, imageUrls));
}

export function getMentionResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
  const configInputs = getConnectedConfigResourceNodes(nodeId, nodes, connections);
  if (configInputs.length) return configInputs;
  const ownInputs = getContextResourceNodes(nodeId, nodes, connections);
  if (ownInputs.length) return ownInputs;
  const node = nodes.find((item) => item.id === nodeId);
  return node && isResourceNode(node) ? [node] : [];
}

export function getGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
  const configInputs = getConnectedConfigResourceNodes(nodeId, nodes, connections);
  if (configInputs.length) return configInputs;
  const ownInputs = getContextResourceNodes(nodeId, nodes, connections);
  if (ownInputs.length) return ownInputs;
  return [];
}

function getContextResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
  return connections
    .filter((connection) => connection.toNodeId === nodeId)
    .map((connection) => nodes.find((node) => node.id === connection.fromNodeId))
    .filter((node): node is CanvasNodeData => Boolean(node && isResourceNode(node)));
}

function getConnectedConfigResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
  const configConnection = connections.find((connection) => connection.fromNodeId === nodeId && nodes.find((node) => node.id === connection.toNodeId)?.type === CanvasNodeType.Config);
  if (!configConnection) return [];
  return getContextResourceNodes(configConnection.toNodeId, nodes, connections).filter((node) => node.id !== nodeId);
}

function labelResourceNodes(nodes: CanvasNodeData[], active: boolean, imageUrls?: Record<string, string>) {
  const counts: Record<CanvasNodeResourceKind, number> = { image: 0, text: 0 };
  return nodes.flatMap((node): CanvasResourceReference[] => {
    const kind = resourceKind(node);
    if (!kind) return [];
    const galleryImages = node.metadata?.galleryImages || [];
    const index = counts[kind]++;
    const fallbackLabel = labelForKind(kind, index);
    const label = node.title?.trim() || fallbackLabel;
    if (kind === "image" && galleryImages.length) {
      return [
        {
          id: node.id,
          nodeId: node.id,
          token: `node:${node.id}`,
          kind: "image-group",
          label,
          title: `${galleryImages.length} 张图片`,
          active,
        },
        ...galleryImages.map((image, imageIndex): CanvasResourceReference => {
          if (imageIndex > 0) counts.image++;
          const resolvedImage = image.storageKey && imageUrls ? imageUrls[image.storageKey] : undefined;
          const imageLabel = `${label} / ${imageReferenceLabel(imageIndex)}`;
          return {
            id: `${node.id}:${image.id}`,
            nodeId: node.id,
            token: `node-image:${node.id}:${image.id}`,
            kind: "image",
            label: imageLabel,
            title: image.name || imageReferenceLabel(imageIndex),
            previewUrl: resolvedImage || image.content,
            active,
          };
        }),
      ];
    }
    // 优先用已解析的 blob URL（刷新后 metadata.content 是失效的 blob URL，需要通过 storageKey 解析）
    const resolvedImage = node.metadata?.storageKey && imageUrls ? imageUrls[node.metadata.storageKey] : undefined;
    return [
      {
        id: node.id,
        nodeId: node.id,
        token: `node:${node.id}`,
        kind,
        label,
        title: fallbackLabel,
        previewUrl: kind === "image" ? (resolvedImage || node.metadata?.content) : undefined,
        text: node.type === CanvasNodeType.Text ? node.metadata?.content || node.metadata?.prompt : undefined,
        active,
      },
    ];
  });
}

function withAllImagesReference(references: CanvasResourceReference[]) {
  const activeImages = references.filter((reference) => reference.active && reference.kind === "image");
  const ordered = orderMentionReferences(references);
  if (activeImages.length <= 1) return ordered;
  return [
    {
      id: "all-images",
      nodeId: "all-images",
      token: "all-images",
      kind: "image-group" as const,
      label: "所有图片",
      title: `${activeImages.length} 张上游图片`,
      active: true,
    },
    ...ordered,
  ];
}

function orderMentionReferences(references: CanvasResourceReference[]) {
  const rank = (reference: CanvasResourceReference) => {
    if (reference.kind === "image-group") return 0;
    if (reference.kind === "image") return 1;
    return 2;
  };
  return [...references].sort((a, b) => rank(a) - rank(b));
}

function labelForKind(kind: CanvasResourceKind, index: number) {
  if (kind === "image-group") return "所有图片";
  if (kind === "image") return imageReferenceLabel(index);
  return `文本${index + 1}`;
}

function isResourceNode(node: CanvasNodeData) {
  return Boolean(resourceKind(node));
}

function resourceKind(node: CanvasNodeData): CanvasNodeResourceKind | null {
  if (node.type === CanvasNodeType.Image && node.metadata?.galleryImages?.length) return "image";
  if (node.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.storageKey)) return "image";
  if (node.type === CanvasNodeType.Image && node.metadata?.canvasRole === "target") return "image";
  if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return "text";
  return null;
}
