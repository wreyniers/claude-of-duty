/**
 * Minimal synchronous pub/sub. Subsystems communicate through this rather than
 * holding direct references, so any module can be rewritten in isolation.
 */
export class EventBus {
  constructor() {
    this._handlers = new Map();
    this._any = new Set();
  }

  /**
   * Observe every event. This exists for the debug overlay and the automated
   * playtest, which need to assert that a subsystem announced something without
   * having to enumerate the event names it might use.
   */
  onAny(fn) {
    this._any.add(fn);
    return () => this._any.delete(fn);
  }

  on(type, fn) {
    let set = this._handlers.get(type);
    if (!set) this._handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(type, fn) {
    this._handlers.get(type)?.delete(fn);
  }

  emit(type, payload) {
    // Observers run before the early-out, or an event with no subscriber would
    // be invisible to them — which is exactly the case a test wants to see.
    if (this._any.size) for (const fn of this._any) fn(type, payload);
    const set = this._handlers.get(type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] handler for "${type}" threw`, err);
      }
    }
  }
}
