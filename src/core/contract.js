/**
 * Contrato de mensajes v1 entre web, micro y n8n. Documentado en docs/contrato.md: si cambiás algo acá,
 * actualizá ese archivo y avisá al equipo.
 */
import { MODES, SENSORS, SENSOR_IDS, ENTRY_DELAY, EXIT_DELAY } from './alarm-machine.js';

export const CONTRACT_VERSION = 1;

export const MESSAGE_TYPES = ['state', 'event', 'cmd', 'ack'];
export const CAUSES = ['intrusion', 'smoke'];
export const SIREN_STATES = ['off', 'warning', 'on', 'muted'];
export const LED_COLORS = ['off', 'blue', 'amber', 'red'];
export const LED_PATTERNS = ['solid', 'blink'];
export const EVENTS = ['sensor.changed', 'mode.changed', 'alarm.triggered', 'siren.silenced', 'config.changed', 'exit_delay.ended'];
export const COMMANDS = ['arm', 'disarm', 'silence_siren', 'get_state', 'set_config'];
/** Solo demo: los atiende el transporte mock o un modo demo del micro. En producción el micro los rechaza. */
export const DEMO_COMMANDS = ['simulate', 'simulate_all'];
export const ACK_ERRORS = ['invalid_transition', 'invalid_payload', 'unknown_command', 'unknown_sensor', 'demo_disabled'];

export function topics(deviceId) {
  const base = `smarthome/${deviceId}`;
  return { state: `${base}/state`, event: `${base}/event`, cmd: `${base}/cmd`, ack: `${base}/ack`, online: `${base}/online` };
}

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function envelope(type, payload, { deviceId, id = newId(), ts = new Date().toISOString() }) {
  return { v: CONTRACT_VERSION, id, type, ts, deviceId, payload };
}

export const makeCommand = (payload, opts) => envelope('cmd', payload, opts);
export const makeState = (payload, opts) => envelope('state', payload, opts);
export const makeEvent = (payload, opts) => envelope('event', payload, opts);
export function makeAck(commandId, result, opts) {
  const payload = result.ok ? { ack: commandId, ok: true } : { ack: commandId, ok: false, error: result.error };
  return envelope('ack', payload, opts);
}

// --- validación ---------------------------------------------------------------------------------
// Sin dependencias: cada validador devuelve la lista de problemas (vacía = válido).

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string' && x.length > 0;
const isBool = (x) => typeof x === 'boolean';
const isInt = (x) => Number.isInteger(x);
const inRange = (x, { min, max }) => isInt(x) && x >= min && x <= max;
const isCountdown = (c) => isObj(c) && isInt(c.remaining_s) && isInt(c.total_s) && c.remaining_s >= 0 && c.remaining_s <= c.total_s;

function checkSensorId(p, errors, path = 'sensor') {
  if (!SENSOR_IDS.includes(p[path])) errors.push(`${path}: sensor desconocido "${p[path]}"`);
}

export function validateCommand(p) {
  const errors = [];
  if (!isObj(p)) return ['payload: debe ser un objeto'];
  if (![...COMMANDS, ...DEMO_COMMANDS].includes(p.cmd)) return [`cmd: comando desconocido "${p.cmd}"`];
  if (p.cmd === 'set_config') {
    const has = (k) => p[k] !== undefined;
    if (!has('entry_delay_s') && !has('exit_delay_s')) errors.push('set_config: indicar entry_delay_s y/o exit_delay_s');
    if (has('entry_delay_s') && !inRange(p.entry_delay_s, ENTRY_DELAY)) {
      errors.push(`entry_delay_s: entero entre ${ENTRY_DELAY.min} y ${ENTRY_DELAY.max}`);
    }
    if (has('exit_delay_s') && !inRange(p.exit_delay_s, EXIT_DELAY)) {
      errors.push(`exit_delay_s: entero entre ${EXIT_DELAY.min} y ${EXIT_DELAY.max}`);
    }
  }
  if (p.cmd === 'simulate') {
    checkSensorId(p, errors);
    if (!isBool(p.active)) errors.push('active: booleano');
  }
  return errors;
}

