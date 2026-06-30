"use client";

import { CircleDot, Grid2x2, Image as ImageIcon, Info, LibraryBig, OctagonX, Redo2, Save, Settings2, Square, Trash2, Type, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/toggle-group";
import { Switch } from "@/components/ui/switch";
import type { CanvasBackgroundMode } from "../lib/canvas-theme";
import { CanvasTooltip } from "./canvas-ui";

type CanvasToolbarProps = {
  selectedCount: number;
  canUndo: boolean;
  canRedo: boolean;
  hasActiveGeneration: boolean;
  selectedGenerationCount: number;
  saveFeedbackVisible: boolean;
  backgroundMode: CanvasBackgroundMode;
  showImageInfo: boolean;
  onAddImage: () => void;
  onAddText: () => void;
  onAddConfig: () => void;
  onImportPromptGallery: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onCancelGeneration: () => void;
  onDelete: () => void;
  onBackgroundModeChange: (mode: CanvasBackgroundMode) => void;
  onShowImageInfoChange: (value: boolean) => void;
};

export function CanvasToolbar({
  selectedCount,
  canUndo,
  canRedo,
  hasActiveGeneration,
  selectedGenerationCount,
  saveFeedbackVisible,
  backgroundMode,
  showImageInfo,
  onAddImage,
  onAddText,
  onAddConfig,
  onImportPromptGallery,
  onUndo,
  onRedo,
  onSave,
  onCancelGeneration,
  onDelete,
  onBackgroundModeChange,
  onShowImageInfoChange,
}: CanvasToolbarProps) {
  return (
    <div
      data-canvas-no-zoom
      className="absolute top-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-border bg-card/95 px-2 py-1.5 shadow-lg backdrop-blur"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <CanvasTooltip label="添加图片节点">
        <Button variant="ghost" size="icon-sm" onClick={onAddImage} aria-label="添加图片节点">
          <ImageIcon className="size-4" />
        </Button>
      </CanvasTooltip>
      <CanvasTooltip label="添加文本节点">
        <Button variant="ghost" size="icon-sm" onClick={onAddText} aria-label="添加文本节点">
          <Type className="size-4" />
        </Button>
      </CanvasTooltip>
      <CanvasTooltip label="添加编排节点（提示词 + 参数 + 生成）">
        <Button variant="ghost" size="icon-sm" onClick={onAddConfig} aria-label="添加编排节点">
          <Settings2 className="size-4" />
        </Button>
      </CanvasTooltip>
      <CanvasTooltip label="从提示词广场导入">
        <Button variant="ghost" size="icon-sm" onClick={onImportPromptGallery} aria-label="从提示词广场导入">
          <LibraryBig className="size-4" />
        </Button>
      </CanvasTooltip>

      <div className="mx-1 h-5 w-px bg-border" />

      <CanvasTooltip label="撤销">
        <Button variant="ghost" size="icon-sm" disabled={!canUndo} onClick={onUndo} aria-label="撤销">
          <Undo2 className="size-4" />
        </Button>
      </CanvasTooltip>
      <CanvasTooltip label="重做">
        <Button variant="ghost" size="icon-sm" disabled={!canRedo} onClick={onRedo} aria-label="重做">
          <Redo2 className="size-4" />
        </Button>
      </CanvasTooltip>

      <div className="mx-1 h-5 w-px bg-border" />

      {hasActiveGeneration && (
        <>
          <CanvasTooltip label={selectedGenerationCount > 0 ? `终止选中的 ${selectedGenerationCount} 个生成任务` : "终止全部生成和排队任务"}>
            <Button
              variant="destructive"
              size="icon-sm"
              onClick={onCancelGeneration}
              aria-label={selectedGenerationCount > 0 ? `终止选中的 ${selectedGenerationCount} 个生成任务` : "终止全部生成和排队任务"}
            >
              <OctagonX className="size-4" />
            </Button>
          </CanvasTooltip>
          <div className="mx-1 h-5 w-px bg-border" />
        </>
      )}

      <div className="relative">
        <CanvasTooltip label="保存画布">
          <Button variant="ghost" size="icon-sm" onClick={onSave} aria-label="保存画布">
            <Save className="size-4" />
          </Button>
        </CanvasTooltip>
        {saveFeedbackVisible && (
          <div className="pointer-events-none absolute left-1/2 top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground shadow-lg">
            已保存
          </div>
        )}
      </div>

      <div className="mx-1 h-5 w-px bg-border" />

      <Segmented
        value={backgroundMode}
        onChange={onBackgroundModeChange}
        options={[
          { value: "lines", icon: <Grid2x2 />, title: "网格" },
          { value: "dots", icon: <CircleDot />, title: "圆点" },
          { value: "blank", icon: <Square />, title: "空白" },
        ]}
      />

      <CanvasTooltip label="显示图片信息">
        <label className="ml-1 flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground">
          <Info className="size-3.5" />
          <Switch checked={showImageInfo} onCheckedChange={onShowImageInfoChange} />
        </label>
      </CanvasTooltip>

      {selectedCount > 0 && (
        <>
          <div className="mx-1 h-5 w-px bg-border" />
          <CanvasTooltip label={`删除选中（${selectedCount}）`}>
            <Button variant="destructive" size="icon-sm" onClick={onDelete} aria-label="删除选中">
              <Trash2 className="size-4" />
            </Button>
          </CanvasTooltip>
        </>
      )}
    </div>
  );
}
