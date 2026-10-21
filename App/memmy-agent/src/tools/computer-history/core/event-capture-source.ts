/** The recorder remains owned by Computer History; consumers own subscriptions. */
export interface CaptureRange { from: string; through?: string }
export interface CaptureCheckpoint {
  streams: Array<{ id: string; file: string; size: number }>;
  running: boolean;
  /** A confirmed native-to-disk watermark; absent sources are conservatively partial. */
  complete?: boolean;
  /** Completeness was evaluated for the requested interval, not the process lifetime. */
  rangeEvaluated?: boolean;
  limitations: string[];
}
export interface EventCaptureSubscription {
  checkpoint(range?: CaptureRange): Promise<CaptureCheckpoint>;
  release(): Promise<void>;
}
export interface EventCaptureSource {
  acquireEventCapture(): Promise<EventCaptureSubscription>;
}
