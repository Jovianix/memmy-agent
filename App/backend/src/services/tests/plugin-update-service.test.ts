import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginUpdateService } from "../plugin-update-service.js";
import { compareVersions, type PluginService } from "../plugin-service.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  let busy = false;
  const update = vi.fn(async () => ({})), catalog = vi.fn(async () => [{ id: "teach-mode", version: "0.2.0" }, { id: "not-installed", version: "1.0.0" }]);
  const plugins = { list: () => [{ id: "teach-mode", version: "0.1.0", state: "active", manifest: { updateMode: "automatic" } }],
    catalog, isBusy: () => busy, update } as unknown as PluginService;
  return { plugins, update, catalog, setBusy: (value: boolean) => { busy = value; } };
}
describe("automatic plugin updates", () => {
  it("checks at startup and every six hours, without automatically installing catalog entries", async () => {
    vi.useFakeTimers(); const f = fixture(), updates = createPluginUpdateService(f.plugins);
    updates.start(); await vi.advanceTimersByTimeAsync(0); expect(f.update).toHaveBeenCalledWith("teach-mode", "0.2.0");
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); expect(f.catalog).toHaveBeenCalledTimes(2); expect(f.update).toHaveBeenCalledTimes(2);
    await updates.close(); await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); expect(f.catalog).toHaveBeenCalledTimes(2);
  });
  it("defers while the plugin owns a recording lease or active call", async () => {
    const f = fixture(), updates = createPluginUpdateService(f.plugins); f.setBusy(true);
    await updates.check(); expect(f.update).not.toHaveBeenCalled();
    f.setBusy(false); await updates.check(); expect(f.update).toHaveBeenCalledTimes(1); await updates.close();
  });
  it("leaves a failed update and offline check recoverable", async () => {
    const f = fixture(), updates = createPluginUpdateService(f.plugins);
    f.update.mockRejectedValueOnce(new Error("checksum mismatch")); await updates.check();
    f.catalog.mockRejectedValueOnce(new Error("offline")); await expect(updates.check()).rejects.toThrow("offline");
    await updates.check(); expect(f.update).toHaveBeenCalledTimes(2); await updates.close();
  });
  it("orders prereleases and stable versions correctly", () => {
    expect(compareVersions("1.2.3-rc.7", "1.2.3-rc.6")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3-rc.7", "1.2.3")).toBeLessThan(0);
    expect(compareVersions("1.2.10", "1.2.9")).toBeGreaterThan(0);
  });
});
