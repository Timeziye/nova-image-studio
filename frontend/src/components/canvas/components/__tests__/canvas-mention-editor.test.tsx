import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasMentionEditor } from "../canvas-mention-editor";
import type { CanvasResourceReference } from "../../utils/canvas-resource-references";

const LONG_CHINESE_PROMPT = "长".repeat(2048);

const IMAGE_REFERENCE: CanvasResourceReference = {
  id: "image-1", nodeId: "image-1", token: "node:image-1",
  kind: "image", label: "图片1", title: "参考图片", active: true,
};

function ReferenceEditor({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(initialValue);
  return <>
    <CanvasMentionEditor value={value} references={[IMAGE_REFERENCE]} onChange={setValue} />
    <output data-testid="reference-value">{value}</output>
  </>;
}

describe("CanvasMentionEditor mentions at the caret", () => {
  beforeEach(() => {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true, value: vi.fn(() => domRect(0, 20)),
    });
  });
  afterEach(() => {
    delete (Range.prototype as Range & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect;
    window.getSelection()?.removeAllRanges();
  });

  it.each(["", "以", "参考，", "参考。", "参考（", "reference", "第一行\n第二行", "前文 "])(
    "inserts a reference after %j without replacing surrounding text",
    (prefix) => {
      const suffix = "作为参考，保持构图";
      render(<ReferenceEditor initialValue={prefix + suffix} />);
      const editor = screen.getByRole("textbox");
      // Model native insertion at a caret in the middle of a text node.
      editor.textContent = prefix + "@图片" + suffix;
      const range = document.createRange();
      range.setStart(editor.firstChild!, prefix.length + "@图片".length);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      fireEvent.input(editor);

      expect(screen.getByRole("button", { name: /图片1\s*参考图片/ })).toBeVisible();
      fireEvent.keyDown(editor, { key: "Enter" });
      expect(screen.getByTestId("reference-value").textContent).toBe(prefix + "@[node:image-1]\u00a0" + suffix);
      expect(editor.querySelectorAll("[data-mention-token]")).toHaveLength(1);
      expect(window.getSelection()?.anchorNode?.textContent).toBe("\u00a0");
      expect(window.getSelection()?.anchorOffset).toBe(1);
    },
  );

  it("opens a second mention after an existing chip and Chinese text", () => {
    render(<ReferenceEditor initialValue="@[node:image-1]以图1为参考，" />);
    const editor = screen.getByRole("textbox");
    const tail = editor.lastChild!;
    tail.textContent += "@";
    const range = document.createRange();
    range.setStart(tail, tail.textContent!.length);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.input(editor);
    fireEvent.mouseDown(screen.getByRole("button", { name: /图片1\s*参考图片/ }));
    expect(screen.getByTestId("reference-value").textContent).toBe("@[node:image-1]以图1为参考，@[node:image-1]\u00a0");
    expect(editor.querySelectorAll("[data-mention-token]")).toHaveLength(2);
  });
});

function domRect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom,
    left: 0,
    right: 300,
    width: 300,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

function ControlledEditor() {
  const [value, setValue] = useState(LONG_CHINESE_PROMPT);

  return (
    <>
      <CanvasMentionEditor value={value} references={[]} onChange={setValue} />
      <output data-testid="value-state">{`${value.length}:${value.slice(-1)}`}</output>
    </>
  );
}

describe("CanvasMentionEditor long Chinese input", () => {
  it("keeps the caret inside a native scroll owner after the prompt exceeds the node viewport", () => {
    render(<ControlledEditor />);

    const editor = screen.getByRole("textbox");
    const editorOwnsOverflow = editor.classList.contains("overflow-auto") || editor.classList.contains("overflow-y-auto");
    const editorGrowsWithContent = editor.classList.contains("min-h-full") && !editor.classList.contains("h-full");

    expect(editorOwnsOverflow || editorGrowsWithContent).toBe(true);
  });

  it("commits a Chinese IME composition after a long existing prompt", () => {
    render(<ControlledEditor />);

    const editor = screen.getByRole("textbox");
    Object.defineProperties(editor, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 1200 },
    });
    editor.getBoundingClientRect = () => domRect(0, 300);
    const rangePrototype = Object.getPrototypeOf(document.createRange()) as Range;
    const originalRangeRect = Object.getOwnPropertyDescriptor(rangePrototype, "getBoundingClientRect");
    Object.defineProperty(rangePrototype, "getBoundingClientRect", {
      configurable: true,
      value: () => domRect(884, 900),
    });

    try {
      editor.focus();
      fireEvent.compositionStart(editor);
      editor.textContent = `${LONG_CHINESE_PROMPT}中`;
      const textNode = editor.firstChild;
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(textNode!, textNode!.textContent!.length - 1);
      range.setEnd(textNode!, textNode!.textContent!.length);
      selection?.removeAllRanges();
      selection?.addRange(range);
      fireEvent.input(editor, { data: "中", inputType: "insertCompositionText", isComposing: true });
      fireEvent.compositionEnd(editor, { data: "中" });

      expect(screen.getByTestId("value-state")).toHaveTextContent("2049:中");
      expect(editor).toHaveFocus();
      expect(editor.scrollTop).toBeGreaterThan(0);
    } finally {
      if (originalRangeRect) Object.defineProperty(rangePrototype, "getBoundingClientRect", originalRangeRect);
      else delete (rangePrototype as Range & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect;
    }
  });
});
