/**
 * Todo lo que muestra el panel, calculado a partir del estado de la UI. Puro (no toca el DOM) para poder
 * testearlo; las vistas solo vuelcan estos valores. Textos y colores salen del diseño "Start Home.html".
 */
import { SENSORS, SENSOR_IDS } from '../core/alarm-machine.js';

export const SENSOR_UI = {
  puerta: { type: 'Sensor magnético', onText: 'Abierta', offText: 'Cerrada' },
  ventanaLiving: { type: 'Sensor magnético', onText: 'Abierta', offText: 'Cerrada' },
  ventanaDorm: { type: 'Sensor magnético', onText: 'Abierta', offText: 'Cerrada' },
  movimiento: { type: 'Sensor de movimiento', onText: 'Movimiento', offText: 'Sin movimiento' },
  humo: { type: 'Detector de humo', onText: 'Humo', offText: 'Normal' },
};

const MODE_UI = {
  desarmado: { label: 'Desarmado', color: 'var(--c-desarmado)', soft: 'var(--soft-desarmado)', border: 'var(--border-strong)', ring: '' },
  armado: { label: 'Armado', color: 'var(--c-armado)', soft: 'var(--soft-armado)', border: 'var(--b-armado)', ring: '' },
  intervencion: { label: 'Intervención', color: 'var(--c-intervencion)', soft: 'var(--soft-intervencion)', border: 'var(--b-intervencion)', ring: 'sh-blink-slow' },
  alarma: { label: 'Alarma', color: 'var(--c-alarma)', soft: 'var(--soft-alarma)', border: 'var(--b-alarma)', ring: 'sh-ring-alarm' },
};

const LED_UI = {
  off: { color: 'var(--led-off)', glow: 'transparent', name: 'Apagado' },
  blue: { color: 'var(--c-armado)', glow: 'rgba(90,162,255,0.5)', name: 'Azul' },
  amber: { color: 'var(--c-intervencion)', glow: 'rgba(245,176,65,0.55)', name: 'Ámbar' },
  red: { color: 'var(--c-alarma)', glow: 'rgba(255,107,107,0.6)', name: 'Rojo' },
};

const SIREN_UI = {
  off: { text: 'Silenciada', color: 'var(--off)' },
  warning: { text: 'Pitido de aviso', color: 'var(--c-intervencion)' },
  on: { text: 'Sonando', color: 'var(--c-alarma)' },
  muted: { text: 'Silenciada por el usuario', color: 'var(--off)' },
};

export const COMMAND_LABELS = {
  arm: 'armar el sistema',
  disarm: 'desarmar',
  silence_siren: 'silenciar la sirena',
  simulate: 'simular el sensor',
  simulate_all: 'simular todo a la vez',
};

const COMMAND_ERRORS = {
  timeout: 'el dispositivo no respondió a tiempo.',
  offline: 'no hay conexión con el dispositivo.',
  invalid_transition: 'no se puede en el estado actual.',
  invalid_payload: 'el comando tiene datos inválidos.',
  unknown_command: 'el dispositivo no reconoce el comando.',
  unknown_sensor: 'el sensor no existe.',
  demo_disabled: 'el dispositivo no está en modo demo.',
};

export function commandErrorText(cmd, code) {
  return `No se pudo ${COMMAND_LABELS[cmd] ?? cmd}: ${COMMAND_ERRORS[code] ?? 'error desconocido.'}`;
}

/** Segundos que quedan de una cuenta regresiva, descontando el tiempo desde que llegó el snapshot. */
export function remainingSeconds(countdown, receivedAt, now) {
  if (!countdown) return null;
  const elapsed = Math.max(0, Math.floor((now - receivedAt) / 1000));
  return Math.max(0, countdown.remaining_s - elapsed);
}

function intrusionPoints(device) {
  return SENSOR_IDS.filter((id) => SENSORS[id].kind !== 'smoke' && device.sensors[id].active).length;
}

function alarmDescription(causes, siren) {
  const outputs = siren === 'muted' ? 'Sirena silenciada; las luces siguen encendidas.' : 'Sirena y luces activadas.';
  if (causes.length > 1) return `Varios riesgos a la vez: humo e intrusión. ${outputs}`;
  return `${causes[0] === 'smoke' ? 'Humo detectado.' : 'Intrusión confirmada.'} ${outputs}`;
}

function notificationText(device) {
  const { causes } = device;
  if (causes.length > 1) {
    const n = intrusionPoints(device);
    return `humo en la cocina e intrusión${n ? ` en ${n} ${n === 1 ? 'punto' : 'puntos'} de la casa` : ''} al mismo tiempo.`;
  }
  return causes[0] === 'smoke' ? 'se detectó humo en la cocina.' : 'se confirmó una intrusión en la casa.';
}

/**
 * Título del aviso de alarma. Solo dice que se notificó al usuario cuando llegó `notification.sent` de esta
 * alarma; con el mock la notificación es simulada y se aclara.
 */
export function alertTitle(notification) {
  if (!notification) return 'Alarma activada:';
  const channel = { telegram: 'Telegram' }[notification.channel] ?? notification.channel;
  if (!notification.ok) return `No se pudo enviar la notificación por ${channel}:`;
  return notification.simulated ? 'Notificación simulada (demo):' : `Notificación enviada por ${channel}:`;
}

/**
 * @param ui { conn, device, receivedAt, pending, error, log, demo, canResetDemo, notification }
 * @param now ms (Date.now())
 */
