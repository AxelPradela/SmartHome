# Start Home — Web

Sistema inteligente de automatización y seguridad para el hogar. Proyecto en equipo de la materia
**Programación en Tiempo Real**. Objetivo: monitorear el hogar de forma autónoma y notificar al
usuario situaciones de riesgo en tiempo real.

## Equipo y responsabilidades
- **Hardware** (compañero): microcontrolador con sensores de puerta, ventanas, movimiento y humo + LED y sirena.
- **Backend**: n8n (webhooks) o una API. Todavía no está listo → la web debe funcionar con un mock.
- **Web** (este repo): login + panel donde el usuario ve y controla el sistema.

**Sin definir aún:** si el micro habla HTTP o MQTT, y el formato exacto de eventos/comandos.
Todo acceso al backend pasa por una capa de transporte intercambiable (ver Arquitectura). No acoplar
la UI a un protocolo concreto.

## Reglas de dominio (no negociables)
Estados: `desarmado` → `armado` → `intervencion` → `alarma`.
- **Desarmado**: no vigila aperturas ni movimiento. El humo sigue activo siempre.
- **Armado**: vigila puertas, ventanas y movimiento.
- **Intervención**: detección estando armado. Cuenta regresiva (15 s por defecto, configurable 5–60)
  para desarmar; si llega a 0 → alarma por intrusión.
- **Alarma**: intrusión confirmada o humo. Sirena + luces + notificación al usuario.
- El **humo dispara alarma siempre**, aunque esté desarmado.
- Humo + intrusión a la vez → se muestra como **varios riesgos simultáneos** (`causes` es una lista, no un valor único).
- Detección estando desarmado (no humo) → solo se registra en el historial.

Respuesta del dispositivo:
| Estado | LED | Sirena | Luces |
|---|---|---|---|
| desarmado | apagado | silenciada | apagadas |
| armado | azul fijo | silenciada | apagadas |
| intervencion | ámbar intermitente | pitido de aviso | apagadas |
| alarma | rojo intermitente | sonando (silenciable desde la web) | encendidas |

Silenciar la sirena NO sale del estado alarma; para eso hay que desarmar.

Sensores (ids estables, usarlos en código y contrato):
| id | Nombre | Tipo | kind |
|---|---|---|---|
| `puerta` | Puerta principal | Sensor magnético | door |
| `ventanaLiving` | Ventana living | Sensor magnético | window |
| `ventanaDorm` | Ventana dormitorio | Sensor magnético | window |
| `movimiento` | Pasillo | Sensor de movimiento | motion |
| `humo` | Cocina | Detector de humo | smoke |

## Diseño (fuente de verdad visual)
`Start Home.html` contiene ambas pantallas (Login 1440×900 y Panel de control 1440×1320). Es un
**bundle empaquetado**: no se lee como HTML normal. Para extraerlo: tomar `<script type="__bundler/manifest">`,
decodificar cada entrada (base64 → gunzip si `compressed`). Cada página es a su vez otro bundle con su
propio manifest; su `__bundler/template` (JSON string) tiene el markup y un `<script type="text/x-dc">`
con la lógica de ejemplo (clase `Component extends DCLogic`, método `renderVals`). Las fuentes woff2
de IBM Plex vienen embebidas.

No hay `login.html` en la carpeta: el login se reconstruye desde el template de la página Login del bundle.

Respetar estética, colores y tipografía. Tokens extraídos del diseño:
- Fuentes: `IBM Plex Sans` (400/500/600/700) para UI, `IBM Plex Mono` (400/500) para etiquetas, horas, estados técnicos.
- Fondo `#0E1318`, panel lateral login `#121920`, superficies `#151C23`, superficie elevada `#18212A` / `#1C252E`.
- Bordes `#26313B`, `#2A3540`, `#2F3B47`, separadores `#222C35`.
- Texto `#E6EBF0`, `#DCE3EA`, `#C3CCD5`, `#B7C2CD`, secundario `#9AA7B4`, placeholder `#6F7C89`.
- Estados: desarmado `#A9B5C1`, armado `#5AA2FF` (borde `#2B4B73`), intervención `#F5B041` (borde `#6B5226`),
  alarma `#FF6B6B` (borde `#7A2E33`, texto sobre alarma `#FFD2D2`). Fondos suaves = mismo color al 0.10–0.14 de alpha.
- Otros: online `#3DD68C`, luces encendidas `#F5D76E`, apagado/mute `#7C8996`, LED apagado `#3A4652`,
  links `#7DB5FF` (hover `#B5D4FF`), texto sobre botón primario `#0B1520`.
- Radios: 10–12px controles, 14–16px tarjetas, 20px tarjeta de estado, 999px pills. Botones ≥44px de alto.
- Animaciones: `sh-blink` (1s steps, alarma), `sh-blink-slow` (1.6s, intervención), `sh-pulse` (anillo rojo en alarma).
- Idioma de la UI: español rioplatense (voseo: «Tocá», «Ingresá», «Desarmá»). Hora con `es-AR`.

## Decisiones (aprobadas por el usuario, pendientes de confirmar con el equipo)
- Desarmar con humo todavía presente → vuelve a `alarma` con la sirena silenciada (`siren: "muted"`).
- El estado de cada sensor lo informa el micro. Solo en el mock los sensores vuelven a reposo al restablecerlos.
- La cuenta regresiva la lleva el micro; la web interpola `remaining_s` entre snapshots.
- Notificaciones por Telegram, enviadas desde n8n.
- Login: usuario fijo validado por webhook de n8n (`POST /auth/login`, `POST /auth/recover`); en el mock, credenciales de prueba de `.env`.
- `simulate` y `simulate_all` son comandos **solo demo**: los atiende el transporte mock (o un modo demo del micro).
- La web se conecta al broker con un usuario de permisos limitados (lee `state`/`event`/`online`/`ack`, escribe solo `cmd`).
  Las credenciales en `.env` (`VITE_*`) terminan en el JS público: no son seguridad real.
- Paso 4 (transporte MQTT + `device-sim`) en espera hasta confirmar el microcontrolador y su conectividad.

## Comandos
- `npm run dev` — servidor de desarrollo (login en `/`, panel en `/panel.html`).
- `npm test` — tests con Vitest (`tests/**/*.test.js`).
- `npm run build` — build estático en `dist/`.

## Flujo de trabajo
Al terminar cada paso: correr los tests, mostrar el resumen de cambios y esperar el OK del usuario antes de hacer commit y push.

## Arquitectura
- **El dispositivo es la fuente de verdad del estado** (máquina de estados y cuenta regresiva corren en el micro).
  La web muestra snapshots/eventos y envía comandos; nunca decide el estado por su cuenta, salvo en el mock.
- Capa `transport` con implementaciones intercambiables: `mock` (dispositivo virtual en el navegador),
  `mqtt` (MQTT sobre WebSocket) y `http` (webhooks n8n + polling). Se elige por config (`VITE_TRANSPORT`).
- La máquina de estados en JS (`alarm-machine`) es pura y testeable; la usa el mock y sirve de
  especificación ejecutable para el firmware.
- Contrato JSON versionado (`v`), sobre común `{v, id, type, ts, deviceId, payload}`. Ver `docs/contrato.md` cuando exista.

## Reglas de trabajo
- No escribir código de la app sin plan aprobado por el usuario.
- Cualquier cambio al contrato JSON se documenta en `docs/contrato.md` y se avisa: lo consumen hardware y n8n.
- Sin secretos en el repo (credenciales de broker/n8n van en `.env`, con `.env.example` versionado).
