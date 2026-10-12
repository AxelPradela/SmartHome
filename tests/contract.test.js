import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  topics, envelope, makeCommand, makeState, makeEvent, makeAck,
  validateMessage, validateCommand, validateState, validateEvent, validateAck,
  COMMANDS, DEMO_COMMANDS,
} from '../src/core/contract.js';
import { createInitialState, step, toSnapshot } from '../src/core/alarm-machine.js';

const opts = { deviceId: 'casa-01' };

describe('sobre', () => {
  it('arma v, id, type, ts ISO y deviceId', () => {
    const m = envelope('cmd', { cmd: 'arm' }, opts);
    expect(m).toMatchObject({ v: 1, type: 'cmd', deviceId: 'casa-01', payload: { cmd: 'arm' } });
    expect(typeof m.id).toBe('string');
    expect(Number.isNaN(Date.parse(m.ts))).toBe(false);
    expect(validateMessage(m)).toEqual([]);
  });

  it('ids distintos en cada mensaje', () => {
    expect(makeCommand({ cmd: 'arm' }, opts).id).not.toBe(makeCommand({ cmd: 'arm' }, opts).id);
  });

  it('rechaza versión, tipo o fecha inválidos', () => {
    const ok = makeCommand({ cmd: 'arm' }, opts);
    expect(validateMessage({ ...ok, v: 2 })).toContain('v: se esperaba 1');
    expect(validateMessage({ ...ok, type: 'otro' }).some((e) => e.startsWith('type'))).toBe(true);
    expect(validateMessage({ ...ok, ts: 'ayer' }).some((e) => e.startsWith('ts'))).toBe(true);
    expect(validateMessage('no es objeto')).toHaveLength(1);
  });

  it('tópicos por dispositivo', () => {
    expect(topics('casa-01')).toEqual({
      state: 'smarthome/casa-01/state', event: 'smarthome/casa-01/event', cmd: 'smarthome/casa-01/cmd',
      ack: 'smarthome/casa-01/ack', online: 'smarthome/casa-01/online', notification: 'smarthome/casa-01/notification',
    });
  });
});

describe('comandos', () => {
  it('simulate y simulate_all están marcados como solo demo y no como comandos normales', () => {
    expect(DEMO_COMMANDS).toEqual(['simulate', 'simulate_all']);
    expect(COMMANDS.some((c) => DEMO_COMMANDS.includes(c))).toBe(false);
  });

  it.each([
    [{ cmd: 'arm' }, true],
    [{ cmd: 'simulate_all' }, true],
    [{ cmd: 'simulate', sensor: 'humo', active: true }, true],
    [{ cmd: 'simulate', sensor: 'garage', active: true }, false],
    [{ cmd: 'simulate', sensor: 'humo' }, false],
    [{ cmd: 'set_config', entry_delay_s: 20 }, true],
    [{ cmd: 'set_config', entry_delay_s: 100 }, false],
    [{ cmd: 'set_config', exit_delay_s: 60 }, true],
    [{ cmd: 'set_config', exit_delay_s: 200 }, false],
    [{ cmd: 'set_config' }, false],
    [{ cmd: 'abrir_garage' }, false],
  ])('%j válido=%s', (payload, valid) => {
    expect(validateCommand(payload).length === 0).toBe(valid);
  });
});

describe('ack', () => {
  it('ok y error', () => {
    expect(validateMessage(makeAck('abc', { ok: true }, opts))).toEqual([]);
    const err = makeAck('abc', { ok: false, error: 'invalid_transition' }, opts);
    expect(err.payload).toEqual({ ack: 'abc', ok: false, error: 'invalid_transition' });
    expect(validateMessage(err)).toEqual([]);
    expect(validateAck({ ack: 'abc', ok: false, error: 'se rompió' })).toHaveLength(1);
  });
});