export function panelView(ui, now) {
  const d = ui.device;
  const online = ui.conn === 'online';
  const conn = {
    online: { text: 'Dispositivo en línea', color: 'var(--online)' },
    connecting: { text: 'Conectando…', color: 'var(--c-intervencion)' },
    offline: { text: 'Sin conexión', color: 'var(--c-alarma)' },
  }[ui.conn];

  if (!d) {
    return {
      conn, ready: false, demo: ui.demo, log: ui.log, error: ui.error,
      hero: { ...MODE_UI.desarmado, label: 'Conectando…', desc: 'Esperando el estado del dispositivo.', ring: '' },
    };
  }

  const mode = MODE_UI[d.mode];
  const busy = !!ui.pending || !online;
  const exitLeft = remainingSeconds(d.exit_countdown, ui.receivedAt, now);
  const entryLeft = remainingSeconds(d.countdown, ui.receivedAt, now);

  let desc;
  if (d.mode === 'alarma') desc = alarmDescription(d.causes, d.outputs.siren);
  else if (d.mode === 'armado' && d.exit_countdown) desc = 'Tiempo de salida: podés salir de la casa. Las aperturas y el movimiento todavía no disparan la alarma.';
  else desc = {
    desarmado: 'No se vigilan aperturas ni movimiento. El detector de humo sigue activo siempre.',
    armado: 'Vigilando puertas, ventanas y movimiento. Cualquier detección inicia una intervención.',
    intervencion: 'Se detectó actividad. Desarmá el sistema antes de que termine la cuenta regresiva.',
  }[d.mode];

  let countdown = null;
  if (d.mode === 'intervencion' && entryLeft !== null) countdown = { text: `Alarma en ${entryLeft} s`, color: 'var(--c-intervencion)' };
  else if (d.mode === 'armado' && exitLeft !== null) countdown = { text: `Vigilando en ${exitLeft} s`, color: 'var(--c-armado)' };

  const hints = {
    desarmado: 'Sin vigilancia de intrusión',
    armado: `Vigila puertas, ventanas y movimiento · ${d.config.exit_delay_s} s para salir`,
    intervencion: `Detección estando armado · ${d.config.entry_delay_s} s para desarmar`,
    alarma: 'Intrusión o humo · sirena y luces',
  };

  const led = LED_UI[d.outputs.led.color];
  const blink = d.outputs.led.pattern === 'blink';
  const siren = SIREN_UI[d.outputs.siren];

  return {
    conn,
    ready: true,
    demo: ui.demo,
    error: ui.error,
    pending: ui.pending,
    hero: {
      label: d.mode === 'armado' && d.exit_countdown ? 'Armando…' : mode.label,
      desc, color: mode.color, soft: mode.soft, border: mode.border, ring: mode.ring,
    },
    countdown,
    buttons: {
      arm: d.mode === 'desarmado' ? { disabled: busy, text: ui.pending === 'arm' ? 'Armando…' : 'Armar sistema' } : null,
      disarm: d.mode !== 'desarmado' ? { disabled: busy, text: ui.pending === 'disarm' ? 'Desarmando…' : 'Desarmar' } : null,
      silence: d.mode === 'alarma' && d.outputs.siren === 'on' ? { disabled: busy, text: ui.pending === 'silence_siren' ? 'Silenciando…' : 'Silenciar sirena' } : null,
      simulateAll: { disabled: busy },
    },
    alert: d.mode === 'alarma' ? { title: alertTitle(ui.notification), text: notificationText(d), muted: d.outputs.siren === 'muted' } : null,
    canResetDemo: !!ui.canResetDemo,
    modes: ['desarmado', 'armado', 'intervencion', 'alarma'].map((k) => {
      const active = k === d.mode;
      return {
        id: k, label: MODE_UI[k].label, hint: hints[k], color: MODE_UI[k].color, active,
        border: active ? MODE_UI[k].color : 'var(--divider)',
        bg: active ? MODE_UI[k].soft : 'transparent',
        labelColor: active ? MODE_UI[k].color : 'var(--text-2)',
      };
    }),
    sensors: SENSOR_IDS.map((id) => {
      const on = d.sensors[id].active;
      const smoke = SENSORS[id].kind === 'smoke';
      const alertC = smoke ? 'var(--c-alarma)' : 'var(--c-intervencion)';
      const alertSoft = smoke ? 'var(--soft-alarma)' : 'var(--soft-intervencion)';
      return {
        id, kind: SENSORS[id].kind, name: SENSORS[id].name, type: SENSOR_UI[id].type, active: on,
        status: on ? SENSOR_UI[id].onText : SENSOR_UI[id].offText,
        border: on ? alertC : 'var(--border)',
        color: on ? alertC : 'var(--c-desarmado)',
        iconBg: on ? alertSoft : 'var(--surface-muted)',
        action: on ? 'Restablecer' : 'Simular',
        actionAria: on ? `Restablecer ${SENSORS[id].name}` : `Simular detección en ${SENSORS[id].name}`,
        disabled: busy,
      };
    }),
    device: {
      led: {
        color: led.color,
        glow: led.glow,
        // Rojo parpadea rápido (alarma) y ámbar lento (intervención), como en el diseño.
        cls: !blink ? '' : d.outputs.led.color === 'red' ? 'sh-blink' : 'sh-blink-slow',
        text: d.outputs.led.color === 'off' ? 'Apagado' : `${led.name} ${blink ? 'intermitente' : 'fijo'}`,
      },
      siren: { text: siren.text, color: siren.color },
      lights: d.outputs.lights ? { text: 'Encendidas', color: 'var(--lights-on)' } : { text: 'Apagadas', color: 'var(--off)' },
    },
    log: ui.log,
  };
}
