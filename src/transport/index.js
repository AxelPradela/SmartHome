import { createMockTransport } from './mock.js';

export function createTransport(config) {
  // Forzamos directamente la conexión HTTP hacia tu Node.js por Localtunnel
  return {
    connect: () => {},
    send: (message) => {
      console.log('[SmartHome] Enviando mensaje a Node.js:', message);
      fetch('https://backend-smarthome-axel.loca.lt/api/simular', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'bypass-tunnel-reminder': 'true'
        },
        body: JSON.stringify(message)
      })
      .then(res => console.log('[SmartHome] Respuesta del servidor Node:', res.status))
      .catch(err => console.error('[SmartHome] Error enviando evento a Node:', err));
    },
    onMessage: () => () => {},
    onStatus: (cb) => {
      cb('online');
      return () => {};
    },
    close: () => {}
  };
}