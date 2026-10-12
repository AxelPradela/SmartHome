/**
 * Máquina de estados de Smart Home. Pura: no usa timers, red ni fecha; quien la usa le pasa entradas
 * (comandos, cambios de sensores, ticks de 1 s) y recibe el nuevo estado + los eventos a publicar.
 *
 * La usa el transporte mock como "dispositivo virtual" y sirve de especificación ejecutable para el
 * firmware: si el micro se comporta distinto que estos tests, uno de los dos está mal.
 */

export const MODES = ['desarmado', 'armado', 'intervencion', 'alarma'];

export const SENSORS = {
  puerta: { kind: 'door', name: 'Puerta principal' },
  ventanaLiving: { kind: 'window', name: 'Ventana living' },
  ventanaDorm: { kind: 'window', name: 'Ventana dormitorio' },
  movimiento: { kind: 'motion', name: 'Pasillo' },
  humo: { kind: 'smoke', name: 'Cocina' },
};
export const SENSOR_IDS = Object.keys(SENSORS);

/** Tiempo de entrada: cuenta regresiva de la intervención, para desarmar al llegar. */
export const ENTRY_DELAY = { default: 15, min: 5, max: 60 };
/** Tiempo de salida: al armar, ventana para salir de la casa sin disparar intervención. 0 = sin tiempo de salida. */
export const EXIT_DELAY = { default: 30, min: 0, max: 120 };

export function createInitialState({ entry_delay_s = ENTRY_DELAY.default, exit_delay_s = EXIT_DELAY.default } = {}) {
  return {
    armed: false,
    mode: 'desarmado',
    causes: [],
    countdown: null,
    exit_countdown: null,
    sensors: Object.fromEntries(SENSOR_IDS.map((id) => [id, false])),
    siren: 'off',
    lights: false,
    config: { entry_delay_s, exit_delay_s },
  };
}

/** LED según el estado. La sirena y las luces se guardan en el estado porque el usuario puede silenciar. */
export function ledFor(mode) {
  return {
    desarmado: { color: 'off', pattern: 'solid' },
    armado: { color: 'blue', pattern: 'solid' },
    intervencion: { color: 'amber', pattern: 'blink' },
    alarma: { color: 'red', pattern: 'blink' },
  }[mode];
}

/** Payload del mensaje `state` del contrato. */
export function toSnapshot(state) {
  return {
    mode: state.mode,
    armed: state.armed,
    causes: [...state.causes],
    countdown: state.countdown ? { ...state.countdown } : null,
    exit_countdown: state.exit_countdown ? { ...state.exit_countdown } : null,
    sensors: Object.fromEntries(SENSOR_IDS.map((id) => [id, { kind: SENSORS[id].kind, active: state.sensors[id] }])),
    outputs: { led: ledFor(state.mode), siren: state.siren, lights: state.lights },
    config: { ...state.config },
  };
}

// --- helpers internos ---------------------------------------------------------------------------

function withCause(causes, cause) {
  return causes.includes(cause) ? causes : [...causes, cause].sort(); // orden estable: intrusion, smoke
}

function enterMode(ctx, to, by) {
  if (ctx.state.mode !== to) {
    ctx.events.push({ event: 'mode.changed', from: ctx.state.mode, to, by });
    ctx.state = { ...ctx.state, mode: to };
  }
}

function triggerAlarm(ctx, cause, by) {
  const causes = withCause(ctx.state.causes, cause);
  const isNew = causes !== ctx.state.causes;
  enterMode(ctx, 'alarma', by);
  // Una causa nueva vuelve a hacer sonar la sirena aunque se haya silenciado antes.
  ctx.state = { ...ctx.state, causes, countdown: null, exit_countdown: null, lights: true, siren: isNew ? 'on' : ctx.state.siren };
  if (isNew) ctx.events.push({ event: 'alarm.triggered', causes: [...causes], by });
}

