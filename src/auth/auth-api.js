export class AuthError extends Error {
  /** @param {'invalid_credentials'|'invalid_input'|'network'|'server'} code */
  constructor(code, message = code) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email) {
  return EMAIL_RE.test(String(email).trim());
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomToken() {
  return 'mock-' + (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));
}

/**
 * Login con credenciales de prueba. Simula la latencia de red para que la UI muestre su estado de carga.
 * Las credenciales viven en el bundle público: esto NO es seguridad, solo un reemplazo del webhook de n8n.
 */
function createMockAuth(config, { latencyMs = 400 } = {}) {
  return {
    async login(email, password) {
      await delay(latencyMs);
      const ok = email.trim().toLowerCase() === config.mockEmail.toLowerCase() && password === config.mockPassword;
      if (!ok) throw new AuthError('invalid_credentials');
      return { token: randomToken(), user: { email: config.mockEmail, name: 'Usuario demo' } };
    },
    async recover() {
      await delay(latencyMs);
      // Igual que un backend real: no revela si el correo existe.
      return { ok: true };
    },
  };
}

/** Login contra los webhooks de n8n: POST {base}/auth/login y POST {base}/auth/recover. */
function createHttpAuth(config, fetchImpl) {
  async function post(path, body) {
    let res;
    try {
      res = await fetchImpl(`${config.n8nUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new AuthError('network');
    }
    if (res.status === 401 || res.status === 403) throw new AuthError('invalid_credentials');
    if (!res.ok) throw new AuthError('server', `HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new AuthError('server', 'respuesta no es JSON');
    }
  }

  return {
    async login(email, password, remember) {
      const data = await post('/auth/login', { email: email.trim(), password, remember });
      if (!data || typeof data.token !== 'string' || !data.user) throw new AuthError('server', 'respuesta incompleta');
      return { token: data.token, user: data.user };
    },
    async recover(email) {
      await post('/auth/recover', { email: email.trim() });
      return { ok: true };
    },
  };
}

export function createAuthApi(config, { fetchImpl = globalThis.fetch?.bind(globalThis), latencyMs } = {}) {
  const impl = config.auth === 'http' ? createHttpAuth(config, fetchImpl) : createMockAuth(config, { latencyMs });
  return {
    async login(email, password, remember = false) {
      if (!isValidEmail(email) || !password) throw new AuthError('invalid_input');
      return impl.login(email, password, remember);
    },
    async recover(email) {
      if (!isValidEmail(email)) throw new AuthError('invalid_input');
      return impl.recover(email);
    },
  };
}
