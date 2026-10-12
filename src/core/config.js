const TRANSPORTS = ['mock', 'mqtt', 'http'];
const AUTHS = ['mock', 'http'];

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** Normaliza las variables VITE_* en un objeto de configuración con valores por defecto seguros. */
export function readConfig(env = {}) {
  return {
    transport: pick(env.VITE_TRANSPORT, TRANSPORTS, 'mock'),
    auth: pick(env.VITE_AUTH, AUTHS, 'mock'),
    mockEmail: env.VITE_MOCK_EMAIL || 'demo@smarthome.local',
    mockPassword: env.VITE_MOCK_PASSWORD || 'smarthome',
    n8nUrl: (env.VITE_N8N_URL || '').replace(/\/+$/, ''),
    deviceId: env.VITE_DEVICE_ID || 'casa-01',
  };
}

export const config = readConfig(import.meta.env);
