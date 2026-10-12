/** Store mínimo: un objeto de estado, actualizaciones inmutables y suscriptores que se llaman en cada cambio. */
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    update(fn) {
      const next = fn(state);
      if (next === state) return;
      state = next;
      listeners.forEach((cb) => cb(state));
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
