import { memo, type MouseEvent as ReactMouseEvent } from "react";

import { canvasTheme } from "../lib/canvas-theme";
import type { CanvasConnection, CanvasNodeData, ConnectionHandle, Position } from "../types";

type ConnectionPathProps = {
  connection: CanvasConnection;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  active: boolean;
  onSelect: (event: ReactMouseEvent<SVGPathElement>) => void;
  onContextMenu?: (event: ReactMouseEvent<SVGPathElement>) => void;
};

export const ConnectionPath = memo(function ConnectionPath({
  connection,
  startX,
  startY,
  endX,
  endY,
  active,
  onSelect,
  onContextMenu,
}: ConnectionPathProps) {
  const theme = canvasTheme;
  const dx = Math.abs(endX - startX);
  const curvature = Math.max(dx * 0.5, 50);
  const pathD = `M ${startX} ${startY} C ${startX + curvature} ${startY}, ${endX - curvature} ${endY}, ${endX} ${endY}`;

  return (
    <g>
      <path
        data-connection-id={connection.id}
        d={pathD}
        stroke="transparent"
        strokeWidth="16"
        fill="none"
        style={{ cursor: "pointer", pointerEvents: "stroke" }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(event);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onContextMenu?.(event);
        }}
      />
      <path
        d={pathD}
        stroke={active ? theme.node.activeStroke : theme.node.muted}
        strokeWidth={active ? 3 : 2}
        strokeOpacity={active ? 1 : 0.82}
        fill="none"
        style={{ filter: active ? `drop-shadow(0 0 8px color-mix(in srgb, ${theme.node.activeStroke} 40%, transparent))` : undefined, pointerEvents: "none" }}
      />
    </g>
  );
}, (prev, next) => (
  prev.connection.id === next.connection.id
  && prev.startX === next.startX
  && prev.startY === next.startY
  && prev.endX === next.endX
  && prev.endY === next.endY
  && prev.active === next.active
  && prev.onSelect === next.onSelect
  && prev.onContextMenu === next.onContextMenu
));

export function ActiveConnectionPath({ node, handle, mouseWorld, target }: { node?: CanvasNodeData; handle: ConnectionHandle; mouseWorld: Position; target?: CanvasNodeData }) {
  const theme = canvasTheme;
  if (!node) return null;

  const startX = handle.handleType === "source" ? node.position.x + node.width : mouseWorld.x;
  const startY = handle.handleType === "source" ? node.position.y + node.height / 2 : mouseWorld.y;
  const endX = handle.handleType === "source" ? mouseWorld.x : node.position.x;
  const endY = handle.handleType === "source" ? mouseWorld.y : node.position.y + node.height / 2;
  const snappedStartX = handle.handleType === "target" && target ? target.position.x + target.width : startX;
  const snappedStartY = handle.handleType === "target" && target ? target.position.y + target.height / 2 : startY;
  const snappedEndX = handle.handleType === "source" && target ? target.position.x : endX;
  const snappedEndY = handle.handleType === "source" && target ? target.position.y + target.height / 2 : endY;
  const distance = Math.abs(snappedEndX - snappedStartX);
  const pathD = `M ${snappedStartX} ${snappedStartY} C ${snappedStartX + distance * 0.5} ${snappedStartY}, ${snappedEndX - distance * 0.5} ${snappedEndY}, ${snappedEndX} ${snappedEndY}`;

  return <path d={pathD} stroke={theme.node.activeStroke} strokeWidth="2" fill="none" strokeDasharray="5,5" />;
}
