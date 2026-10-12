/**
 * Convierte eventos del contrato en líneas del historial. `before` es el último snapshot recibido antes del
 * evento (puede ser null), para dar contexto: p. ej. una apertura con el sistema desarmado se ve atenuada.
 */
import { SENSORS } from '../core/alarm-machine.js';
import { SENSOR_UI } from './view-model.js';

export const LOG_LIMIT = 30;
export const CHANNEL_NAMES = { telegram: 'Telegram' };
export const LOG_DOTS = { alarm: 'var(--c-alarma)', warn: 'var(--c-intervencion)', info: 'var(--c-armado)', muted: 'var(--log-muted)' };

function causesText(causes) {
  if (causes.length > 1) return 'humo e intrusión al mismo tiempo';
  return causes[0] === 'smoke' ? 'humo' : 'intrusión';
}

/** @returns {{ text: string, level: 'alarm'|'warn'|'info'|'muted' } | null} */
export function formatEvent(e, before) {
  switch (e.event) {
    case 'sensor.changed': {
      const name = SENSORS[e.sensor].name;
      const ui = SENSOR_UI[e.sensor];
      if (!e.active) return { text: `${name}: ${ui.offText.toLowerCase()}`, level: 'muted' };
      if (SENSORS[e.sensor].kind === 'smoke') return { text: `Humo detectado en ${name.toLowerCase()}`, level: 'alarm' };
      const text = `${name}: ${ui.onText.toLowerCase()}`;
      if (!before?.armed) return { text: `${text} (sistema desarmado)`, level: 'muted' };
      if (before.exit_countdown) return { text: `${text} (tiempo de salida)`, level: 'muted' };
      return { text, level: 'warn' };
    }

    case 'mode.changed':
      switch (e.to) {
        case 'armado':
          return {
            text: e.by === 'demo' ? 'Sistema armado para la simulación' : 'Sistema armado por el usuario',
            level: 'info',
          };
        case 'intervencion':
          return { text: `Intervención iniciada · ${before?.config.entry_delay_s ?? 15} s para desarmar`, level: 'warn' };
        case 'desarmado':
          return { text: e.by === 'web' ? 'Sistema desarmado por el usuario' : 'Sistema desarmado', level: 'info' };
        default:
          return null; // `alarma`: el aviso lo da alarm.triggered
      }

    case 'armed.changed':
      // Armar y desarmar ya quedan registrados con mode.changed (que llega antes). Solo hace falta una línea
      // cuando el modo no cambió: desarmar con humo presente, donde el sistema sigue en alarma.
      if (!e.armed && before?.mode === 'alarma') {
        return { text: 'Sistema desarmado, pero sigue habiendo humo · la alarma continúa con la sirena silenciada', level: 'alarm' };
      }
      return null;

    // Si se avisó al usuario lo dice notification.sent (lo publica n8n), no la alarma.
    case 'alarm.triggered':
      if (e.by === 'timeout') return { text: 'Tiempo agotado · alarma por intrusión', level: 'alarm' };
      return { text: `Alarma por ${causesText(e.causes)}`, level: 'alarm' };

    case 'notification.sent': {
      const channel = CHANNEL_NAMES[e.channel] ?? e.channel;
      if (!e.ok) return { text: `No se pudo enviar la notificación por ${channel}: ${e.error}`, level: 'alarm' };
      return e.simulated
        ? { text: `Notificación simulada por ${channel} (demo: no se envió nada)`, level: 'info' }
        : { text: `Notificación enviada por ${channel}`, level: 'info' };
    }

    case 'siren.silenced':
      return { text: e.by === 'web' ? 'Sirena silenciada desde la web' : 'Sirena silenciada', level: 'info' };

    case 'exit_delay.ended':
      return { text: 'Terminó el tiempo de salida · vigilando', level: 'info' };

    case 'config.changed': {
      const parts = [];
      if (e.entry_delay_s !== undefined) parts.push(`entrada ${e.entry_delay_s} s`);
      if (e.exit_delay_s !== undefined) parts.push(`salida ${e.exit_delay_s} s`);
      return { text: `Configuración actualizada: ${parts.join(', ')}`, level: 'info' };
    }

    default:
      return null;
  }
}

/**
 * Los eventos de un mismo cambio llegan antes que el nuevo snapshot (p. ej. simulate_all: "armado" y después
 * las aperturas). Para formatear cada uno con el contexto correcto, se actualiza el snapshot previo con lo que
 * dice cada evento hasta que llegue el `state` real.
 */
export function advanceContext(ctx, e) {
  if (!ctx) return ctx;
  switch (e.event) {
    case 'mode.changed': {
      const next = { ...ctx, mode: e.to };
      if (e.to === 'armado') {
        const exit = e.by === 'demo' ? 0 : ctx.config.exit_delay_s;
        next.armed = true;
        next.exit_countdown = exit > 0 ? { remaining_s: exit, total_s: exit } : null;
      }
      if (e.to === 'desarmado') next.armed = false;
      return next;
    }
    case 'armed.changed':
      return { ...ctx, armed: e.armed };
    case 'exit_delay.ended':
      return { ...ctx, exit_countdown: null };
    case 'config.changed':
      return { ...ctx, config: { ...ctx.config, ...Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'event')) } };
    default:
      return ctx;
  }
}

export function formatTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch {
    return '--:--:--';
  }
}

/** Agrega una línea al principio del historial (lo más nuevo arriba) respetando el límite. */
export function pushLog(log, entry) {
  return [entry, ...log].slice(0, LOG_LIMIT);
}