export function validateState(p) {
  const errors = [];
  if (!isObj(p)) return ['payload: debe ser un objeto'];
  if (!MODES.includes(p.mode)) errors.push(`mode: uno de ${MODES.join('|')}`);
  if (!isBool(p.armed)) errors.push('armed: booleano');
  if (!Array.isArray(p.causes) || !p.causes.every((c) => CAUSES.includes(c))) errors.push(`causes: lista de ${CAUSES.join('|')}`);
  else if (p.mode === 'alarma' && p.causes.length === 0) errors.push('causes: no puede estar vacía en alarma');
  else if (p.mode !== 'alarma' && p.causes.length > 0) errors.push('causes: debe estar vacía fuera de alarma');

  if (p.mode === 'intervencion') {
    if (!isCountdown(p.countdown)) {
      errors.push('countdown: {remaining_s, total_s} enteros, 0 ≤ remaining_s ≤ total_s');
    }
  } else if (p.countdown !== null) {
    errors.push('countdown: null fuera de intervención');
  }

  // Tiempo de salida: solo existe recién armado; null en cualquier otro caso.
  if (p.exit_countdown !== null && !(p.mode === 'armado' && isCountdown(p.exit_countdown))) {
    errors.push('exit_countdown: {remaining_s, total_s} solo en armado; si no, null');
  }

  if (!isObj(p.sensors)) errors.push('sensors: objeto');
  else {
    for (const id of SENSOR_IDS) {
      const s = p.sensors[id];
      if (!isObj(s) || s.kind !== SENSORS[id].kind || !isBool(s.active)) errors.push(`sensors.${id}: {kind: "${SENSORS[id].kind}", active: booleano}`);
    }
  }

  const o = p.outputs;
  if (!isObj(o)) errors.push('outputs: objeto');
  else {
    if (!isObj(o.led) || !LED_COLORS.includes(o.led.color) || !LED_PATTERNS.includes(o.led.pattern)) errors.push('outputs.led: {color, pattern}');
    if (!SIREN_STATES.includes(o.siren)) errors.push(`outputs.siren: uno de ${SIREN_STATES.join('|')}`);
    if (!isBool(o.lights)) errors.push('outputs.lights: booleano');
  }

  if (!isObj(p.config) || !isInt(p.config.entry_delay_s)) errors.push('config.entry_delay_s: entero');
  if (!isObj(p.config) || !isInt(p.config.exit_delay_s)) errors.push('config.exit_delay_s: entero');
  return errors;
}

export function validateEvent(p) {
  const errors = [];
  if (!isObj(p)) return ['payload: debe ser un objeto'];
  switch (p.event) {
    case 'sensor.changed':
      checkSensorId(p, errors);
      if (!isBool(p.active)) errors.push('active: booleano');
      break;
    case 'mode.changed':
      if (!MODES.includes(p.from) || !MODES.includes(p.to)) errors.push('from/to: modos válidos');
      if (!isStr(p.by)) errors.push('by: texto');
      break;
    case 'alarm.triggered':
      if (!Array.isArray(p.causes) || p.causes.length === 0 || !p.causes.every((c) => CAUSES.includes(c))) errors.push('causes: lista no vacía');
      break;
    case 'siren.silenced':
      if (!isStr(p.by)) errors.push('by: texto');
      break;
    case 'config.changed': {
      const keys = ['entry_delay_s', 'exit_delay_s'].filter((k) => p[k] !== undefined);
      if (keys.length === 0 || !keys.every((k) => isInt(p[k]))) errors.push('entry_delay_s y/o exit_delay_s: enteros');
      break;
    }
    case 'exit_delay.ended':
      break;
    default:
      errors.push(`event: evento desconocido "${p.event}"`);
  }
  return errors;
}

export function validateAck(p) {
  const errors = [];
  if (!isObj(p)) return ['payload: debe ser un objeto'];
  if (!isStr(p.ack)) errors.push('ack: id del comando');
  if (!isBool(p.ok)) errors.push('ok: booleano');
  if (p.ok === false && !ACK_ERRORS.includes(p.error)) errors.push(`error: uno de ${ACK_ERRORS.join('|')}`);
  return errors;
}

const PAYLOAD_VALIDATORS = { state: validateState, event: validateEvent, cmd: validateCommand, ack: validateAck };

/** Valida sobre + payload. Útil para descartar mensajes mal formados que lleguen del broker. */
export function validateMessage(msg) {
  if (!isObj(msg)) return ['mensaje: debe ser un objeto JSON'];
  const errors = [];
  if (msg.v !== CONTRACT_VERSION) errors.push(`v: se esperaba ${CONTRACT_VERSION}`);
  if (!isStr(msg.id)) errors.push('id: texto');
  if (!MESSAGE_TYPES.includes(msg.type)) return [...errors, `type: uno de ${MESSAGE_TYPES.join('|')}`];
  if (!isStr(msg.ts) || Number.isNaN(Date.parse(msg.ts))) errors.push('ts: fecha ISO 8601');
  if (!isStr(msg.deviceId)) errors.push('deviceId: texto');
  return errors.concat(PAYLOAD_VALIDATORS[msg.type](msg.payload).map((e) => `payload.${e}`));
}
