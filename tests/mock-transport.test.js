import { describe, it, expect, afterEach } from 'vitest';
import { createMockTransport } from '../src/transport/mock.js';
import { readConfig } from '../src/core/config.js';
import { makeCommand } from '../src/core/contract.js';

const config = readConfig({});
const cmd = (payload) => makeCommand(payload, { deviceId: config.deviceId });

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

/** BroadcastChannel y Web Locks falsos, compartidos entre las "pestañas" de un mismo test. */
function fakeBrowser() {
  const channels = new Set();
  class FakeChannel {
    constructor() {
      this.onmessage = null;
      channels.add(this);
    }
    postMessage(data) {
      const copy = structuredClone(data);
      for (const ch of channels) if (ch !== this) queueMicrotask(() => ch.onmessage?.({ data: copy }));
    }
    close() {
      channels.delete(this);
    }
  }
  let holder = null;
  const waiting = [];
  const locks = {
    request(_name, cb) {
      if (!holder) {
        holder = cb;
        cb();
      } else {
        waiting.push(cb);
      }
    },
    // En el navegador el lock se libera solo al cerrar la pestaña; acá se simula a mano.
    release() {
      holder = waiting.shift() ?? null;
      holder?.();
    },
  };
  return { FakeChannel, locks };
}

const flush = () => new Promise((r) => setTimeout(r, 30));
const opened = [];
function open(opts) {
  const t = createMockTransport(config, { latencyMs: 1, ...opts });
  opened.push(t);
  return t;
}
afterEach(() => {
  opened.splice(0).forEach((t) => t.close());
});

describe('transporte mock', () => {
  it('sin BroadcastChannel funciona solo y queda online al recibir el estado', async () => {
    const t = open({ storage: memoryStorage(), BroadcastChannelImpl: null });
    const statuses = [];
    const msgs = [];
    t.onStatus((s) => statuses.push(s));
    t.onMessage((m) => msgs.push(m));
    t.connect();
    await flush();
    expect(statuses).toEqual(['online']);
    t.send(cmd({ cmd: 'arm' }));
    await flush();
    expect(msgs.map((m) => m.type)).toEqual(['state', 'event', 'event', 'state', 'ack']);
  });

  it('persiste el estado y lo recupera al recargar', async () => {
    const storage = memoryStorage();
    const a = open({ storage, BroadcastChannelImpl: null });
    a.connect();
    a.send(cmd({ cmd: 'arm' }));
    await flush();
    a.close();
    const b = open({ storage, BroadcastChannelImpl: null });
    const msgs = [];
    b.onMessage((m) => msgs.push(m));
    b.connect();
    await flush();
    expect(msgs[0].payload.mode).toBe('armado');
  });

  it('descarta un estado guardado corrupto o de otra versión', async () => {
    const storage = memoryStorage();
    storage.setItem('smarthome.mock.casa-01', JSON.stringify({ mode: 'alarma', sensors: {} }));
    const t = open({ storage, BroadcastChannelImpl: null });
    const msgs = [];
    t.onMessage((m) => msgs.push(m));
    t.connect();
    await flush();
    expect(msgs[0].payload.mode).toBe('desarmado');
  });

  it('dos pestañas: una es el dispositivo y la otra ve los mismos cambios', async () => {
    const { FakeChannel, locks } = fakeBrowser();
    const storage = memoryStorage();
    const a = open({ storage, BroadcastChannelImpl: FakeChannel, locks });
    const b = open({ storage, BroadcastChannelImpl: FakeChannel, locks });
    const seenByB = [];
    b.onMessage((m) => seenByB.push(m));
    a.connect();
    b.connect();
    await flush();
    expect(b.status).toBe('online'); // recibió el state que pidió con get_state

    const c = cmd({ cmd: 'arm' });
    b.send(c); // manda la pestaña B, responde la A (dispositivo)
    await flush();
    expect(seenByB.some((m) => m.type === 'ack' && m.payload.ack === c.id && m.payload.ok)).toBe(true);
    expect(seenByB.filter((m) => m.type === 'state').at(-1).payload.mode).toBe('armado');
  });

  it('si se cierra la pestaña-dispositivo, otra toma el lock y sigue con el estado guardado', async () => {
    const { FakeChannel, locks } = fakeBrowser();
    const storage = memoryStorage();
    const a = open({ storage, BroadcastChannelImpl: FakeChannel, locks });
    const b = open({ storage, BroadcastChannelImpl: FakeChannel, locks });
    a.connect();
    b.connect();
    a.send(cmd({ cmd: 'arm' }));
    await flush();
    a.close();
    locks.release();
    const seen = [];
    b.onMessage((m) => seen.push(m));
    b.send(cmd({ cmd: 'disarm' })); // solo es válido si B retomó el estado "armado"
    await flush();
    expect(seen.find((m) => m.type === 'ack').payload.ok).toBe(true);
  });

  it('n8n simulado: tras alarm.triggered publica notification.sent simulada con ref a esa alarma', async () => {
    const t = open({ storage: null, BroadcastChannelImpl: null, notifyDelayMs: 5 });
    const msgs = [];
    t.onMessage((m) => msgs.push(m));
    t.connect();
    t.send(cmd({ cmd: 'simulate', sensor: 'humo', active: true }));
    await flush();
    await flush(); // comando → alarma → notificación: tres timers encadenados
    const alarm = msgs.find((m) => m.payload.event === 'alarm.triggered');
    const note = msgs.find((m) => m.payload.event === 'notification.sent');
    expect(note.payload).toEqual({ event: 'notification.sent', channel: 'telegram', ok: true, ref: alarm.id, simulated: true });
  });

  it('Reiniciar demo desde una pestaña cliente: borra lo guardado y avisa a todas', async () => {
    const { FakeChannel, locks } = fakeBrowser();
    const storage = memoryStorage();
    const a = open({ storage, BroadcastChannelImpl: FakeChannel, locks });
    const b = open({ storage, BroadcastChannelImpl: FakeChannel, locks });
    const resets = [];
    a.onDemoReset(() => resets.push('a'));
    b.onDemoReset(() => resets.push('b'));
    const seenByB = [];
    b.onMessage((m) => seenByB.push(m));
    a.connect();
    b.connect();
    b.send(cmd({ cmd: 'simulate_all' }));
    await flush();
    expect(JSON.parse(storage.getItem('smarthome.mock.casa-01')).mode).toBe('alarma');

    b.resetDemo(); // B no es el dispositivo: se lo pide a A
    await flush();
    expect(resets.sort()).toEqual(['a', 'b']);
    expect(storage.getItem('smarthome.mock.casa-01')).toBeNull();
    const last = seenByB.filter((m) => m.type === 'state').at(-1).payload;
    expect(last).toMatchObject({ mode: 'desarmado', armed: false });
    expect(Object.values(last.sensors).every((s) => !s.active)).toBe(true);
  });

  it('cerrado: queda offline y no acepta comandos', () => {
    const t = open({ storage: null, BroadcastChannelImpl: null });
    t.connect();
    t.close();
    expect(t.status).toBe('offline');
    expect(() => t.send(cmd({ cmd: 'arm' }))).toThrow();
  });
});
