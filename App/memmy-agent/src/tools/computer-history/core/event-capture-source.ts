import type { EventCaptureSession } from "@memmy/local-api-contracts";
import type { HistoryPermissions } from "./platform-driver.js";

/** The recorder remains owned by Computer History; consumers own subscriptions. */
export interface CaptureRange { from: string; through?: string }
export interface CaptureCheckpoint {
  streams: Array<{ id: string; file: string; size: number }>;
  running: boolean;
  /** A confirmed durable boundary with no known coverage gaps in the requested interval. */
  complete?: boolean;
  /** Completeness was evaluated for the requested interval, not the process lifetime. */
  rangeEvaluated?: boolean;
  /** The ordered boundary reached durable storage, independently of interval health. */
  boundaryConfirmed?: boolean;
  /** Failure of this collector run, retained after its process has been cleaned up. */
  failure?: EventCaptureStartError;
  limitations: string[];
}
export interface EventCaptureSubscription {
  checkpoint(range?: CaptureRange): Promise<CaptureCheckpoint>;
  release(): Promise<void>;
}
export interface EventCaptureSource {
  acquireEventCapture(signal?: AbortSignal): Promise<EventCaptureSubscription>;
}

/** Preserve the recorder's startup failure for the tool call and the saved session. */
export class EventCaptureStartError extends Error {
  private constructor(readonly status: number, readonly code: string, message: string,
    readonly stage: "permission-check" | "recorder-start", readonly preflight?: EventCaptureSession["preflight"],
    cause?: unknown) {
    super(message, { cause });
  }

  private static preflight(status: HistoryPermissions): EventCaptureSession["preflight"] {
    if (status.platform === "windows") return { platform: "windows", reason: status.reason ?? "collector_unavailable" };
    return { platform: "macos", accessibility: status.accessibility, inputMonitoring: status.inputMonitoring };
  }

  static fromPermissions(status: HistoryPermissions, stage: "permission-check" | "recorder-start" = "permission-check", cause?: Error) {
    const preflight = this.preflight(status);
    if (status.platform === "windows") {
      const reason = status.reason ?? "collector_unavailable";
      return new EventCaptureStartError(reason === "authorization_required" ? 403 : 503,
        reason, cause?.message ?? reason, stage, preflight, cause);
    }
    const missing = [];
    if (!status.accessibility) missing.push("Accessibility");
    if (!status.inputMonitoring) missing.push("Input Monitoring");
    return new EventCaptureStartError(403, "capture_permission_required",
      cause?.message ?? `capture_permission_required: enable ${missing.join(" and ")} for Memmy`, stage, preflight, cause);
  }

  static fromCause(stage: "permission-check" | "recorder-start", cause: unknown, permissions?: HistoryPermissions) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const status = cause instanceof Error && "status" in cause && typeof cause.status === "number" ? cause.status : 503;
    return new EventCaptureStartError(status, message, message, stage, permissions && this.preflight(permissions), cause);
  }
}
