import { describe, it, expect } from 'vitest';
import { createSessionStore, REMEMBER_DAYS } from '../src/auth/session.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get size() { return map.size; },
  };
}

const auth = { token: 't-1', user: { email: 'a@b.com' } };

describe('session store', () => {
  it('sin "mantener sesión" guarda en sessionStorage, sin vencimiento', () => {
    const local = memoryStorage(), session = memoryStorage();
    const store = createSessionStore({ local, session });
    store.save(auth, false);
    expect(session.size).toBe(1);
    expect(local.size).toBe(0);
    expect(store.load()).toMatchObject({ token: 't-1', remember: false, expiresAt: null });
  });

  it('con "mantener sesión" guarda en localStorage con vencimiento a 30 días', () => {
    const local = memoryStorage(), session = memoryStorage();
    let t = 1_000;
    const store = createSessionStore({ local, session, now: () => t });
    store.save(auth, true);
    expect(local.size).toBe(1);
    expect(store.load().expiresAt).toBe(1_000 + REMEMBER_DAYS * 86_400_000);
    t += REMEMBER_DAYS * 86_400_000;
    expect(store.load()).toBeNull();
    expect(local.size).toBe(0);
  });

  it('cambiar de modo borra la sesión del otro storage', () => {
    const local = memoryStorage(), session = memoryStorage();
    const store = createSessionStore({ local, session });
    store.save(auth, true);
    store.save(auth, false);
    expect(local.size).toBe(0);
    expect(session.size).toBe(1);
  });

  it('clear borra ambos', () => {
    const local = memoryStorage(), session = memoryStorage();
    const store = createSessionStore({ local, session });
    store.save(auth, true);
    store.clear();
    expect(store.load()).toBeNull();
  });

  it('ignora datos corruptos o incompletos', () => {
    const local = memoryStorage(), session = memoryStorage();
    session.setItem('smarthome.session', '{no es json');
    local.setItem('smarthome.session', JSON.stringify({ token: 1 }));
    expect(createSessionStore({ local, session }).load()).toBeNull();
  });

  it('no rompe si el storage tira excepción (modo privado)', () => {
    const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
    const store = createSessionStore({ local: broken, session: broken });
    expect(() => store.save(auth, true)).not.toThrow();
    expect(store.load()).toBeNull();
  });
});
