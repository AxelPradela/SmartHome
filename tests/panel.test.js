import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createInitialState, step, toSnapshot } from '../src/core/alarm-machine.js';
import { readConfig } from '../src/core/config.js';
import { createMockTransport } from '../src/transport/mock.js';
import { createPanelController } from '../src/panel/controller.js';
import { panelView, remainingSeconds, commandErrorText, alertTitle } from '../src/panel/view-model.js';
import { advanceContext, formatEvent, pushLog, LOG_LIMIT } from '../src/panel/log-format.js';

/** Snapshot después de aplicar entradas a la máquina (atajo para armar escenarios). */
function snapshotAfter(inputs, state = createInitialState({ exit_delay_s: 0 })) {
  for (const input of inputs) state = step(state, input).state;
  return toSnapshot(state);
}
const cmd = (c, extra = {}) => ({ type: 'cmd', cmd: c, ...extra });
const sensor = (s, active = true) => ({ type: 'sensor', sensor: s, active });
const ui = (device, extra = {}) => ({ conn: 'online', device, receivedAt: 0, pending: null, error: null, log: [], demo: true, ...extra });

describe('modelo de vista', () => {
  it('sin estado todavía: "Conectando…" y sin botones', () => {
    const vm = panelView(ui(null, { conn: 'connecting' }), 0);
    expect(vm.ready).toBe(false);
    expect(vm.hero.label).toBe('Conectando…');
    expect(vm.conn.text).toBe('Conectando…');
  });

  it('desarmado: botón Armar, franja con Desarmado activo, LED apagado', () => {
    const vm = panelView(ui(snapshotAfter([])), 0);
    expect(vm.hero.label).toBe('Desarmado');
    expect(vm.buttons.arm).toEqual({ disabled: false, text: 'Armar sistema' });
    expect(vm.buttons.disarm).toBeNull();
    expect(vm.modes.find((m) => m.active).id).toBe('desarmado');
    expect(vm.device.led.text).toBe('Apagado');
    expect(vm.device.siren.text).toBe('Silenciada');
    expect(vm.alert).toBeNull();
  });

  it('tiempo de salida: "Armando…" con cuenta "Vigilando en N s"', () => {
    const d = snapshotAfter([cmd('arm')], createInitialState());
    const vm = panelView(ui(d, { receivedAt: 1000 }), 3500);
    expect(vm.hero.label).toBe('Armando…');
    expect(vm.countdown.text).toBe('Vigilando en 28 s');
    expect(vm.buttons.disarm.text).toBe('Desarmar');
    expect(vm.device.led.text).toBe('Azul fijo');
  });

  it('intervención: cuenta "Alarma en N s", LED ámbar intermitente, pitido de aviso', () => {
    const d = snapshotAfter([cmd('arm'), sensor('puerta')]);
    const vm = panelView(ui(d), 0);
    expect(vm.countdown.text).toBe('Alarma en 15 s');
    expect(vm.device.led).toMatchObject({ text: 'Ámbar intermitente', cls: 'sh-blink-slow' });
    expect(vm.device.siren.text).toBe('Pitido de aviso');
    expect(vm.sensors.find((s) => s.id === 'puerta')).toMatchObject({ status: 'Abierta', action: 'Restablecer' });
  });

  it('alarma por humo e intrusión: aviso de varios riesgos, sirena sonando, botón silenciar', () => {
    const d = snapshotAfter([cmd('arm'), cmd('simulate_all')]);
    const vm = panelView(ui(d), 0);
    expect(vm.hero.desc).toMatch(/Varios riesgos a la vez/);
    expect(vm.alert.text).toBe('humo en la cocina e intrusión en 4 puntos de la casa al mismo tiempo.');
    expect(vm.buttons.silence.text).toBe('Silenciar sirena');
    expect(vm.device).toMatchObject({ siren: { text: 'Sonando' }, lights: { text: 'Encendidas' }, led: { cls: 'sh-blink' } });
  });

  it('alarma silenciada: sin botón silenciar y el aviso lo indica', () => {
    const d = snapshotAfter([sensor('humo'), cmd('silence_siren')]);
    const vm = panelView(ui(d), 0);
    expect(vm.hero.desc).toBe('Humo detectado. Sirena silenciada; las luces siguen encendidas.');
    expect(vm.buttons.silence).toBeNull();
    expect(vm.alert).toEqual({ title: 'Alarma activada:', text: 'se detectó humo en la cocina.', muted: true });
    expect(vm.device.siren.text).toBe('Silenciada por el usuario');
  });

  it('con un comando pendiente o sin conexión los botones se deshabilitan', () => {
    const d = snapshotAfter([]);
    expect(panelView(ui(d, { pending: 'arm' }), 0).buttons.arm).toEqual({ disabled: true, text: 'Armando…' });
    const offline = panelView(ui(d, { conn: 'offline' }), 0);
    expect(offline.buttons.arm.disabled).toBe(true);
    expect(offline.sensors.every((s) => s.disabled)).toBe(true);
    expect(offline.conn.text).toBe('Sin conexión');
  });

  it('el aviso solo dice "enviada" cuando llegó notification.sent real', () => {
    expect(alertTitle(null)).toBe('Alarma activada:');
    expect(alertTitle({ ok: true, simulated: true, channel: 'telegram' })).toBe('Notificación simulada (demo):');
    expect(alertTitle({ ok: true, simulated: false, channel: 'telegram' })).toBe('Notificación enviada por Telegram:');
    expect(alertTitle({ ok: false, simulated: false, channel: 'telegram', error: 'x' })).toBe('No se pudo enviar la notificación por Telegram:');
    const d = snapshotAfter([sensor('humo')]);
    expect(panelView(ui(d, { notification: { ok: true, simulated: true, channel: 'telegram' } }), 0).alert.title).toBe('Notificación simulada (demo):');
  });

  it('"Reiniciar demo" solo si el transporte lo permite', () => {
    const d = snapshotAfter([]);
    expect(panelView(ui(d, { canResetDemo: true }), 0).canResetDemo).toBe(true);
    expect(panelView(ui(d), 0).canResetDemo).toBe(false);
  });

  it('remainingSeconds interpola y no baja de 0', () => {
    expect(remainingSeconds({ remaining_s: 10, total_s: 15 }, 1000, 3999)).toBe(8);
    expect(remainingSeconds({ remaining_s: 2, total_s: 15 }, 0, 60_000)).toBe(0);
    expect(remainingSeconds(null, 0, 0)).toBeNull();
  });

  it('mensajes de error de comandos', () => {
    expect(commandErrorText('arm', 'timeout')).toBe('No se pudo armar el sistema: el dispositivo no respondió a tiempo.');
    expect(commandErrorText('disarm', 'raro')).toBe('No se pudo desarmar: error desconocido.');
  });
});

