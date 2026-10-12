const KEY = 'starthome.session';
export const REMEMBER_DAYS = 30;

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    // Storage bloqueado (modo privado, cookies deshabilitadas): seguimos sin persistir.
    return fallback;
  }
}

/**
 * Guarda la sesión en localStorage («mantener la sesión iniciada») o en sessionStorage (se borra al cerrar
 * la pestaña). Los storages se inyectan para poder testear sin navegador.
 */
export function createSessionStore({ local, session, now = () => Date.now() }) {
  function read(storage) {
    const raw = safe(() => storage?.getItem(KEY), null);
    if (!raw) return null;
    const data = safe(() => JSON.parse(raw), null);
    if (!data || typeof data.token !== 'string' || !data.user) return null;
    if (data.expiresAt && data.expiresAt <= now()) {
      safe(() => storage.removeItem(KEY));
      return null;
    }
    return data;
  }

  return {
    save({ token, user }, remember) {
      const data = {
        token,
        user,
        remember: !!remember,
        expiresAt: remember ? now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000 : null,
      };
      const target = remember ? local : session;
      const other = remember ? session : local;
      safe(() => other?.removeItem(KEY));
      safe(() => target?.setItem(KEY, JSON.stringify(data)));
      return data;
    },
    load() {
      return read(session) || read(local);
    },
    clear() {
      safe(() => local?.removeItem(KEY));
      safe(() => session?.removeItem(KEY));
    },
  };
}

export function browserSessionStore() {
  return createSessionStore({
    local: safe(() => window.localStorage, null),
    session: safe(() => window.sessionStorage, null),
  });
}
