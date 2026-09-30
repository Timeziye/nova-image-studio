import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CanvasNode } from "../canvas-node";
import { CanvasNodeType, type CanvasNodeData } from "../../types";

describe("failed node result retrieval", () => {
  it("retrieves the existing task without invoking generation and prevents duplicate clicks", async () => {
    let finish!: () => void;
    const retrieve = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const generate = vi.fn();
    const node: CanvasNodeData = { id: "result", title: "9.png", type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 300, height: 300, metadata: { status: "error", errorDetails: "Failed to fetch", generationTaskId: "existing-task" } };
    render(<CanvasNode data={node} isSelected={false} isRelated={false} isConnectionTarget={false} zIndex={1} showImageInfo={false} onPointerDownNode={vi.fn()} onSelectNode={vi.fn()} onContextMenu={vi.fn()} onConnectStart={vi.fn()} onResizeStart={vi.fn()} onContentChange={vi.fn()} onRefreshProgress={retrieve} onRetry={generate} />);
    fireEvent.click(screen.getByRole("button", { name: "重新取回结果" }));
    expect(screen.getByRole("button", { name: "正在取回…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "正在取回…" }));
    expect(retrieve).toHaveBeenCalledOnce();
    expect(retrieve).toHaveBeenCalledWith(node);
    expect(generate).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "重新取回结果" })).toBeEnabled());
  });
});
