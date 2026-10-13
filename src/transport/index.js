/**
 * Interfaz común de transporte (la implementan mock, mqtt y http):
 *
 *   connect()            abre la conexión
 *   send(message)        envía un mensaje `cmd` del contrato
 *   onMessage(cb)        recibe mensajes state / event / ack (ya parseados); devuelve función para desuscribir
 *   onStatus(cb)         'connecting' | 'online' | 'offline'; devuelve función para desuscribir
 *   close()
 *
 * La UI nunca usa un transporte directo: pasa por src/core/device-client.js.
 */
import { createMockTransport } from './mock.js';

export function createTransport(config) {
  switch (config.transport) {
    case 'mock':
      return createMockTransport(config);
    default:
      // Paso 4, en espera hasta confirmar el microcontrolador y su conectividad.
      throw new Error(`Transporte "${config.transport}" todavía no implementado. Usá VITE_TRANSPORT=mock.`);
  }
}