function arm(ctx, by, { skipExitDelay = false } = {}) {
  const wasArmed = ctx.state.armed;
  const total = skipExitDelay ? 0 : ctx.state.config.exit_delay_s;
  ctx.state = { ...ctx.state, armed: true, exit_countdown: total > 0 ? { remaining_s: total, total_s: total } : null };
  enterMode(ctx, 'armado', by);
  if (!wasArmed) ctx.events.push({ event: 'armed.changed', armed: true, by });
}

function reject(state, error) {
  return { state, events: [], ok: false, error };
}

function inRange(value, { min, max }) {
  return Number.isInteger(value) && value >= min && value <= max;
}

// --- entradas -----------------------------------------------------------------------------------

function onSensor(state, { sensor, active }) {
  if (!(sensor in SENSORS)) return reject(state, 'unknown_sensor');
  active = !!active;
  if (state.sensors[sensor] === active) return { state, events: [], ok: true }; // sin cambio, sin evento

  const by = `sensor:${sensor}`;
  const ctx = {
    state: { ...state, sensors: { ...state.sensors, [sensor]: active } },
    events: [{ event: 'sensor.changed', sensor, active }],
  };

  // Solo el flanco a "activo" es una detección; volver a reposo no cambia el estado del sistema.
  if (active) {
    if (SENSORS[sensor].kind === 'smoke') {
      // Si había una intrusión esperando confirmación, la alarma por humo corta la cuenta regresiva:
      // esa intrusión pasa a ser una causa más (varios riesgos simultáneos) en vez de perderse.
      if (state.mode === 'intervencion') ctx.state = { ...ctx.state, causes: withCause(ctx.state.causes, 'intrusion') };
      triggerAlarm(ctx, 'smoke', by); // el humo dispara siempre, armado o no
    } else if (state.mode === 'armado' && !state.exit_countdown) {
      enterMode(ctx, 'intervencion', by);
      const total = state.config.entry_delay_s;
      ctx.state = { ...ctx.state, countdown: { remaining_s: total, total_s: total }, siren: 'warning' };
    } else if (state.mode === 'alarma' && state.armed) {
      triggerAlarm(ctx, 'intrusion', by); // ya hay alarma: no tiene sentido otra cuenta regresiva
    }
    // desarmado / tiempo de salida / intervención en curso / alarma por humo desarmado: solo el sensor.changed
  }
  return { state: ctx.state, events: ctx.events, ok: true };
}

function onTick(state) {
  if (state.mode === 'armado' && state.exit_countdown) {
    const remaining = state.exit_countdown.remaining_s - 1;
    if (remaining > 0) {
      return { state: { ...state, exit_countdown: { ...state.exit_countdown, remaining_s: remaining } }, events: [], ok: true };
    }
    return { state: { ...state, exit_countdown: null }, events: [{ event: 'exit_delay.ended' }], ok: true };
  }

  if (state.mode === 'intervencion' && state.countdown) {
    const remaining = state.countdown.remaining_s - 1;
    if (remaining > 0) {
      return { state: { ...state, countdown: { ...state.countdown, remaining_s: remaining } }, events: [], ok: true };
    }
    const ctx = { state, events: [] };
    triggerAlarm(ctx, 'intrusion', 'timeout');
    return { state: ctx.state, events: ctx.events, ok: true };
  }

  return { state, events: [], ok: true };
}

