import { describe, expect, it } from 'vitest';

import { buildNodeGenerationContext, buildPairwiseGenerationContexts } from '../components/canvas-node-generation';
import { buildNodeMentionReferences } from '../utils/canvas-resource-references';
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from '../types';

function imageNode(id: string, title: string): CanvasNodeData {
  return {
    id,
    type: CanvasNodeType.Image,
    title,
    position: { x: 0, y: 0 },
    width: 320,
    height: 240,
    metadata: {
      content: `data:image/png;base64,${id}`,
      mimeType: 'image/png',
      assetFolderId: 'folder-1',
      assetFolderName: '角色文件夹',
    },
  };
}

function galleryNode(id: string, title: string): CanvasNodeData {
  return {
    id,
    type: CanvasNodeType.Image,
    title,
    position: { x: 0, y: 0 },
    width: 520,
    height: 360,
    metadata: {
      status: 'success',
      assetFolderId: 'folder-1',
      assetFolderName: title,
      galleryImages: [
        { id: 'asset-1', name: 'a.png', content: 'data:image/png;base64,a', mimeType: 'image/png' },
        { id: 'asset-2', name: 'b.png', content: 'data:image/png;base64,b', mimeType: 'image/png' },
      ],
    },
  };
}

function configNode(id = 'config-1', composerContent = ''): CanvasNodeData {
  return {
    id,
    type: CanvasNodeType.Config,
    title: '编排节点',
    position: { x: 0, y: 0 },
    width: 360,
    height: 260,
    metadata: { composerContent },
  };
}

const connections: CanvasConnection[] = [
  { id: 'c1', fromNodeId: 'image-1', toNodeId: 'config-1' },
  { id: 'c2', fromNodeId: 'image-2', toNodeId: 'config-1' },
];

describe('canvas folder image mentions', () => {
  it('为多个上游图片提供 @所有图片 候选和单张图片候选', () => {
    const nodes = [imageNode('image-1', '头像'), imageNode('image-2', '半身'), configNode()];

    const references = buildNodeMentionReferences(nodes[2], nodes, connections);

    expect(references.map(reference => reference.token)).toEqual(['all-images', 'node:image-1', 'node:image-2']);
    expect(references[0]).toMatchObject({ label: '所有图片', kind: 'image-group', active: true });
  });

  it('生成上下文能展开 @所有图片，也能单独引用任意图片', () => {
    const nodes = [
      imageNode('image-1', '头像'),
      imageNode('image-2', '半身'),
      configNode('config-1', '参考：@[all-images]\n重点看：@[node:image-2]'),
    ];

    const context = buildNodeGenerationContext('config-1', nodes, connections, nodes[2].metadata?.composerContent || '');

    expect(context.imageCount).toBe(2);
    expect(context.referenceImages.map(image => image.id)).toEqual(['image-1', 'image-2']);
    expect(context.prompt).toContain('所有图片（头像、半身）');
    expect(context.prompt).toContain('重点看：半身');
  });

  it('多图节点既能作为整组引用，也能引用其中任意单张', () => {
    const nodes = [
      galleryNode('folder-node', '角色文件夹'),
      configNode('config-1', '整组：@[node:folder-node]\n单张：@[node-image:folder-node:asset-2]'),
    ];
    const nodeConnections: CanvasConnection[] = [
      { id: 'c1', fromNodeId: 'folder-node', toNodeId: 'config-1' },
    ];

    const references = buildNodeMentionReferences(nodes[1], nodes, nodeConnections);
    expect(references.map(reference => reference.token)).toEqual([
      'all-images',
      'node:folder-node',
      'node-image:folder-node:asset-1',
      'node-image:folder-node:asset-2',
    ]);

    const context = buildNodeGenerationContext('config-1', nodes, nodeConnections, nodes[1].metadata?.composerContent || '');
    expect(context.imageCount).toBe(2);
    expect(context.referenceImages.map(image => image.id)).toEqual(['asset-1', 'asset-2']);
    expect(context.prompt).toContain('整组：角色文件夹');
    expect(context.prompt).toContain('单张：角色文件夹 / 图片2');
  });

  it('@ 候选按所有图片、文件夹、单张图片排序', () => {
    const nodes = [
      galleryNode('folder-a', '文件夹A'),
      galleryNode('folder-b', '文件夹B'),
      configNode('config-1'),
    ];
    const nodeConnections: CanvasConnection[] = [
      { id: 'c1', fromNodeId: 'folder-a', toNodeId: 'config-1' },
      { id: 'c2', fromNodeId: 'folder-b', toNodeId: 'config-1' },
    ];

    const references = buildNodeMentionReferences(nodes[2], nodes, nodeConnections);

    expect(references.map(reference => reference.token)).toEqual([
      'all-images',
      'node:folder-a',
      'node:folder-b',
      'node-image:folder-a:asset-1',
      'node-image:folder-a:asset-2',
      'node-image:folder-b:asset-1',
      'node-image:folder-b:asset-2',
    ]);
  });
  it('corresponding generation splits a folder node into ordered single-image contexts', () => {
    const nodes = [
      galleryNode('folder-node', 'Folder A'),
      configNode('config-1', 'Use @[all-images] as reference'),
    ];
    const nodeConnections: CanvasConnection[] = [
      { id: 'c1', fromNodeId: 'folder-node', toNodeId: 'config-1' },
    ];

    const contexts = buildPairwiseGenerationContexts('config-1', nodes, nodeConnections, nodes[1].metadata?.composerContent || '');

    expect(contexts).toHaveLength(2);
    expect(contexts.map(item => item.input.resourceToken)).toEqual([
      'node-image:folder-node:asset-1',
      'node-image:folder-node:asset-2',
    ]);
    expect(contexts.map(item => item.context.imageCount)).toEqual([1, 1]);
    expect(contexts.map(item => item.context.referenceImages[0]?.id)).toEqual(['asset-1', 'asset-2']);
  });
});
