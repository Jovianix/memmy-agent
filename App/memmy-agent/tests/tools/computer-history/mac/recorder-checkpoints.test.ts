import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { recorderCheckpoints } from "../../../../src/tools/computer-history/mac/recorder-checkpoints.js";
const id = "c892ee91-1d7c-4b43-b149-97284fe3caff";

describe("recorder native-to-disk checkpoint", () => {
  it("acknowledges only the requested native barrier after queued writes finish", async () => {
    const input = new PassThrough(), write = vi.fn(), requestNative = vi.fn();
    let persist!: () => void; const written = new Promise<void>(resolve => { persist = resolve; });
    const queue = recorderCheckpoints({ input, write, requestNative, persist: () => written });
    try {
      input.write(JSON.stringify({ kind: "checkpoint", id }) + "\n"); expect(requestNative).toHaveBeenCalledWith(id);
      queue.acknowledge({ kind: "session.checkpoint", id: "unrelated", complete: true }); expect(write).not.toHaveBeenCalled();
      queue.acknowledge({ kind: "session.checkpoint", id, complete: true }); expect(write).not.toHaveBeenCalled();
      persist(); await delay(0); expect(JSON.parse(write.mock.calls[0]![0].slice(22))).toEqual({ id, complete: true });
    } finally { queue.close(); input.destroy(); }
  });
  it("reports unconfirmed completion when the native provider is absent or persistence fails", async () => {
    const input = new PassThrough(), write = vi.fn();
    const queue = recorderCheckpoints({ input, write, persist: async () => { throw new Error("disk failure"); } });
    try {
      input.write(JSON.stringify({ kind: "checkpoint", id }) + "\n"); await delay(0);
      expect(JSON.parse(write.mock.calls[0]![0].slice(22))).toEqual({ id, complete: false });
    } finally { queue.close(); input.destroy(); }
  });
  it("bounds a nonresponding provider and releases pending controls on shutdown", async () => {
    const input = new PassThrough(), write = vi.fn();
    const queue = recorderCheckpoints({ input, write, requestNative: () => {}, persist: async () => {}, timeoutMs: 5 });
    input.write(JSON.stringify({ kind: "checkpoint", id }) + "\n"); await delay(15);
    expect(JSON.parse(write.mock.calls[0]![0].slice(22)).complete).toBe(false);
    queue.close(); input.destroy();
  });
});
