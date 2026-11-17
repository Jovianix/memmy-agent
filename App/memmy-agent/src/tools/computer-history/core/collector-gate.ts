/** One History collector, including asynchronous startup/teardown. */
export class CollectorGate {
  private owner: "history" | null = null;
  get busy(): boolean { return this.owner !== null; }
  acquire(owner: "history"): () => void {
    if (this.owner) throw new CollectorBusyError();
    this.owner = owner;
    let released = false;
    return () => { if (!released) { released = true; this.owner = null; } };
  }
}
export class CollectorBusyError extends Error {
  readonly status = 409;
  constructor() { super("collector_busy: Computer History collector is already running"); }
}
export const collectorGate = new CollectorGate();
