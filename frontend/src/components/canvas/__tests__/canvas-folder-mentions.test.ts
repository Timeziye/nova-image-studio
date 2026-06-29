import { describe, expect, it } from 'vitest';

import { buildNodeGenerationContext } from '../components/canvas-node-generation';
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
});