describe('estado', () => {
  it('detecta inconsistencias', () => {
    const s = toSnapshot(createInitialState());
    expect(validateState(s)).toEqual([]);
    expect(validateState({ ...s, causes: ['smoke'] })).toContain('causes: debe estar vacía fuera de alarma');
    expect(validateState({ ...s, mode: 'alarma' })).toContain('causes: no puede estar vacía en alarma');
    expect(validateState({ ...s, mode: 'intervencion' }).some((e) => e.startsWith('countdown'))).toBe(true);
    expect(validateState({ ...s, sensors: { ...s.sensors, humo: { kind: 'door', active: true } } })).toHaveLength(1);
    expect(validateState({ ...s, outputs: { ...s.outputs, siren: 'fuerte' } })).toHaveLength(1);
    expect(validateState({ ...s, exit_countdown: { remaining_s: 5, total_s: 30 } })).toHaveLength(1); // fuera de armado
    const armando = { ...s, mode: 'armado', armed: true, exit_countdown: { remaining_s: 5, total_s: 30 } };
    expect(validateState(armando)).toEqual([]);
  });
});

describe('la máquina de estados siempre produce mensajes válidos', () => {
  // Recorre escenarios y valida cada snapshot y cada evento contra el contrato.
  const scenarios = {
    'intrusión por timeout': [{ cmd: 'arm' }, { sensor: 'puerta' }, ...Array(15).fill('tick'), { cmd: 'silence_siren' }, { cmd: 'disarm' }],
    'humo desarmado + desarmar con humo': [{ sensor: 'humo' }, { cmd: 'disarm' }, { sensor: 'humo', active: false }, { cmd: 'disarm' }],
    'simulate_all armado': [{ cmd: 'set_config', entry_delay_s: 5 }, { cmd: 'arm' }, { cmd: 'simulate_all' }, { cmd: 'disarm' }],
    'humo en intervención': [{ cmd: 'arm' }, { sensor: 'movimiento' }, 'tick', { sensor: 'humo' }],
    'tiempo de salida': [{ cmd: 'set_config', exit_delay_s: 3 }, { cmd: 'arm' }, { sensor: 'puerta' }, 'tick', 'tick', 'tick', { sensor: 'movimiento' }],
    'simulate_all desarmado': [{ cmd: 'set_config', exit_delay_s: 30 }, { cmd: 'simulate_all' }],
  };

  it.each(Object.entries(scenarios))('%s', (_, inputs) => {
    let state = createInitialState({ exit_delay_s: 0 });
    expect(validateMessage(makeState(toSnapshot(state), opts))).toEqual([]);
    for (const raw of inputs) {
      const input = raw === 'tick' ? { type: 'tick' }
        : raw.cmd ? { type: 'cmd', ...raw }
        : { type: 'sensor', active: true, ...raw };
      const r = step(state, input);
      expect(r.ok).toBe(true);
      state = r.state;
      expect(validateMessage(makeState(toSnapshot(state), opts))).toEqual([]);
      for (const e of r.events) expect(validateMessage(makeEvent(e, opts)), JSON.stringify(e)).toEqual([]);
    }
  });

  it('notification.sent: canal, ref, resultado y simulated opcional', () => {
    const ok = { event: 'notification.sent', channel: 'telegram', ref: 'a1', ok: true };
    expect(validateEvent(ok)).toEqual([]);
    expect(validateEvent({ ...ok, simulated: true })).toEqual([]);
    expect(validateEvent({ ...ok, ok: false, error: 'bot bloqueado' })).toEqual([]);
    expect(validateEvent({ ...ok, ok: false })).toHaveLength(1); // falta error
    expect(validateEvent({ ...ok, channel: 'sms' })).toHaveLength(1);
    expect(validateEvent({ ...ok, ref: undefined })).toHaveLength(1);
    expect(validateEvent({ ...ok, simulated: 'sí' })).toHaveLength(1);
  });

  it('valida eventos desconocidos o incompletos', () => {
    expect(validateEvent({ event: 'algo' })).toHaveLength(1);
    expect(validateEvent({ event: 'alarm.triggered', causes: [] })).toHaveLength(1);
  });
});

describe('docs/contrato.md', () => {
  const md = readFileSync(new URL('../docs/contrato.md', import.meta.url), 'utf8');
  const examples = [...md.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m) => m[1]).filter((j) => j.includes('"v": 1'));

  it('tiene ejemplos de los cuatro tipos de mensaje', () => {
    const types = new Set(examples.map((j) => JSON.parse(j).type));
    expect([...types].sort()).toEqual(['ack', 'cmd', 'event', 'state']);
  });

  it.each(examples.map((j, i) => [i + 1, j]))('ejemplo %i es válido según el contrato', (_, json) => {
    expect(validateMessage(JSON.parse(json))).toEqual([]);
  });
});
