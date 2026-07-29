/**
 * Minimal synchronous pub/sub. Subsystems communicate through this rather than
 * holding direct references, so any module can be rewritten in isolation.
 */
export class EventBus {
  constructor() {
    this._handlers = new Map();
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
