/**
 * Transporte mock: un dispositivo virtual dentro del navegador que habla el mismo contrato que el micro.
 *
 * Varias pestañas: una sola hace de "dispositivo" (la que tiene el Web Lock); las demás le mandan comandos
 * y reciben state/event/ack por BroadcastChannel. Si esa pestaña se cierra, otra toma el lock y sigue con el
 * estado guardado en localStorage. Sin Web Locks o BroadcastChannel (o pasando `null`), cada pestaña tiene su
 * propio dispositivo.
 */
import { createInitialState, MODES } from '../core/alarm-machine.js';
import { makeCommand, makeEvent } from '../core/contract.js';
import { createMockDevice } from './mock-device.js';

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Estado guardado por una sesión anterior del mock; si está corrupto o es de otra versión, se descarta. */
function loadState(storage, key) {
  const saved = safe(() => JSON.parse(storage?.getItem(key)), null);
  const fresh = createInitialState();
  if (!saved || !MODES.includes(saved.mode) || typeof saved.sensors !== 'object') return fresh;
  const same = (a, b) => Object.keys(a).sort().join() === Object.keys(b).sort().join();
  if (!same(saved, fresh) || !same(saved.sensors, fresh.sensors) || !same(saved.config, fresh.config)) return fresh;
  return saved;
}

export function createMockTransport(config, {
  latencyMs = 120,
  notifyDelayMs = 800, // lo que tarda el "n8n simulado" en mandar el Telegram
  storage = safe(() => globalThis.localStorage, null),
  BroadcastChannelImpl = globalThis.BroadcastChannel,
  locks = globalThis.navigator?.locks,
} = {}) {
  const key = `smarthome.mock.${config.deviceId}`;
  const messageListeners = new Set();
  const statusListeners = new Set();
  const resetListeners = new Set();
  let status = 'connecting';
  let device = null;
  let channel = null;
  let closed = false;
  let releaseLock = () => {};

  const later = (fn) => setTimeout(() => !closed && fn(), latencyMs);

  function setStatus(next) {
    if (status === next) return;
    status = next;
    statusListeners.forEach((cb) => cb(next));
  }

  function deliver(message) {
    if (message.type === 'state') setStatus('online');
    messageListeners.forEach((cb) => cb(message));
  }

  /** Publica a esta pestaña (con latencia simulada) y a las demás. */
  function broadcast(message) {
    later(() => deliver(message));
    safe(() => channel?.postMessage(message));
  }

  // "n8n simulado": ante cada alarma publica la notificación, marcada como simulada para que la UI
  // no diga que se envió un Telegram real.
  function simulateNotification(alarmEvent) {
    setTimeout(() => {
      if (closed) return;
      const payload = { event: 'notification.sent', channel: 'telegram', ok: true, ref: alarmEvent.id, simulated: true };
      broadcast(makeEvent(payload, { deviceId: config.deviceId }));
    }, notifyDelayMs);
  }

  function becomeDevice() {
    device = createMockDevice({
      deviceId: config.deviceId,
      initialState: loadState(storage, key),
      onStateChange: (s) => safe(() => storage?.setItem(key, JSON.stringify(s))),
      publish(message) {
        broadcast(message);
        if (message.type === 'event' && message.payload.event === 'alarm.triggered') simulateNotification(message);
      },
    });
    device.start();
  }

  // Lo ejecuta solo la pestaña-dispositivo; avisa a todas para que limpien su historial.
  function resetAsDevice() {
    safe(() => storage?.removeItem(key));
    resetListeners.forEach((cb) => cb());
    safe(() => channel?.postMessage({ type: 'mock.reset.done' }));
    device.reset();
  }

  return {
    get status() {
      return status;
    },

    connect() {
      if (BroadcastChannelImpl && locks?.request) {
        channel = new BroadcastChannelImpl(`smarthome-mock-${config.deviceId}`);
        channel.onmessage = ({ data }) => {
          if (!data || closed) return;
          if (data.type === 'cmd') device?.handle(data); // solo responde la pestaña-dispositivo
          else if (data.type === 'mock.reset') device && resetAsDevice();
          else if (data.type === 'mock.reset.done') resetListeners.forEach((cb) => cb());
          else deliver(data);
        };
        // El callback corre cuando esta pestaña obtiene el lock y lo retiene mientras esté abierta.
        locks.request(`smarthome-mock-${config.deviceId}`, () => {
          if (closed) return undefined;
          becomeDevice();
          return new Promise((resolve) => { releaseLock = resolve; }); // se libera en close()
        });
        // Si ya hay otra pestaña-dispositivo, pedirle el estado actual.
        later(() => !device && channel.postMessage(makeCommand({ cmd: 'get_state' }, { deviceId: config.deviceId })));
      } else {
        becomeDevice();
      }
    },

    send(message) {
      if (closed) throw new Error('transporte cerrado');
      if (device) later(() => device.handle(message));
      else channel.postMessage(message);
    },

    onMessage(cb) {
      messageListeners.add(cb);
      return () => messageListeners.delete(cb);
    },

    onStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },

    /**
     * Solo mock (no es parte del contrato): borra el estado guardado y vuelve a desarmado con los sensores
     * en reposo, en todas las pestañas.
     */
    resetDemo() {
      if (closed) return;
      if (device) resetAsDevice();
      else channel?.postMessage({ type: 'mock.reset' });
    },

    onDemoReset(cb) {
      resetListeners.add(cb);
      return () => resetListeners.delete(cb);
    },

    close() {
      closed = true;
      device?.stop();
      releaseLock();
      safe(() => channel?.close());
      setStatus('offline');
    },
  };
}
