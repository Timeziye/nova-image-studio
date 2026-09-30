import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), ack: vi.fn(), upload: vi.fn() }));
vi.mock("@/lib/ccode-task-client", () => ({ getNovaTask: mocks.get, ackNovaTask: mocks.ack }));
vi.mock("../lib/image-storage", () => ({ uploadImage: mocks.upload }));
import { checkExistingTask, pollNodeTask } from "../canvas-generation-service";

const image = { storageKey: "image:saved", url: "blob:saved", width: 100, height: 100, mimeType: "image/png", bytes: 100 };
describe("canvas result retrieval", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.get.mockResolvedValue({ status: "completed", result: { images: ["URL:/api/nova/images/task/0"] } });
    mocks.ack.mockResolvedValue(undefined);
    mocks.upload.mockResolvedValue(image);
  });

  it.each([pollNodeTask, checkExistingTask])("preserves the completed task when image storage fails", async (retrieve) => {
    mocks.upload.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(retrieve("task", vi.fn())).rejects.toThrow(/Failed to fetch/);
    expect(mocks.ack).not.toHaveBeenCalled();
  });

  it("does not acknowledge a partially saved multi-image result", async () => {
    mocks.get.mockResolvedValue({ status: "completed", result: { images: ["URL:/api/nova/images/task/0", "URL:/api/nova/images/task/1"] } });
    mocks.upload.mockResolvedValueOnce(image).mockRejectedValueOnce(new Error("IndexedDB write failed"));
    await expect(pollNodeTask("task", vi.fn())).rejects.toThrow(/IndexedDB write failed/);
    expect(mocks.ack).not.toHaveBeenCalled();
  });

  it("acknowledges only after local persistence completes", async () => {
    let finish!: (value: typeof image) => void;
    mocks.upload.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const result = pollNodeTask("task", vi.fn());
    await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalled());
    expect(mocks.ack).not.toHaveBeenCalled();
    finish(image);
    await expect(result).resolves.toEqual([image]);
    expect(mocks.ack).toHaveBeenCalledOnce();
  });

  it("retains saved results when the acknowledgement request fails", async () => {
    mocks.ack.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(checkExistingTask("task")).resolves.toMatchObject({ status: "completed", images: [image] });
  });
  it("retries a transient task polling failure without creating a new task", async () => {
    vi.useFakeTimers();
    mocks.get.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const result = pollNodeTask("task", vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual([image]);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.ack).toHaveBeenCalledOnce();
  });
});
