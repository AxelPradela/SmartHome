import { config } from '../core/config.js';
import { createAuthApi, AuthError } from '../auth/auth-api.js';
import { browserSessionStore } from '../auth/session.js';

const PANEL_URL = './panel.html';

const ERRORS = {
  invalid_input: 'Ingresá un correo válido y tu contraseña.',
  invalid_credentials: 'El correo o la contraseña no son correctos.',
  network: 'No pudimos conectarnos con el servidor. Revisá tu conexión e intentá de nuevo.',
  server: 'El servidor respondió con un error. Intentá de nuevo en unos minutos.',
};

const sessions = browserSessionStore();
if (sessions.load()) location.replace(PANEL_URL);

const auth = createAuthApi(config);
const $ = (id) => document.getElementById(id);

// --- Mostrar / ocultar contraseña ---
const pass = $('sh-pass');
const toggle = $('toggle-pass');
toggle.addEventListener('click', () => {
  const show = pass.type === 'password';
  pass.type = show ? 'text' : 'password';
  toggle.setAttribute('aria-pressed', String(show));
  toggle.setAttribute('aria-label', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
  $('icon-eye').hidden = show;
  $('icon-eye-off').hidden = !show;
});

function setBusy(button, busy, idleText, busyText) {
  button.disabled = busy;
  button.textContent = busy ? busyText : idleText;
}

function errorMessage(err) {
  return ERRORS[err instanceof AuthError ? err.code : 'server'];
}

// --- Login ---
const loginForm = $('login-form');
const loginError = $('login-error');
const loginSubmit = $('login-submit');
const email = $('sh-email');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  email.removeAttribute('aria-invalid');
  pass.removeAttribute('aria-invalid');
  setBusy(loginSubmit, true, 'Ingresar', 'Ingresando…');
  try {
    const result = await auth.login(email.value, pass.value, $('sh-remember').checked);
    sessions.save(result, $('sh-remember').checked);
    location.replace(PANEL_URL);
  } catch (err) {
    loginError.textContent = errorMessage(err);
    loginError.hidden = false;
    email.setAttribute('aria-invalid', 'true');
    pass.setAttribute('aria-invalid', 'true');
    setBusy(loginSubmit, false, 'Ingresar', 'Ingresando…');
  }
});

// --- Recuperar contraseña ---
const viewLogin = $('view-login');
const viewRecover = $('view-recover');
const recoverEmail = $('sh-recover-email');
const recoverMsg = $('recover-msg');
const recoverSubmit = $('recover-submit');

$('go-recover').addEventListener('click', () => {
  viewLogin.hidden = true;
  viewRecover.hidden = false;
  recoverMsg.hidden = true;
  recoverEmail.value = email.value;
  $('recover-title').focus();
});

$('go-login').addEventListener('click', () => {
  viewRecover.hidden = true;
  viewLogin.hidden = false;
  email.focus();
});

$('recover-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  recoverMsg.hidden = true;
  setBusy(recoverSubmit, true, 'Enviar instrucciones', 'Enviando…');
  try {
    await auth.recover(recoverEmail.value);
    recoverMsg.className = 'notice notice--ok';
    recoverMsg.textContent = 'Si el correo está registrado, te llegan las instrucciones en unos minutos.';
  } catch (err) {
    recoverMsg.className = 'notice notice--error';
    recoverMsg.textContent = err instanceof AuthError && err.code === 'invalid_input' ? 'Ingresá un correo válido.' : errorMessage(err);
  } finally {
    recoverMsg.hidden = false;
    setBusy(recoverSubmit, false, 'Enviar instrucciones', 'Enviando…');
  }
});

// --- Pista de credenciales en modo demo ---
if (config.auth === 'mock') {
  const hint = $('demo-hint');
  hint.textContent = `Modo demo · ${config.mockEmail} / ${config.mockPassword}`;
  hint.hidden = false;
}
