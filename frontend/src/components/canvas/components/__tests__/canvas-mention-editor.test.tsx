import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CanvasMentionEditor } from "../canvas-mention-editor";

const LONG_CHINESE_PROMPT = "长".repeat(2048);

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
