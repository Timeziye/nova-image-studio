import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ setItem: vi.fn() }));
vi.mock("localforage", () => ({ default: { createInstance: () => ({ setItem: mocks.setItem }) } }));
vi.mock("../image-utils", () => ({ readImageMeta: async () => ({ width: 100, height: 100, mimeType: "image/png" }) }));
import { uploadImage } from "../image-storage";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("URL", { createObjectURL: () => "blob:saved" });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("image download validation", () => {
  it("rejects an HTTP error before writing its body to IndexedDB", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    await expect(uploadImage("/api/nova/images/missing/0")).rejects.toThrow(/404/);
    expect(mocks.setItem).not.toHaveBeenCalled();
  });
  it("rejects an HTML error page returned with status 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>error</html>", { headers: { "Content-Type": "text/html" } })));
    await expect(uploadImage("/api/nova/images/task/0")).rejects.toThrow(/text\/html/);
    expect(mocks.setItem).not.toHaveBeenCalled();
  });
  it("retries a transient download failure and persists once", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(new Response("png", { headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(uploadImage("/api/nova/images/task/0", { attempts: 2 })).resolves.toMatchObject({ storageKey: expect.any(String) });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.setItem).toHaveBeenCalledOnce();
  });
  it("limits a stalled image body, without writing or retrying forever", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation((_url, { signal }) => Promise.resolve({ ok: true, blob: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) }));
    vi.stubGlobal("fetch", fetch);
    const pending = expect(uploadImage("/api/nova/images/task/0", { timeoutMs: 10, attempts: 2 })).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(25);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.setItem).not.toHaveBeenCalled();
  });
});
