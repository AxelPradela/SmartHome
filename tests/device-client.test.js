import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDeviceClient } from '../src/core/device-client.js';
import { makeAck, makeEvent, makeState } from '../src/core/contract.js';
import { createInitialState, toSnapshot } from '../src/core/alarm-machine.js';

const deviceId = 'casa-01';

function fakeTransport() {
  const t = { status: 'connecting', sent: [], msgCb: null, statusCb: null };
  Object.assign(t, {
    connect: vi.fn(),
    close: vi.fn(),
    send: (m) => t.sent.push(m),
    onMessage: (cb) => { t.msgCb = cb; },
    onStatus: (cb) => { t.statusCb = cb; },
    emit: (m) => t.msgCb(m),
  });
  return t;
}

describe('device client', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resuelve el comando con el ack ok', async () => {
    const t = fakeTransport();
    const c = createDeviceClient(t, { deviceId });
    const p = c.command({ cmd: 'arm' });
    expect(t.sent[0]).toMatchObject({ type: 'cmd', deviceId, payload: { cmd: 'arm' } });
    t.emit(makeAck(t.sent[0].id, { ok: true }, { deviceId }));
    await expect(p).resolves.toEqual({ ack: t.sent[0].id, ok: true });
  });

  it('rechaza con el código del ack de error', async () => {
    const t = fakeTransport();
    const c = createDeviceClient(t, { deviceId });
    const p = c.command({ cmd: 'disarm' });
    t.emit(makeAck(t.sent[0].id, { ok: false, error: 'invalid_transition' }, { deviceId }));
    await expect(p).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('rechaza por timeout si no llega el ack en 3 s', async () => {
    const t = fakeTransport();
    const c = createDeviceClient(t, { deviceId });
    const p = c.command({ cmd: 'arm' });
    vi.advanceTimersByTime(3000);
    await expect(p).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rechaza de inmediato si está offline', async () => {
    const t = fakeTransport();
    t.status = 'offline';
    await expect(createDeviceClient(t, { deviceId }).command({ cmd: 'arm' })).rejects.toMatchObject({ code: 'offline' });
    expect(t.sent).toHaveLength(0);
  });

  it('entrega state y event válidos; descarta inválidos y de otro dispositivo', () => {
    const t = fakeTransport();
    const onState = vi.fn();
    const onEvent = vi.fn();
    const onInvalid = vi.fn();
    createDeviceClient(t, { deviceId, onState, onEvent, onInvalid });
    const snap = toSnapshot(createInitialState());
    t.emit(makeState(snap, { deviceId }));
    t.emit(makeEvent({ event: 'siren.silenced', by: 'web' }, { deviceId }));
    t.emit(makeState({ ...snap, mode: 'volando' }, { deviceId }));
    t.emit(makeState(snap, { deviceId: 'otra-casa' }));
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onInvalid).toHaveBeenCalledTimes(1);
  });

  it('ignora un snapshot más viejo que el último recibido', () => {
    const t = fakeTransport();
    const onState = vi.fn();
    createDeviceClient(t, { deviceId, onState });
    const snap = toSnapshot(createInitialState());
    t.emit(makeState(snap, { deviceId, ts: '2026-10-12T19:00:05Z' }));
    t.emit(makeState(snap, { deviceId, ts: '2026-10-12T19:00:01Z' }));
    expect(onState).toHaveBeenCalledTimes(1);
  });

  it('ignora acks de comandos que no mandó (otra pestaña)', () => {
    const t = fakeTransport();
    createDeviceClient(t, { deviceId });
    expect(() => t.emit(makeAck('ajeno', { ok: true }, { deviceId }))).not.toThrow();
  });

  it('al cerrar rechaza los comandos pendientes', async () => {
    const t = fakeTransport();
    const c = createDeviceClient(t, { deviceId });
    const p = c.command({ cmd: 'arm' });
    c.close();
    await expect(p).rejects.toMatchObject({ code: 'offline' });
    expect(t.close).toHaveBeenCalled();
  });
});
