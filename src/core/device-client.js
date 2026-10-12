/**
 * Capa entre la UI y el transporte: valida cada mensaje entrante contra el contrato, descarta lo que no sirve
 * y convierte cada comando en una promesa que se resuelve con su `ack` (o falla por timeout).
 */
import { makeCommand, validateMessage } from './contract.js';

export class CommandError extends Error {
  /** @param {string} code error del ack del contrato, o 'timeout' / 'offline' */
  constructor(code) {
    super(code);
    this.name = 'CommandError';
    this.code = code;
  }
}

export function createDeviceClient(transport, {
  deviceId,
  ackTimeoutMs = 3000,
  onState = () => {},
  onEvent = () => {},
  onStatus = () => {},
  onInvalid = (msg, errors) => console.warn('[smarthome] mensaje descartado', errors, msg),
} = {}) {
  const pending = new Map();
  let lastStateTs = -Infinity;

  transport.onStatus(onStatus);
  transport.onMessage((msg) => {
    const errors = validateMessage(msg);
    if (errors.length) return onInvalid(msg, errors);
    if (msg.deviceId !== deviceId) return undefined; // otro dispositivo en el mismo broker

    switch (msg.type) {
      case 'state': {
        const ts = Date.parse(msg.ts);
        if (ts < lastStateTs) return undefined; // llegó tarde un snapshot viejo
        lastStateTs = ts;
        return onState(msg.payload, msg);
      }
      case 'event':
        return onEvent(msg.payload, msg);
      case 'ack': {
        const p = pending.get(msg.payload.ack);
        if (!p) return undefined; // ack de un comando de otra pestaña
        pending.delete(msg.payload.ack);
        clearTimeout(p.timer);
        return msg.payload.ok ? p.resolve(msg.payload) : p.reject(new CommandError(msg.payload.error));
      }
      default:
        return undefined; // `cmd` de otra pestaña: no es para la UI
    }
  });

  return {
    connect: () => transport.connect(),
    close() {
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new CommandError('offline'));
      }
      pending.clear();
      transport.close();
    },

    /** Envía un comando y espera su ack. Rechaza con CommandError. */
    command(payload) {
      if (transport.status === 'offline') return Promise.reject(new CommandError('offline'));
      const message = makeCommand(payload, { deviceId });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(message.id);
          reject(new CommandError('timeout'));
        }, ackTimeoutMs);
        pending.set(message.id, { resolve, reject, timer });
        try {
          transport.send(message);
        } catch {
          clearTimeout(timer);
          pending.delete(message.id);
          reject(new CommandError('offline'));
        }
      });
    },
  };
}
