/** Vuelca el modelo de vista (view-model.js) en el DOM de panel.html. Sin lógica de negocio. */
import { LOG_DOTS } from './log-format.js';

const svg = (body) =>
  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

// Íconos del diseño, por tipo de sensor (markup fijo, sin datos del usuario).
const ICONS = {
  door: svg('<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><path d="M3 21h18"/><circle cx="14.5" cy="12" r="1"/>'),
  window: svg('<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M12 3v18M4 12h16"/>'),
  motion: svg('<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"/>'),
  smoke: svg('<path d="M12 3c1 3 4.5 4.8 4.5 9a4.5 4.5 0 0 1-9 0c0-2.2 1.2-3.6 2.3-4.6 0 2 .9 3.1 2.2 3.1 0-3-1-5 0-7.5z"/>'),
};

const $ = (id) => document.getElementById(id);

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function setButton(el, spec) {
  el.hidden = !spec;
  if (!spec) return;
  if (spec.text) setText(el, spec.text);
  el.disabled = spec.disabled;
}

/** Crea los nodos que se repiten (sensores, estados) una sola vez y devuelve una función render(vm). */
export function mountPanel(actions) {
  const sensorNodes = new Map();
  const modeNodes = new Map();
  let lastLog = null;

  $('btn-arm').addEventListener('click', actions.arm);
  $('btn-disarm').addEventListener('click', actions.disarm);
  $('btn-silence').addEventListener('click', actions.silence);
  $('btn-simulate-all').addEventListener('click', () => {
  // 1. Ejecuta la acción visual del panel
  actions.simulateAll();

  // 2. Envía la alerta masiva a Node.js -> Ngrok -> n8n -> Telegram
  fetch('https://hastily-travel-sanded.ngrok-free.dev/api/simular', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true'
    },
    body: JSON.stringify({
      dispositivo: "casa-01",
      sensorId: "todos",
      sensorNombre: "⚠️ SIMULACIÓN GENERAL (TODOS LOS SENSORES)",
      tipo: "Intrusión / Humo Múltiple",
      fecha: new Date().toISOString()
    })
  })
  .then(res => console.log('[SmartHome] Simular todo enviado a Node:', res.status))
  .catch(err => console.error('[SmartHome] Error enviando simular todo:', err));
});

  // Reiniciar demo: confirmación dentro de la página (no confirm() del navegador).
  const resetBtn = $('btn-reset-demo');
  const confirmBox = $('reset-confirm');
  const setConfirm = (open) => {
    confirmBox.hidden = !open;
    resetBtn.setAttribute('aria-expanded', String(open));
    (open ? $('btn-reset-cancel') : resetBtn).focus();
  };
  resetBtn.addEventListener('click', () => setConfirm(confirmBox.hidden));
  $('btn-reset-cancel').addEventListener('click', () => setConfirm(false));
  confirmBox.addEventListener('keydown', (e) => e.key === 'Escape' && setConfirm(false));
  $('btn-reset-ok').addEventListener('click', () => {
    setConfirm(false);
    actions.resetDemo();
  });

  function ensureSensors(sensors) {
    if (sensorNodes.size) return;
    const tpl = $('tpl-sensor');
    for (const s of sensors) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.querySelector('.sensor__icon').innerHTML = ICONS[s.kind];
      node.querySelector('.sensor__name').textContent = s.name;
      node.querySelector('.sensor__type').textContent = s.type;

      // Al hacer clic: simula localmente y evalúa si corresponde enviar la alerta a Node.js
      node.querySelector('.sensor__action').addEventListener('click', () => {
        actions.simulate(s.id);

        // Verificamos si tras simular el sensor pasó a estar en estado activo/disparado.
        // Se valida según el modelo de datos (s.active / s.triggered) o la clase CSS agregada al elemento.
        const estaActivo = Boolean(s.active || s.triggered || node.classList.contains('is-active') || node.classList.contains('sensor--active'));

        if (estaActivo) {
          fetch('https://hastily-travel-sanded.ngrok-free.dev/api/simular', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'ngrok-skip-browser-warning': 'true'
            },
            body: JSON.stringify({
              dispositivo: "casa-01",
              sensorId: s.id,
              sensorNombre: s.name,
              tipo: s.type,
              fecha: new Date().toISOString()
            })
          })
          .then(res => console.log('[SmartHome] Evento de alerta enviado a Node:', res.status))
          .catch(err => console.error('[SmartHome] Error al enviar a Node:', err));
        } else {
          console.log('[SmartHome] Sensor normalizado/desactivado: no se envía notificación.');
        }
      });

      $('sensors').append(node);
      sensorNodes.set(s.id, node);
    }
}

  function ensureModes(modes) {
    if (modeNodes.size) return;
    for (const m of modes) {
      const li = document.createElement('li');
      li.className = 'mode';
      li.innerHTML = '<div class="mode__head"><span class="dot"></span><span class="mode__label"></span></div><div class="mode__hint"></div>';
      li.querySelector('.dot').style.background = m.color;
      li.querySelector('.mode__label').textContent = m.label;
      $('modes').append(li);
      modeNodes.set(m.id, li);
    }
  }

  function renderLog(log) {
    if (log === lastLog) return;
    lastLog = log;
    const list = $('log');
    if (!log.length) {
      list.innerHTML = '<li class="log__empty">Todavía no hay eventos.</li>';
      return;
    }
    list.replaceChildren(...log.map((e) => {
      const li = document.createElement('li');
      li.className = 'log__item';
      const dot = document.createElement('span');
      dot.className = 'log__dot';
      dot.style.background = LOG_DOTS[e.level] ?? LOG_DOTS.muted;
      const time = document.createElement('span');
      time.className = 'log__time';
      time.textContent = e.t;
      const text = document.createElement('span');
      text.className = 'log__text';
      text.textContent = e.text;
      li.append(dot, time, text);
      return li;
    }));
  }

  return function render(vm) {
    // Conexión
    $('conn-dot').style.background = vm.conn.color;
    setText($('conn-text'), vm.conn.text);

    // Estado principal
    const hero = $('hero');
    hero.style.borderColor = vm.hero.border;
    const ring = $('hero-ring');
    ring.className = `hero__ring ${vm.hero.ring}`.trim();
    ring.style.color = vm.hero.color;
    ring.style.background = vm.hero.soft;
    $('hero-label').style.color = vm.hero.color;
    setText($('hero-label'), vm.hero.label);
    setText($('hero-desc'), vm.hero.desc);

    const cd = $('countdown');
    cd.hidden = !vm.countdown;
    if (vm.countdown) {
      setText(cd, vm.countdown.text);
      cd.style.color = vm.countdown.color;
    }

    setButton($('btn-arm'), vm.buttons?.arm);
    setButton($('btn-disarm'), vm.buttons?.disarm);
    setButton($('btn-silence'), vm.buttons?.silence);

    const err = $('cmd-error');
    err.hidden = !vm.error;
    if (vm.error) setText(err, vm.error);

    // Aviso de alarma
    $('alarm-alert').hidden = !vm.alert;
    if (vm.alert) {
      setText($('alarm-alert-title'), vm.alert.title);
      setText($('alarm-alert-text'), vm.alert.text);
      $('alarm-alert-muted').hidden = !vm.alert.muted;
    }

    renderLog(vm.log);
    if (!vm.ready) return;

    // Franja de estados
    ensureModes(vm.modes);
    for (const m of vm.modes) {
      const li = modeNodes.get(m.id);
      li.style.borderColor = m.border;
      li.style.background = m.bg;
      if (m.active) li.setAttribute('aria-current', 'true');
      else li.removeAttribute('aria-current');
      const label = li.querySelector('.mode__label');
      label.style.color = m.labelColor;
      setText(li.querySelector('.mode__hint'), m.hint);
    }

    // Sensores
    $('demo-controls').hidden = !vm.demo;
    resetBtn.hidden = !vm.canResetDemo;
    if (!vm.canResetDemo) confirmBox.hidden = true;
    $('btn-simulate-all').disabled = vm.buttons.simulateAll.disabled;
    ensureSensors(vm.sensors);
    for (const s of vm.sensors) {
      const node = sensorNodes.get(s.id);
      node.style.borderColor = s.border;
      const icon = node.querySelector('.sensor__icon');
      icon.style.color = s.color;
      icon.style.background = s.iconBg;
      const badge = node.querySelector('.sensor__badge');
      setText(badge, s.status);
      badge.style.color = s.color;
      badge.style.background = s.iconBg;
      const btn = node.querySelector('.sensor__action');
      btn.hidden = !vm.demo;
      setText(btn, s.action);
      btn.setAttribute('aria-label', s.actionAria);
      btn.disabled = s.disabled;
    }

    // Respuesta del dispositivo
    const led = $('led');
    led.className = `led ${vm.device.led.cls}`.trim();
    led.style.background = vm.device.led.color;
    led.style.boxShadow = `0 0 12px ${vm.device.led.glow}`;
    setText($('led-text'), vm.device.led.text);
    $('siren-icon').style.color = vm.device.siren.color;
    setText($('siren-text'), vm.device.siren.text);
    $('lights-icon').style.color = vm.device.lights.color;
    setText($('lights-text'), vm.device.lights.text);
  };
}