describe('historial', () => {
  const desarmado = snapshotAfter([]);
  const armado = snapshotAfter([cmd('arm')]);

  it('apertura desarmado atenuada; armado como advertencia; humo como alarma', () => {
    expect(formatEvent({ event: 'sensor.changed', sensor: 'puerta', active: true }, desarmado))
      .toEqual({ text: 'Puerta principal: abierta (sistema desarmado)', level: 'muted' });
    expect(formatEvent({ event: 'sensor.changed', sensor: 'movimiento', active: true }, armado))
      .toEqual({ text: 'Pasillo: movimiento', level: 'warn' });
    expect(formatEvent({ event: 'sensor.changed', sensor: 'humo', active: true }, desarmado))
      .toEqual({ text: 'Humo detectado en cocina', level: 'alarm' });
    expect(formatEvent({ event: 'sensor.changed', sensor: 'ventanaDorm', active: false }, armado))
      .toEqual({ text: 'Ventana dormitorio: cerrada', level: 'muted' });
  });

  it('alarmas y cambios de modo', () => {
    expect(formatEvent({ event: 'alarm.triggered', causes: ['intrusion'], by: 'timeout' }, armado).text).toBe('Tiempo agotado · alarma por intrusión');
    expect(formatEvent({ event: 'alarm.triggered', causes: ['intrusion', 'smoke'], by: 'sensor:humo' }, armado).text).toBe('Alarma por humo e intrusión al mismo tiempo');
    expect(formatEvent({ event: 'mode.changed', from: 'desarmado', to: 'armado', by: 'demo' }, desarmado).text).toBe('Sistema armado para la simulación');
    expect(formatEvent({ event: 'mode.changed', from: 'armado', to: 'intervencion', by: 'sensor:puerta' }, armado).text).toBe('Intervención iniciada · 15 s para desarmar');
    const alarmaHumo = snapshotAfter([cmd('arm'), sensor('humo')]);
    expect(formatEvent({ event: 'armed.changed', armed: false, by: 'web' }, alarmaHumo).level).toBe('alarm');
    expect(formatEvent({ event: 'armed.changed', armed: false, by: 'web' }, { ...armado, mode: 'desarmado' })).toBeNull(); // ya lo dijo mode.changed
    expect(formatEvent({ event: 'armed.changed', armed: true, by: 'web' }, armado)).toBeNull();
    expect(formatEvent({ event: 'mode.changed', from: 'intervencion', to: 'alarma', by: 'timeout' }, armado)).toBeNull(); // lo cubre alarm.triggered
  });

  it('notificaciones: simulada, enviada de verdad o con error', () => {
    const base = { event: 'notification.sent', channel: 'telegram', ref: 'a1' };
    expect(formatEvent({ ...base, ok: true, simulated: true }, armado)).toEqual({ text: 'Notificación simulada por Telegram (demo: no se envió nada)', level: 'info' });
    expect(formatEvent({ ...base, ok: true }, armado)).toEqual({ text: 'Notificación enviada por Telegram', level: 'info' });
    expect(formatEvent({ ...base, ok: false, error: 'sin conexión' }, armado)).toEqual({ text: 'No se pudo enviar la notificación por Telegram: sin conexión', level: 'alarm' });
  });

  it('simulate_all desde desarmado: las aperturas se registran como intrusión, no como "desarmado"', () => {
    let ctx = desarmado;
    const events = step(createInitialState(), cmd('simulate_all')).events;
    const lines = [];
    for (const e of events) {
      const line = formatEvent(e, ctx);
      if (line) lines.push(line);
      ctx = advanceContext(ctx, e);
    }
    expect(lines.find((l) => l.text.startsWith('Puerta principal'))).toEqual({ text: 'Puerta principal: abierta', level: 'warn' });
    expect(lines.some((l) => l.text.includes('desarmado'))).toBe(false);
  });

  it('el historial guarda lo más nuevo arriba y respeta el límite', () => {
    let log = [];
    for (let i = 0; i < LOG_LIMIT + 5; i++) log = pushLog(log, { t: '', text: String(i), level: 'info' });
    expect(log).toHaveLength(LOG_LIMIT);
    expect(log[0].text).toBe(String(LOG_LIMIT + 4));
  });
});