function onCommand(state, cmd) {
  switch (cmd.cmd) {
    case 'arm': {
      if (state.mode !== 'desarmado') return reject(state, 'invalid_transition');
      const ctx = { state, events: [] };
      arm(ctx, 'web');
      return { state: ctx.state, events: ctx.events, ok: true };
    }

    case 'disarm': {
      if (state.mode === 'desarmado') return reject(state, 'invalid_transition');
      const ctx = { state: { ...state, armed: false, countdown: null, exit_countdown: null }, events: [] };
      if (state.sensors.humo) {
        // Sigue habiendo humo: no se puede "apagar" el riesgo, solo silenciarlo.
        enterMode(ctx, 'alarma', 'web');
        ctx.state = { ...ctx.state, causes: ['smoke'], siren: 'muted', lights: true };
        if (state.siren === 'on') ctx.events.push({ event: 'siren.silenced', by: 'web' });
      } else {
        enterMode(ctx, 'desarmado', 'web');
        ctx.state = { ...ctx.state, causes: [], siren: 'off', lights: false };
      }
      // Se emite siempre que cambia `armed`: es la única señal cuando el modo no cambia (desarmar con humo).
      if (state.armed) ctx.events.push({ event: 'armed.changed', armed: false, by: 'web' });
      return { state: ctx.state, events: ctx.events, ok: true };
    }

    case 'silence_siren': {
      if (state.mode !== 'alarma' || state.siren !== 'on') return reject(state, 'invalid_transition');
      return { state: { ...state, siren: 'muted' }, events: [{ event: 'siren.silenced', by: 'web' }], ok: true };
    }

    case 'set_config': {
      const has = (k) => cmd[k] !== undefined;
      if (!has('entry_delay_s') && !has('exit_delay_s')) return reject(state, 'invalid_payload');
      if (has('entry_delay_s') && !inRange(cmd.entry_delay_s, ENTRY_DELAY)) return reject(state, 'invalid_payload');
      if (has('exit_delay_s') && !inRange(cmd.exit_delay_s, EXIT_DELAY)) return reject(state, 'invalid_payload');
      const changes = {};
      if (has('entry_delay_s')) changes.entry_delay_s = cmd.entry_delay_s;
      if (has('exit_delay_s')) changes.exit_delay_s = cmd.exit_delay_s;
      // Aplica a la próxima cuenta regresiva; las que están en curso no se modifican.
      return {
        state: { ...state, config: { ...state.config, ...changes } },
        events: [{ event: 'config.changed', ...changes }],
        ok: true,
      };
    }

    case 'get_state':
      return { state, events: [], ok: true };

    // Comandos solo demo: el transporte mock (o el modo demo del micro) los traduce a cambios de sensor.
    case 'simulate':
      return onSensor(state, { sensor: cmd.sensor, active: cmd.active });

    case 'simulate_all': {
      // La demo siempre tiene que mostrar intrusión y humo juntos: si está desarmado lo arma primero,
      // y si está en tiempo de salida lo termina, porque si no las aperturas no contarían como intrusión.
      const ctx = { state, events: [] };
      if (state.mode === 'desarmado') {
        arm(ctx, 'demo', { skipExitDelay: true });
      } else if (state.exit_countdown) {
        ctx.state = { ...ctx.state, exit_countdown: null };
        ctx.events.push({ event: 'exit_delay.ended' });
      }
      // Solo cuenta el paso a activo: los sensores que ya estaban activos se ponen en reposo (sin eventos, es
      // una demo) para que todos generen su detección. Después se activan "a la vez", en orden.
      const resting = Object.fromEntries(SENSOR_IDS.map((id) => [id, false]));
      let acc = { state: { ...ctx.state, sensors: resting }, events: ctx.events, ok: true };
      for (const sensor of SENSOR_IDS) {
        const r = onSensor(acc.state, { sensor, active: true });
        acc = { state: r.state, events: acc.events.concat(r.events), ok: true };
      }
      return acc;
    }

    default:
      return reject(state, 'unknown_command');
  }
}

/**
 * @param state estado actual
 * @param input { type: 'cmd', cmd, ... } | { type: 'sensor', sensor, active } | { type: 'tick' }
 * @returns {{ state, events: object[], ok: boolean, error?: string }}
 */
export function step(state, input) {
  switch (input?.type) {
    case 'cmd': return onCommand(state, input);
    case 'sensor': return onSensor(state, input);
    case 'tick': return onTick(state);
    default: return reject(state, 'unknown_input');
  }
}
