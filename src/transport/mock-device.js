/**
 * Dispositivo virtual: hace de micro para el transporte mock. Recibe comandos del contrato, los pasa por la
 * máquina de estados y publica exactamente lo que publicaría el hardware (events, state, ack).
 */
import { createInitialState, step, toSnapshot } from '../core/alarm-machine.js';
import { makeAck, makeEvent, makeState, validateMessage } from '../core/contract.js';

export function createMockDevice({
  deviceId,
  publish, // (message) => void
  initialState = createInitialState(),
  onStateChange = () => {}, // para persistir el estado entre recargas
  setInterval: setIntervalFn = globalThis.setInterval.bind(globalThis),
  clearInterval: clearIntervalFn = globalThis.clearInterval.bind(globalThis),
  now = () => Date.now(),
}) {
  let state = initialState;
  let timer = null;
  const opts = () => ({ deviceId });

  function publishState() {
    publish(makeState(toSnapshot(state), opts()));
  }

  function apply(result) {
    for (const e of result.events) publish(makeEvent(e, opts()));
    if (result.state !== state) {
      const wasCounting = !!(state.countdown || state.exit_countdown);
      state = result.state;
      // Una cuenta que recién empieza tiene que durar segundos enteros desde ahora.
      if (!wasCounting && (state.countdown || state.exit_countdown)) lastTickAt = now();
      onStateChange(state);
      publishState();
    }
  }

  // Durante una cuenta regresiva cada tick cambia remaining_s, así que se republica `state` cada segundo
  // (como pide el contrato). Fuera de una cuenta el tick no cambia nada y no se publica.
  // Los navegadores espacian los timers de pestañas en segundo plano (hasta 1 por minuto), así que los
  // ticks se calculan por reloj: se aplican tantos como segundos pasaron desde el último.
  let lastTickAt = 0;
  function tick() {
    const elapsed = Math.floor((now() - lastTickAt) / 1000);
    for (let i = 0; i < elapsed; i++) apply(step(state, { type: 'tick' }));
    lastTickAt += elapsed * 1000;
  }

  return {
    get state() {
      return state;
    },

    start() {
      if (!timer) {
        lastTickAt = now();
        timer = setIntervalFn(tick, 100);
      }
      publishState();
    },

    stop() {
      if (timer) clearIntervalFn(timer);
      timer = null;
    },

    /** Procesa un mensaje `cmd` del contrato y responde con su `ack`. */
    handle(message) {
      const errors = validateMessage(message);
      if (message?.type !== 'cmd') return;
      if (errors.length) {
        const unknown = errors.some((e) => e.startsWith('payload.cmd'));
        publish(makeAck(message.id ?? 'desconocido', { ok: false, error: unknown ? 'unknown_command' : 'invalid_payload' }, opts()));
        return;
      }
      const result = step(state, { type: 'cmd', ...message.payload });
      apply(result);
      if (message.payload.cmd === 'get_state') publishState();
      publish(makeAck(message.id, result, opts()));
    },

    publishState,

    /** Solo mock: vuelve al estado inicial (desarmado, sensores en reposo) y lo publica. */
    reset(fresh = createInitialState()) {
      state = fresh;
      lastTickAt = now();
      publishState();
    },
  };
}