describe('controlador con el mock', () => {
  let controller;
  const config = readConfig({});

  beforeEach(() => {
    vi.useFakeTimers();
    const transport = createMockTransport(config, { latencyMs: 10, storage: null, BroadcastChannelImpl: null });
    controller = createPanelController({ transport, config });
    controller.start();
    vi.advanceTimersByTime(50);
  });
  afterEach(() => {
    controller.stop();
    vi.useRealTimers();
  });

  const settle = async (p) => {
    await vi.advanceTimersByTimeAsync(100);
    return p;
  };

  it('se conecta, recibe el estado y lo registra en el historial', () => {
    const s = controller.store.get();
    expect(s.conn).toBe('online');
    expect(s.device.mode).toBe('desarmado');
    expect(s.log[0].text).toBe('Conectado al dispositivo');
  });

  it('armar: pending mientras espera el ack y después el estado nuevo', async () => {
    const p = controller.arm();
    expect(controller.store.get().pending).toBe('arm');
    expect(await settle(p)).toBe(true);
    const s = controller.store.get();
    expect(s.pending).toBeNull();
    expect(s.device.mode).toBe('armado');
    expect(s.log[0].text).toBe('Sistema armado por el usuario');
  });

  it('un comando inválido muestra el error y se borra solo', async () => {
    expect(await settle(controller.disarm())).toBe(false);
    expect(controller.store.get().error).toBe('No se pudo desarmar: no se puede en el estado actual.');
    vi.advanceTimersByTime(6000);
    expect(controller.store.get().error).toBeNull();
  });

  it('no manda otro comando mientras hay uno pendiente', async () => {
    const first = controller.arm();
    expect(await controller.simulateAll()).toBe(false);
    await settle(first);
  });

  it('simular un sensor alterna entre activo y restablecido', async () => {
    await settle(controller.simulate('ventanaLiving'));
    expect(controller.store.get().device.sensors.ventanaLiving.active).toBe(true);
    await settle(controller.simulate('ventanaLiving'));
    expect(controller.store.get().device.sensors.ventanaLiving.active).toBe(false);
  });

  it('simular todo a la vez desarmado: arma, alarma con humo e intrusión, todo en el historial', async () => {
    await settle(controller.simulateAll());
    const s = controller.store.get();
    expect(s.device).toMatchObject({ mode: 'alarma', armed: true, causes: ['intrusion', 'smoke'] });
    const texts = s.log.map((l) => l.text);
    expect(texts).toContain('Sistema armado para la simulación');
    expect(texts).toContain('Alarma por humo e intrusión al mismo tiempo');
  });

  it('desarmar con humo presente deja la alarma silenciada; sin humo, desarma', async () => {
    await settle(controller.simulateAll());
    await settle(controller.disarm());
    expect(controller.store.get().device).toMatchObject({ mode: 'alarma', causes: ['smoke'], outputs: { siren: 'muted' } });
    await settle(controller.simulate('humo')); // se va el humo
    await settle(controller.disarm());
    expect(controller.store.get().device.mode).toBe('desarmado');
  });

  it('cuenta regresiva completa: salida, intervención y alarma por tiempo agotado', async () => {
    await settle(controller.arm());
    await vi.advanceTimersByTimeAsync(30_000); // tiempo de salida
    expect(controller.store.get().device.exit_countdown).toBeNull();
    await settle(controller.simulate('puerta'));
    expect(controller.store.get().device.mode).toBe('intervencion');
    await vi.advanceTimersByTimeAsync(15_000);
    const s = controller.store.get();
    expect(s.device).toMatchObject({ mode: 'alarma', causes: ['intrusion'] });
    expect(s.log[0].text).toBe('Tiempo agotado · alarma por intrusión');
  });

  it('con el mock la notificación llega marcada como simulada, ligada a la alarma en curso', async () => {
    await settle(controller.simulateAll());
    expect(controller.store.get().notification).toBeNull(); // todavía no llegó: el aviso no dice "enviada"
    await vi.advanceTimersByTimeAsync(1000);
    const s = controller.store.get();
    expect(s.notification).toEqual({ ok: true, simulated: true, channel: 'telegram', error: null });
    expect(s.log[0].text).toBe('Notificación simulada por Telegram (demo: no se envió nada)');
    expect(panelView(s, Date.now()).alert.title).toBe('Notificación simulada (demo):');
  });

  it('al salir de la alarma se olvida la notificación', async () => {
    await settle(controller.simulate('humo'));
    await vi.advanceTimersByTimeAsync(1000);
    await settle(controller.simulate('humo'));
    await settle(controller.disarm());
    expect(controller.store.get()).toMatchObject({ notification: null, alarmId: null });
  });

  it('Reiniciar demo: vuelve a desarmado, sensores en reposo, historial limpio', async () => {
    await settle(controller.simulateAll());
    controller.resetDemo();
    await vi.advanceTimersByTimeAsync(100);
    const s = controller.store.get();
    expect(s.device).toMatchObject({ mode: 'desarmado', armed: false, causes: [] });
    expect(Object.values(s.device.sensors).every((x) => !x.active)).toBe(true);
    expect(s.log.map((l) => l.text)).toEqual(['Demo reiniciada · todo desarmado y en reposo']);
    // la notificación simulada de la alarma anterior llega tarde y se ignora
    await vi.advanceTimersByTimeAsync(1000);
    expect(controller.store.get().log).toHaveLength(1);
    expect(controller.store.get().notification).toBeNull();
  });
});
