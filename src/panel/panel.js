import { browserSessionStore } from '../auth/session.js';

const sessions = browserSessionStore();
const current = sessions.load();

if (!current) {
  location.replace('./index.html');
} else {
  document.getElementById('user').textContent = current.user.email;
  document.getElementById('logout').addEventListener('click', () => {
    sessions.clear();
    location.replace('./index.html');
  });
}
