import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockDevice } from '../src/transport/mock-device.js';
import { createInitialState } from '../src/core/alarm-machine.js';
import { makeCommand, validateMessage } from '../src/core/contract.js';

const deviceId = 'casa-01';
const cmd = (payload) => makeCommand(payload, { deviceId });

function setup(initialState = createInitialState()) {
  const sent = [];
  const saved = [];
  const device = createMockDevice({ deviceId, initialState, publish: (m) => sent.push(m), onStateChange: (s) => saved.push(s) });
  return { device, sent, saved, types: () => sent.map((m) => m.type) };
}

describe('dispositivo virtual', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('al iniciar publica el estado', () => {
    const { device, sent } = setup();
    device.start();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'state', payload: { mode: 'desarmado' } });
    device.stop();
  });

  it('un comando publica eventos, después state y al final el ack con el mismo id', () => {
    const { device, sent, types, saved } = setup();
    const c = cmd({ cmd: 'arm' });
    device.handle(c);
    expect(types()).toEqual(['event', 'event', 'state', 'ack']); // mode.changed + armed.changed
    expect(sent[3].payload).toEqual({ ack: c.id, ok: true });
    expect(saved.at(-1).mode).toBe('armado');
    for (const m of sent) expect(validateMessage(m)).toEqual([]);
  });

  it('comando rechazado: solo ack con el error, sin state', () => {
    const { device, sent } = setup();
    device.handle(cmd({ cmd: 'disarm' }));
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ ok: false, error: 'invalid_transition' });
  });

  it('mensaje mal formado: ack con invalid_payload / unknown_command', () => {
    const { device, sent } = setup();
    device.handle(cmd({ cmd: 'simulate', sensor: 'garage', active: true }));
    device.handle(cmd({ cmd: 'abrir_garage' }));
    expect(sent.map((m) => m.payload.error)).toEqual(['invalid_payload', 'unknown_command']);
  });

  it('get_state republica el estado aunque no cambie', () => {
    const { device, types } = setup();
    device.handle(cmd({ cmd: 'get_state' }));
    expect(types()).toEqual(['state', 'ack']);
  });

  it('cuenta el tiempo de salida en segundos enteros desde que se armó', () => {
    const { device, sent } = setup();
    device.start();
    vi.advanceTimersByTime(700); // armar a mitad de un segundo
    device.handle(cmd({ cmd: 'arm' }));
    vi.advanceTimersByTime(999);
    expect(device.state.exit_countdown.remaining_s).toBe(30);
    vi.advanceTimersByTime(100); // el intervalo interno es de 100 ms
    expect(device.state.exit_countdown.remaining_s).toBe(29);
    vi.advanceTimersByTime(29_000);
    expect(device.state.exit_countdown).toBeNull();
    expect(sent.some((m) => m.payload.event === 'exit_delay.ended')).toBe(true);
    device.stop();
  });

  it('si el timer se atrasa (pestaña en segundo plano) aplica todos los segundos que pasaron', () => {
    let clock = 0;
    let fire;
    const device = createMockDevice({
      deviceId, publish: () => {}, initialState: createInitialState({ exit_delay_s: 0 }),
      now: () => clock, setInterval: (fn) => { fire = fn; return 1; }, clearInterval: () => {},
    });
    device.start();
    device.handle(cmd({ cmd: 'arm' }));
    device.handle(cmd({ cmd: 'simulate', sensor: 'puerta', active: true }));
    clock += 10_000; // el navegador no corrió el timer en 10 s
    fire();
    expect(device.state.countdown.remaining_s).toBe(5);
    clock += 60_000;
    fire();
    expect(device.state).toMatchObject({ mode: 'alarma', causes: ['intrusion'] });
  });

  it('fuera de una cuenta regresiva los ticks no publican nada', () => {
    const { device, sent } = setup();
    device.start();
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(1); // solo el state inicial
    device.stop();
  });
});
