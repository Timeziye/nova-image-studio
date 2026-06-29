import { imageReferenceLabel } from "../lib/image-reference-prompt";
import type { ReferenceImage } from "../types-media";
import { CanvasNodeType, type CanvasConnection, type CanvasGalleryImage, type CanvasNodeData } from "../types";
import { getGenerationResourceNodes } from "../utils/canvas-resource-references";

export type NodeGenerationContext = {
  prompt: string;
  referenceImages: ReferenceImage[];
  textCount: number;
  imageCount: number;
};

export type NodeGenerationInput = {
  nodeId: string;
  resourceToken: string;
  type: "text" | "image";
  title: string;
  text?: string;
  image?: ReferenceImage;
};

export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string): NodeGenerationContext {
  const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
  const sourceNode = nodes.find((node) => node.id === nodeId);
  if (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim())) {
    return buildComposerGenerationContext(inputs, prompt);
  }

  const upstreamText = inputs
    .map((input) => input.text)
    .filter(Boolean)
    .join("\n\n");
  const referenceImages = inputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));

  return {
    prompt: upstreamText ? `${prompt}\n\n${upstreamText}` : prompt,
    referenceImages,
    textCount: inputs.filter((input) => input.type === "text").length,
    imageCount: referenceImages.length,
  };
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], prompt: string): NodeGenerationContext {
  const inputsByNodeId = new Map<string, NodeGenerationInput[]>();
  for (const input of inputs) {
    const list = inputsByNodeId.get(input.nodeId) || [];
    list.push(input);
    inputsByNodeId.set(input.nodeId, list);
  }
  const inputByToken = new Map(inputs.map((input) => [input.resourceToken, input]));
  const selectedInputs: NodeGenerationInput[] = [];
  const labelByToken = new Map<string, string>();
  const textBlocks: string[] = [];
  const counts = { image: 0, text: 0 };
  let hasToken = false;
  let lastIndex = 0;
  let nextPrompt = "";

  const addInput = (input: NodeGenerationInput) => {
    let label = labelByToken.get(input.resourceToken);
    if (!label) {
      label = input.title.trim() || generationLabel(input.type, counts[input.type]++);
      labelByToken.set(input.resourceToken, label);
      if (input.type === "text") textBlocks.push(`【${label}】\n${input.text || ""}`);
      else selectedInputs.push(input);
    }
    return label;
  };

  for (const match of prompt.matchAll(/@\[([^\]]+)\]/g)) {
    if (match.index === undefined) continue;
    hasToken = true;
    nextPrompt += prompt.slice(lastIndex, match.index);
    const token = match[1];
    if (token === "all-images") {
      const labels = inputs
        .filter((input) => input.type === "image")
        .map(addInput);
      if (labels.length) nextPrompt += `所有图片（${labels.join("、")}）`;
    } else if (token.startsWith("node-image:")) {
      const input = inputByToken.get(token);
      if (input) nextPrompt += addInput(input);
    } else if (token.startsWith("node:")) {
      const nodeInputs = inputsByNodeId.get(token.slice("node:".length)) || [];
      if (nodeInputs.length) {
        const labels = nodeInputs.map(addInput);
        const first = nodeInputs[0];
        nextPrompt += first.type === "text" ? `【${labels[0]}】` : labels.length > 1 ? `${first.title || "图片集合"}（${labels.join("、")}）` : labels[0];
      }
    }
    lastIndex = match.index + match[0].length;
  }

  nextPrompt += prompt.slice(lastIndex);
  if (textBlocks.length) nextPrompt = `${nextPrompt.trim()}\n\n${textBlocks.join("\n\n")}`;
  const referenceImages = selectedInputs.map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));

  if (!hasToken) {
    return {
      prompt,
      referenceImages: [],
      textCount: 0,
      imageCount: 0,
    };
  }

  return {
    prompt: nextPrompt,
    referenceImages,
    textCount: counts.text,
    imageCount: referenceImages.length,
  };
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): NodeGenerationInput[] {
  return getGenerationResourceNodes(nodeId, nodes, connections).flatMap((node): NodeGenerationInput[] => {
    if (node.type === CanvasNodeType.Image && node.metadata?.galleryImages?.length) {
      return node.metadata.galleryImages.flatMap((image, index): NodeGenerationInput[] => {
        const reference = readGalleryReferenceImage(node, image, index);
        return reference ? [{
          nodeId: node.id,
          resourceToken: `node-image:${node.id}:${image.id}`,
          type: "image" as const,
          title: `${node.title || "图片集合"} / ${imageReferenceLabel(index)}`,
          image: reference,
        }] : [];
      });
    }
    const image = readReferenceImage(node);
    if (image) return [{ nodeId: node.id, resourceToken: `node:${node.id}`, type: "image" as const, title: node.title, image }];
    const text = readNodeTextInput(node);
    if (text) return [{ nodeId: node.id, resourceToken: `node:${node.id}`, type: "text" as const, title: node.title, text }];
    return [];
  });
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
  const { imageToDataUrl } = await import("../lib/image-storage");
  return { ...context, referenceImages: await Promise.all(context.referenceImages.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) }))) };
}

function readNodeTextInput(node: CanvasNodeData) {
  if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
  return node.metadata?.prompt || "";
}

function generationLabel(type: NodeGenerationInput["type"], index: number) {
  if (type === "image") return imageReferenceLabel(index);
  return `文本${index + 1}`;
}

function readReferenceImage(node: CanvasNodeData): ReferenceImage | null {
  if (node.type !== CanvasNodeType.Image || (!node.metadata?.content && !node.metadata?.storageKey)) return null;
  return {
    id: node.id,
    name: `${node.title || node.id}.png`,
    type: node.metadata.mimeType || "image/png",
    dataUrl: node.metadata.content || "",
    storageKey: node.metadata.storageKey,
  };
}

function readGalleryReferenceImage(node: CanvasNodeData, image: CanvasGalleryImage, index: number): ReferenceImage | null {
  if (!image.content && !image.storageKey) return null;
  return {
    id: image.id || `${node.id}-${index}`,
    name: image.name || `${node.title || node.id}-${index + 1}.png`,
    type: image.mimeType || "image/png",
    dataUrl: image.content || "",
    storageKey: image.storageKey,
  };
}
