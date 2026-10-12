import { describe, it, expect } from 'vitest';
import { createInitialState, step, toSnapshot, SENSOR_IDS } from '../src/core/alarm-machine.js';

const cmd = (name, extra = {}) => ({ type: 'cmd', cmd: name, ...extra });
const sensor = (id, active = true) => ({ type: 'sensor', sensor: id, active });
const tick = { type: 'tick' };

/** Sin tiempo de salida, para que "armar" vigile al instante. El tiempo de salida tiene sus propios tests. */
const instant = () => createInitialState({ exit_delay_s: 0 });

/** Aplica entradas en orden; falla si alguna es rechazada. Devuelve estado final y todos los eventos. */
function run(inputs, state = instant()) {
  const events = [];
  for (const input of inputs) {
    const r = step(state, input);
    expect(r.ok, `entrada rechazada: ${JSON.stringify(input)} → ${r.error}`).toBe(true);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

const ticks = (n) => Array.from({ length: n }, () => tick);

describe('estado inicial', () => {
  it('arranca desarmado, sin causas, todo apagado, 15 s de entrada y 30 s de salida', () => {
    const s = toSnapshot(createInitialState());
    expect(s).toMatchObject({
      mode: 'desarmado', armed: false, causes: [], countdown: null, exit_countdown: null,
      outputs: { led: { color: 'off', pattern: 'solid' }, siren: 'off', lights: false },
      config: { entry_delay_s: 15, exit_delay_s: 30 },
    });
    expect(Object.values(s.sensors).every((x) => !x.active)).toBe(true);
  });
});

describe('desarmado', () => {
  it('aperturas y movimiento solo se registran, no cambian el estado', () => {
    const { state, events } = run([sensor('puerta'), sensor('movimiento')]);
    expect(state.mode).toBe('desarmado');
    expect(events.map((e) => e.event)).toEqual(['sensor.changed', 'sensor.changed']);
  });

  it('el humo dispara alarma aunque esté desarmado', () => {
    const { state, events } = run([sensor('humo')]);
    const s = toSnapshot(state);
    expect(s).toMatchObject({ mode: 'alarma', armed: false, causes: ['smoke'], outputs: { led: { color: 'red', pattern: 'blink' }, siren: 'on', lights: true } });
    expect(events).toContainEqual({ event: 'alarm.triggered', causes: ['smoke'], by: 'sensor:humo' });
  });
});

describe('armado → intervención → alarma', () => {
  it('armar pone LED azul fijo y sirena silenciada', () => {
    const { state, events } = run([cmd('arm')]);
    expect(toSnapshot(state)).toMatchObject({ mode: 'armado', armed: true, outputs: { led: { color: 'blue', pattern: 'solid' }, siren: 'off', lights: false } });
    expect(events).toEqual([{ event: 'mode.changed', from: 'desarmado', to: 'armado', by: 'web' }]);
  });

  it('una detección armado inicia la intervención con cuenta regresiva y pitido', () => {
    const { state, events } = run([cmd('arm'), sensor('ventanaLiving')]);
    expect(toSnapshot(state)).toMatchObject({
      mode: 'intervencion', countdown: { remaining_s: 15, total_s: 15 },
      outputs: { led: { color: 'amber', pattern: 'blink' }, siren: 'warning', lights: false },
    });
    expect(events).toContainEqual({ event: 'mode.changed', from: 'armado', to: 'intervencion', by: 'sensor:ventanaLiving' });
  });

  it('cada tick descuenta un segundo', () => {
    const { state } = run([cmd('arm'), sensor('puerta'), ...ticks(4)]);
    expect(state.countdown).toEqual({ remaining_s: 11, total_s: 15 });
  });

  it('si la cuenta llega a 0 pasa a alarma por intrusión', () => {
    const { state, events } = run([cmd('arm'), sensor('puerta'), ...ticks(15)]);
    expect(toSnapshot(state)).toMatchObject({ mode: 'alarma', causes: ['intrusion'], countdown: null, outputs: { siren: 'on', lights: true } });
    expect(events).toContainEqual({ event: 'alarm.triggered', causes: ['intrusion'], by: 'timeout' });
  });

  it('desarmar durante la intervención cancela la alarma', () => {
    const { state } = run([cmd('arm'), sensor('puerta'), ...ticks(5), cmd('disarm'), ...ticks(20)]);
    expect(toSnapshot(state)).toMatchObject({ mode: 'desarmado', armed: false, causes: [], countdown: null, outputs: { siren: 'off', lights: false } });
  });

  it('otra detección durante la intervención no reinicia la cuenta', () => {
    const { state } = run([cmd('arm'), sensor('puerta'), ...ticks(5), sensor('movimiento')]);
    expect(state.countdown.remaining_s).toBe(10);
  });

  it('respeta la demora configurada', () => {
    const { state } = run([cmd('set_config', { entry_delay_s: 30 }), cmd('arm'), sensor('puerta')]);
    expect(state.countdown).toEqual({ remaining_s: 30, total_s: 30 });
  });

  it('solo el flanco a activo es detección: volver a reposo no cambia el modo', () => {
    const { state } = run([cmd('arm'), sensor('puerta'), sensor('puerta', false)]);
    expect(state.mode).toBe('intervencion');
  });

  it('repetir el mismo valor de sensor no genera eventos', () => {
    const r = step(run([sensor('puerta')]).state, sensor('puerta'));
    expect(r.events).toEqual([]);
  });
});

describe('varios riesgos simultáneos', () => {
  it('humo durante una intervención: la intrusión pendiente pasa a ser causa', () => {
    const { state, events } = run([cmd('arm'), sensor('puerta'), ...ticks(3), sensor('humo')]);
    expect(toSnapshot(state)).toMatchObject({ mode: 'alarma', causes: ['intrusion', 'smoke'], countdown: null });
    expect(events).toContainEqual({ event: 'alarm.triggered', causes: ['intrusion', 'smoke'], by: 'sensor:humo' });
  });

  it('intrusión estando armado y ya en alarma por humo se suma de inmediato', () => {
    const { state } = run([cmd('arm'), sensor('humo'), sensor('movimiento')]);
    expect(state.causes).toEqual(['intrusion', 'smoke']);
  });

  it('humo estando desarmado + apertura: la apertura no es intrusión', () => {
    const { state } = run([sensor('humo'), sensor('puerta')]);
    expect(state.causes).toEqual(['smoke']);
  });

  it('una causa nueva vuelve a hacer sonar la sirena silenciada', () => {
    const { state } = run([cmd('arm'), sensor('humo'), cmd('silence_siren'), sensor('puerta')]);
    expect(state.siren).toBe('on');
  });
});

describe('sirena', () => {
  it('silenciar la deja en muted sin salir de la alarma', () => {
    const { state, events } = run([sensor('humo'), cmd('silence_siren')]);
    expect(toSnapshot(state)).toMatchObject({ mode: 'alarma', outputs: { siren: 'muted', lights: true, led: { color: 'red' } } });
    expect(events).toContainEqual({ event: 'siren.silenced', by: 'web' });
  });

  it('no se puede silenciar fuera de alarma ni dos veces', () => {
    expect(step(createInitialState(), cmd('silence_siren'))).toMatchObject({ ok: false, error: 'invalid_transition' });
    const { state } = run([sensor('humo'), cmd('silence_siren')]);
    expect(step(state, cmd('silence_siren'))).toMatchObject({ ok: false, error: 'invalid_transition' });
  });
});

describe('desarmar', () => {
  it('con humo todavía presente vuelve a alarma con la sirena silenciada', () => {
    const { state, events } = run([cmd('arm'), sensor('puerta'), sensor('humo'), cmd('disarm')]);
    expect(toSnapshot(state)).toMatchObject({ mode: 'alarma', armed: false, causes: ['smoke'], outputs: { siren: 'muted', lights: true } });
    expect(events).toContainEqual({ event: 'siren.silenced', by: 'web' });
  });

  it('cuando el humo se va, desarmar de nuevo vuelve a desarmado', () => {
    const { state } = run([sensor('humo'), cmd('disarm'), sensor('humo', false), cmd('disarm')]);
    expect(toSnapshot(state)).toMatchObject({ mode: 'desarmado', causes: [], outputs: { siren: 'off', lights: false } });
  });

  it('no reinicia los sensores: su estado lo informa el micro', () => {
    const { state } = run([cmd('arm'), sensor('puerta'), cmd('disarm')]);
    expect(state.sensors.puerta).toBe(true);
  });

  it('desarmar estando desarmado se rechaza', () => {
    expect(step(createInitialState(), cmd('disarm'))).toMatchObject({ ok: false, error: 'invalid_transition' });
  });
});

describe('armar', () => {
  it('solo se puede desde desarmado', () => {
    const { state } = run([sensor('humo')]);
    expect(step(state, cmd('arm'))).toMatchObject({ ok: false, error: 'invalid_transition' });
    expect(step(run([cmd('arm')]).state, cmd('arm'))).toMatchObject({ ok: false, error: 'invalid_transition' });
  });
});

describe('comandos solo demo', () => {
  it('simulate equivale a un cambio de sensor', () => {
    const a = run([cmd('arm'), cmd('simulate', { sensor: 'puerta', active: true })]);
    const b = run([cmd('arm'), sensor('puerta')]);
    expect(a.state).toEqual(b.state);
  });

  it('simulate_all armado: alarma con intrusión y humo a la vez', () => {
    const { state } = run([cmd('arm'), cmd('simulate_all')]);
    expect(toSnapshot(state)).toMatchObject({ mode: 'alarma', causes: ['intrusion', 'smoke'] });
    expect(SENSOR_IDS.every((id) => state.sensors[id])).toBe(true);
  });

  it('simulate_all desarmado: primero arma (queda en el historial) y muestra intrusión y humo', () => {
    const { state, events } = run([cmd('simulate_all')], createInitialState()); // con tiempo de salida de 30 s
    expect(toSnapshot(state)).toMatchObject({ mode: 'alarma', armed: true, causes: ['intrusion', 'smoke'], exit_countdown: null });
    expect(events[0]).toEqual({ event: 'mode.changed', from: 'desarmado', to: 'armado', by: 'demo' });
  });

  it('simulate_all durante el tiempo de salida lo termina y muestra intrusión y humo', () => {
    const { state, events } = run([cmd('arm'), cmd('simulate_all')], createInitialState());
    expect(state.causes).toEqual(['intrusion', 'smoke']);
    expect(events).toContainEqual({ event: 'exit_delay.ended' });
  });
});

describe('tiempo de salida', () => {
  const s0 = () => createInitialState(); // 30 s por defecto

  it('al armar arranca la cuenta de salida, con LED azul fijo y sirena apagada', () => {
    const { state } = run([cmd('arm')], s0());
    expect(toSnapshot(state)).toMatchObject({
      mode: 'armado', armed: true, exit_countdown: { remaining_s: 30, total_s: 30 },
      outputs: { led: { color: 'blue', pattern: 'solid' }, siren: 'off' },
    });
  });

  it('durante la salida las aperturas y el movimiento no disparan intervención', () => {
    const { state, events } = run([cmd('arm'), ...ticks(10), sensor('puerta'), sensor('movimiento')], s0());
    expect(state.mode).toBe('armado');
    expect(state.exit_countdown.remaining_s).toBe(20);
    expect(events.filter((e) => e.event === 'mode.changed')).toHaveLength(1); // solo el de armar
  });

  it('al terminar avisa con exit_delay.ended y desde ahí vigila', () => {
    const { state, events } = run([cmd('arm'), ...ticks(30)], s0());
    expect(state.exit_countdown).toBeNull();
    expect(events).toContainEqual({ event: 'exit_delay.ended' });
    expect(run([sensor('ventanaDorm')], state).state.mode).toBe('intervencion');
  });

  it('un sensor que quedó activo durante la salida no dispara al terminar (solo cuenta el flanco)', () => {
    const { state } = run([cmd('arm'), sensor('puerta'), ...ticks(30)], s0());
    expect(state.mode).toBe('armado');
  });

  it('el humo dispara alarma aunque esté en tiempo de salida', () => {
    const { state } = run([cmd('arm'), ...ticks(5), sensor('humo')], s0());
    expect(toSnapshot(state)).toMatchObject({ mode: 'alarma', causes: ['smoke'], exit_countdown: null });
  });

  it('desarmar durante la salida vuelve a desarmado y corta la cuenta', () => {
    const { state } = run([cmd('arm'), ...ticks(5), cmd('disarm')], s0());
    expect(toSnapshot(state)).toMatchObject({ mode: 'desarmado', exit_countdown: null });
  });

  it('configurable con set_config; 0 desactiva el tiempo de salida', () => {
    expect(run([cmd('set_config', { exit_delay_s: 45 }), cmd('arm')], s0()).state.exit_countdown).toEqual({ remaining_s: 45, total_s: 45 });
    expect(run([cmd('set_config', { exit_delay_s: 0 }), cmd('arm')], s0()).state.exit_countdown).toBeNull();
  });

  it('set_config acepta ambos tiempos juntos y emite config.changed', () => {
    const { state, events } = run([cmd('set_config', { entry_delay_s: 20, exit_delay_s: 60 })]);
    expect(state.config).toEqual({ entry_delay_s: 20, exit_delay_s: 60 });
    expect(events).toEqual([{ event: 'config.changed', entry_delay_s: 20, exit_delay_s: 60 }]);
  });
});

describe('entradas inválidas', () => {
  it.each([
    [cmd('volar'), 'unknown_command'],
    [sensor('garage'), 'unknown_sensor'],
    [cmd('set_config', { entry_delay_s: 2 }), 'invalid_payload'],
    [cmd('set_config', { entry_delay_s: 61 }), 'invalid_payload'],
    [cmd('set_config', { entry_delay_s: 10.5 }), 'invalid_payload'],
    [cmd('set_config', { exit_delay_s: 121 }), 'invalid_payload'],
    [cmd('set_config', { exit_delay_s: -1 }), 'invalid_payload'],
    [cmd('set_config', {}), 'invalid_payload'],
    [{ type: 'otra' }, 'unknown_input'],
  ])('%j → %s', (input, error) => {
    const s0 = createInitialState();
    const r = step(s0, input);
    expect(r).toMatchObject({ ok: false, error, events: [] });
    expect(r.state).toBe(s0);
  });

  it('nunca muta el estado recibido', () => {
    const s0 = createInitialState();
    const copy = structuredClone(s0);
    run([cmd('arm'), sensor('puerta'), ...ticks(15), sensor('humo'), cmd('disarm')], s0);
    expect(s0).toEqual(copy);
  });
});
