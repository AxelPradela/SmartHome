import { describe, it, expect, vi } from 'vitest';
import { createAuthApi, isValidEmail } from '../src/auth/auth-api.js';
import { readConfig } from '../src/core/config.js';

const mockConfig = readConfig({ VITE_MOCK_EMAIL: 'demo@starthome.local', VITE_MOCK_PASSWORD: 'secreto' });

describe('isValidEmail', () => {
  it.each([['a@b.co', true], ['  a@b.co ', true], ['a@b', false], ['', false], ['a b@c.d', false]])('%s → %s', (e, ok) => {
    expect(isValidEmail(e)).toBe(ok);
  });
});

describe('auth mock', () => {
  const api = createAuthApi(mockConfig, { latencyMs: 0 });

  it('acepta las credenciales de prueba (email sin distinguir mayúsculas)', async () => {
    const r = await api.login(' Demo@StartHome.local ', 'secreto');
    expect(r.token).toMatch(/^mock-/);
    expect(r.user.email).toBe('demo@starthome.local');
  });

  it('rechaza contraseña incorrecta', async () => {
    await expect(api.login('demo@starthome.local', 'otra')).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('valida la entrada antes de llamar al backend', async () => {
    await expect(api.login('no-es-mail', 'x')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(api.login('demo@starthome.local', '')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(api.recover('mal')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('recover responde ok sin revelar si el correo existe', async () => {
    await expect(api.recover('cualquiera@x.com')).resolves.toEqual({ ok: true });
  });
});

describe('auth http (n8n)', () => {
  const httpConfig = readConfig({ VITE_AUTH: 'http', VITE_N8N_URL: 'https://n8n.test/webhook/' });
  const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  it('hace POST a /auth/login y devuelve token y usuario', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { token: 'abc', user: { email: 'u@x.com' } }));
    const api = createAuthApi(httpConfig, { fetchImpl });
    await expect(api.login('u@x.com', 'p', true)).resolves.toEqual({ token: 'abc', user: { email: 'u@x.com' } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://n8n.test/webhook/auth/login');
    expect(JSON.parse(init.body)).toEqual({ email: 'u@x.com', password: 'p', remember: true });
  });

  it('401 → invalid_credentials, 500 → server, sin red → network', async () => {
    const make = (impl) => createAuthApi(httpConfig, { fetchImpl: impl });
    await expect(make(async () => jsonResponse(401, {})).login('u@x.com', 'p')).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(make(async () => jsonResponse(500, {})).login('u@x.com', 'p')).rejects.toMatchObject({ code: 'server' });
    await expect(make(async () => { throw new TypeError('fail'); }).login('u@x.com', 'p')).rejects.toMatchObject({ code: 'network' });
  });

  it('respuesta sin token → server', async () => {
    const api = createAuthApi(httpConfig, { fetchImpl: async () => jsonResponse(200, { ok: true }) });
    await expect(api.login('u@x.com', 'p')).rejects.toMatchObject({ code: 'server' });
  });
});

describe('readConfig', () => {
  it('usa valores por defecto y descarta valores desconocidos', () => {
    const c = readConfig({ VITE_TRANSPORT: 'websocket', VITE_AUTH: 'http' });
    expect(c.transport).toBe('mock');
    expect(c.auth).toBe('http');
    expect(c.deviceId).toBe('casa-01');
  });
});
