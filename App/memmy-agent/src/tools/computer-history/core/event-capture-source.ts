/** The recorder remains owned by Computer History; consumers own subscriptions. */
export interface CaptureCheckpoint {
  streams: Array<{ id: string; file: string; size: number }>;
  running: boolean;
  /** A confirmed native-to-disk watermark; absent sources are conservatively partial. */
  complete?: boolean;
  limitations: string[];
}
export interface EventCaptureSubscription {
  checkpoint(): Promise<CaptureCheckpoint>;
  release(): Promise<void>;
}
export interface EventCaptureSource {
  acquireEventCapture(): Promise<EventCaptureSubscription>;
}
