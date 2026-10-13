import { createMockTransport } from './mock.js';

export function createTransport(config) {
  switch (config.transport) {
    case 'mock':
      return createMockTransport(config);

    case 'http':
      // Transporte personalizado para conectar con Node.js via Localtunnel
      return {
        connect: () => {},
        send: (message) => {
          fetch('https://backend-smarthome-axel.loca.lt/api/simular', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'bypass-tunnel-reminder': 'true'
            },
            body: JSON.stringify(message)
          })
          .then(() => console.log('[SmartHome] Evento enviado correctamente a Node.js'))
          .catch(err => console.error('[SmartHome] Error enviando evento a Node.js:', err));
        },
        onMessage: () => () => {},
        onStatus: (cb) => {
          cb('online');
          return () => {};
        },
        close: () => {}
      };

    default:
      // Si no es 'mock' ni 'http', falla con aviso
      throw new Error(`Transporte "${config.transport}" no soportado.`);
  }
}