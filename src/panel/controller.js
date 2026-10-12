/**
 * Une transporte, cliente, store e historial. No toca el DOM: las vistas se suscriben al store y llaman a
 * las acciones. Testeable con un transporte falso.
 */
import { createDeviceClient } from '../core/device-client.js';
import { createStore } from '../core/store.js';
import { advanceContext, formatEvent, formatTime, pushLog } from './log-format.js';
import { commandErrorText } from './view-model.js';

export function createPanelController({ transport, config, now = () => Date.now(), ackTimeoutMs, errorTimeoutMs = 6000 }) {
  const store = createStore({
    conn: 'connecting',
    device: null, // último snapshot (payload de `state`)
    receivedAt: 0, // cuándo llegó, para interpolar las cuentas regresivas
    ctx: null, // contexto para formatear eventos (ver advanceContext)
    pending: null, // comando esperando ack
    error: null,
    log: [],
    demo: config.demo,
    canResetDemo: config.demo && typeof transport.resetDemo === 'function', // solo con el mock
    alarmId: null, // id del último alarm.triggered de la alarma en curso
    alarmIds: [], // alarmas recientes, para registrar notificaciones que lleguen tarde
    notification: null, // notification.sent de la alarma en curso: { ok, simulated, channel, error }
  });

  const MAX_ALARM_IDS = 10;

  const log = (text, level, at = now()) =>
    store.update((s) => ({ ...s, log: pushLog(s.log, { t: formatTime(at), text, level }) }));

  let everOnline = false;
  let errorTimer = null;

  const client = createDeviceClient(transport, {
    deviceId: config.deviceId,
    ackTimeoutMs,
    onStatus(conn) {
      store.update((s) => ({ ...s, conn }));
      if (conn === 'online') {
        log(everOnline ? 'Conexión recuperada con el dispositivo' : 'Conectado al dispositivo', 'info');
        everOnline = true;
      } else if (conn === 'offline' && everOnline) {
        log('Se perdió la conexión con el dispositivo', 'alarm');
      }
    },
    onState(device) {
      store.update((s) => {
        const next = { ...s, device, ctx: device, receivedAt: now() };
        // Fuera de alarma no hay aviso que mostrar; la próxima alarma espera su propia notificación.
        if (device.mode !== 'alarma') Object.assign(next, { alarmId: null, notification: null });
        return next;
      });
    },
    onEvent(event, msg) {
      store.update((s) => {
        let extra = {};
        if (event.event === 'alarm.triggered') {
          extra = { alarmId: msg.id, alarmIds: [msg.id, ...s.alarmIds].slice(0, MAX_ALARM_IDS), notification: null };
        } else if (event.event === 'notification.sent') {
          // Una notificación de una alarma desconocida (p. ej. anterior a "Reiniciar demo") se ignora.
          if (!s.alarmIds.includes(event.ref)) return s;
          if (event.ref === s.alarmId) {
            extra = { notification: { ok: event.ok, simulated: !!event.simulated, channel: event.channel, error: event.error ?? null } };
          }
        }
        s = { ...s, ...extra };
        const line = formatEvent(event, s.ctx);
        const ctx = advanceContext(s.ctx, event);
        if (!line) return { ...s, ctx };
        const at = Date.parse(msg.ts) || now();
        return { ...s, ctx, log: pushLog(s.log, { t: formatTime(at), ...line }) };
      });
    },
  });

  // Reiniciar demo (solo mock): todas las pestañas limpian historial y avisos; el estado nuevo llega solo.
  transport.onDemoReset?.(() => {
    clearTimeout(errorTimer);
    store.update((s) => ({
      ...s, error: null, alarmId: null, alarmIds: [], notification: null,
      log: [{ t: formatTime(now()), text: 'Demo reiniciada · todo desarmado y en reposo', level: 'info' }],
    }));
  });

  async function run(payload) {
    if (store.get().pending) return false;
    clearTimeout(errorTimer);
    store.update((s) => ({ ...s, pending: payload.cmd, error: null }));
    try {
      await client.command(payload);
      return true;
    } catch (err) {
      store.update((s) => ({ ...s, error: commandErrorText(payload.cmd, err.code) }));
      errorTimer = setTimeout(() => store.update((s) => ({ ...s, error: null })), errorTimeoutMs);
      return false;
    } finally {
      store.update((s) => ({ ...s, pending: null }));
    }
  }

  return {
    store,
    start: () => client.connect(),
    stop: () => client.close(),
    arm: () => run({ cmd: 'arm' }),
    disarm: () => run({ cmd: 'disarm' }),
    silence: () => run({ cmd: 'silence_siren' }),
    simulate(sensor) {
      const device = store.get().device;
      if (!device) return Promise.resolve(false);
      return run({ cmd: 'simulate', sensor, active: !device.sensors[sensor].active });
    },
    simulateAll: () => run({ cmd: 'simulate_all' }),
    resetDemo() {
      if (store.get().canResetDemo) transport.resetDemo();
    },
  };
}
