export class Events {
  #listeners = new Map();

  on(type, listener) {
    if (typeof listener !== 'function') throw new TypeError('Listener must be a function');
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(listener);
    return () => this.off(type, listener);
  }

  once(type, listener) {
    const off = this.on(type, (detail) => { off(); listener(detail); });
    return off;
  }

  off(type, listener) { this.#listeners.get(type)?.delete(listener); }

  emit(type, detail) {
    for (const listener of [...(this.#listeners.get(type) || [])]) {
      try { listener(detail); } catch (error) { console.error(`OctoPlayer ${type} listener:`, error); }
    }
  }

  clear() { this.#listeners.clear(); }
}
