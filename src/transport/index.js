import { createMockTransport } from './mock.js';

export function createTransport(config) {
  // Usamos el transporte mock interno para que cargue los sensores y el estado visual
  const baseTransport = createMockTransport(config);

  return {
    ...baseTransport,
    // Sobrescribimos el send para que, además de actualizar la app, mande el HTTP a tu Node.js
    send: (message) => {
      baseTransport.send(message);

      fetch('https://backend-smarthome-axel.loca.lt/api/simular', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'bypass-tunnel-reminder': 'true'
        },
        body: JSON.stringify(message)
      })
      .then(res => console.log('[SmartHome] Evento enviado a Node:', res.status))
      .catch(err => console.error('[SmartHome] Error enviando a Node:', err));
    }
  };
}