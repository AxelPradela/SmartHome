import { browserSessionStore } from '../auth/session.js';
import { config } from '../core/config.js';
import { createTransport } from '../transport/index.js';
import { createPanelController } from './controller.js';
import { mountPanel } from './render.js';
import { panelView } from './view-model.js';

const sessions = browserSessionStore();
const current = sessions.load();

if (!current) {
  location.replace('./index.html');
} else {
  document.getElementById('user').textContent = current.user.email;

  const controller = createPanelController({ transport: createTransport(config), config });
  const render = mountPanel(controller);
  const draw = () => render(panelView(controller.store.get(), Date.now()));

  controller.store.subscribe(draw);
  // Las cuentas regresivas se interpolan entre snapshots: redibujar seguido para que el número no salte.
  setInterval(() => {
    const { device } = controller.store.get();
    if (device?.countdown || device?.exit_countdown) draw();
  }, 250);

  document.getElementById('logout').addEventListener('click', () => {
    controller.stop();
    sessions.clear();
    location.replace('./index.html');
  });

  draw();
  controller.start();
}
