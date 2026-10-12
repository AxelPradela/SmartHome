# Contrato de mensajes — Smart Home v1

Acuerdo entre **hardware** (micro), **backend** (n8n) y **web** sobre los mensajes que intercambian.
Estado: **borrador para acordar con el equipo.** La implementación de referencia está en
`src/core/contract.js` (validación) y `src/core/alarm-machine.js` (comportamiento esperado del micro).

> Los ejemplos JSON con `"v": 1` de este archivo se validan automáticamente en `tests/contract.test.js`.
> Si cambiás el contrato, actualizá el código, este documento y los tests juntos, y avisá al equipo.

## 1. Transporte

Pendiente de confirmar según el microcontrolador y su conectividad. La propuesta es un **broker MQTT**
(con listener WebSocket para la web). Si el micro solo puede hablar HTTP, hace POST a webhooks de n8n con los
mismos mensajes y n8n los republica en el broker: el formato no cambia.

| Tópico | Publica | Se suscribe | Retenido | QoS | Contenido |
|---|---|---|---|---|---|
| `smarthome/{deviceId}/state` | micro | web, n8n | **sí** | 1 | Snapshot completo (§3) |
| `smarthome/{deviceId}/event` | micro | web, n8n | no | 1 | Evento puntual (§4) |
| `smarthome/{deviceId}/cmd` | web | micro | no | 1 | Comando (§5) |
| `smarthome/{deviceId}/ack` | micro | web | no | 1 | Respuesta a un comando (§6) |
| `smarthome/{deviceId}/online` | micro (LWT) | web, n8n | **sí** | 1 | `true` / `false` (texto plano, sin sobre) |

- **Retenido**: el broker guarda el último `state` y `online`, así la web ve el estado apenas se conecta.
- **LWT** (*Last Will and Testament*): el micro registra `online=false` al conectarse y publica `online=true`;
  si se cae, el broker publica `false` solo.
- El micro publica `state` **cada vez que algo cambia** y además cada 1 s durante la intervención
  (para que la cuenta regresiva se vea en vivo).
- `deviceId` por defecto: `casa-01`.

## 2. Sobre común

Todos los mensajes (salvo `online`) van envueltos así:

| Campo | Tipo | Descripción |
|---|---|---|
| `v` | entero | Versión del contrato. Hoy `1`. |
| `id` | texto | Identificador único del mensaje (UUID recomendado). En un comando, el `ack` lo repite. |
| `type` | texto | `state` \| `event` \| `cmd` \| `ack` |
| `ts` | texto | Fecha y hora ISO 8601 en UTC. Si el micro no tiene hora (sin NTP), n8n o la web usan la de recepción. |
| `deviceId` | texto | Dispositivo que emite o al que va dirigido. |
| `payload` | objeto | Depende de `type`. |

Un mensaje que no valida se descarta y se registra en consola; nunca rompe la UI.

## 3. Estado (`type: "state"`)

Snapshot completo. Es la **fuente de verdad**: la web dibuja todo a partir de este mensaje.

```json
{
  "v": 1,
  "id": "6f1c2a9e-5b0d-4c1e-9a3f-2d7b8e4c1a00",
  "type": "state",
  "ts": "2026-10-12T19:04:11Z",
  "deviceId": "casa-01",
  "payload": {
    "mode": "alarma",
    "armed": true,
    "causes": ["intrusion", "smoke"],
    "countdown": null,
    "exit_countdown": null,
    "sensors": {
      "puerta":        { "kind": "door",   "active": true },
      "ventanaLiving": { "kind": "window", "active": false },
      "ventanaDorm":   { "kind": "window", "active": false },
      "movimiento":    { "kind": "motion", "active": true },
      "humo":          { "kind": "smoke",  "active": true }
    },
    "outputs": {
      "led": { "color": "red", "pattern": "blink" },
      "siren": "on",
      "lights": true
    },
    "config": { "entry_delay_s": 15, "exit_delay_s": 30 }
  }
}
```

| Campo | Valores | Notas |
|---|---|---|
| `mode` | `desarmado` \| `armado` \| `intervencion` \| `alarma` | |
| `armed` | booleano | Si el usuario dejó el sistema armado. Puede haber `alarma` con `armed: false` (humo). |
| `causes` | lista de `intrusion` \| `smoke` | Vacía fuera de `alarma`; al menos una en `alarma`. Ambas = varios riesgos simultáneos. Orden alfabético. |
| `countdown` | `{ remaining_s, total_s }` o `null` | Tiempo de entrada. Solo en `intervencion`. La lleva el micro; la web interpola entre snapshots. |
| `exit_countdown` | `{ remaining_s, total_s }` o `null` | Tiempo de salida ⚠️. Solo en `armado`, recién armado: mientras no sea `null` las aperturas y el movimiento no disparan intervención. La web lo muestra como «Armando…». |
| `sensors.<id>.active` | booleano | `true` = abierta / movimiento / humo. Lo informa el micro. |
| `outputs.led` | `color`: `off` \| `blue` \| `amber` \| `red` · `pattern`: `solid` \| `blink` | |
| `outputs.siren` | `off` \| `warning` \| `on` \| `muted` | `warning` = pitido de aviso en intervención. `muted` = silenciada en alarma. |
| `outputs.lights` | booleano | Luces de la casa (encendidas en alarma). |
| `config.entry_delay_s` | entero 5–60 | Segundos del tiempo de entrada (intervención). Por defecto 15. |
| `config.exit_delay_s` | entero 0–120 | Segundos del tiempo de salida ⚠️. Por defecto 30. `0` = sin tiempo de salida. |

Sensores (ids fijos):

| id | Nombre en la UI | kind |
|---|---|---|
| `puerta` | Puerta principal | `door` |
| `ventanaLiving` | Ventana living | `window` |
| `ventanaDorm` | Ventana dormitorio | `window` |
| `movimiento` | Pasillo | `motion` |
| `humo` | Cocina | `smoke` |

Ejemplo en intervención:

```json
{
  "v": 1,
  "id": "0b9d3f4e-1c2a-4e5f-8a7b-6c5d4e3f2a10",
  "type": "state",
  "ts": "2026-10-12T19:03:58Z",
  "deviceId": "casa-01",
  "payload": {
    "mode": "intervencion",
    "armed": true,
    "causes": [],
    "countdown": { "remaining_s": 12, "total_s": 15 },
    "exit_countdown": null,
    "sensors": {
      "puerta":        { "kind": "door",   "active": true },
      "ventanaLiving": { "kind": "window", "active": false },
      "ventanaDorm":   { "kind": "window", "active": false },
      "movimiento":    { "kind": "motion", "active": false },
      "humo":          { "kind": "smoke",  "active": false }
    },
    "outputs": {
      "led": { "color": "amber", "pattern": "blink" },
      "siren": "warning",
      "lights": false
    },
    "config": { "entry_delay_s": 15, "exit_delay_s": 30 }
  }
}
```

Ejemplo recién armado, durante el tiempo de salida:

```json
{
  "v": 1,
  "id": "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
  "type": "state",
  "ts": "2026-10-12T19:02:10Z",
  "deviceId": "casa-01",
  "payload": {
    "mode": "armado",
    "armed": true,
    "causes": [],
    "countdown": null,
    "exit_countdown": { "remaining_s": 22, "total_s": 30 },
    "sensors": {
      "puerta":        { "kind": "door",   "active": true },
      "ventanaLiving": { "kind": "window", "active": false },
      "ventanaDorm":   { "kind": "window", "active": false },
      "movimiento":    { "kind": "motion", "active": false },
      "humo":          { "kind": "smoke",  "active": false }
    },
    "outputs": {
      "led": { "color": "blue", "pattern": "solid" },
      "siren": "off",
      "lights": false
    },
    "config": { "entry_delay_s": 15, "exit_delay_s": 30 }
  }
}
```

## 4. Eventos (`type: "event"`)

Hechos puntuales. Alimentan el historial de la web y las notificaciones de n8n (Telegram).

| `event` | Campos | Cuándo |
|---|---|---|
| `sensor.changed` | `sensor`, `active` | Un sensor cambia de valor (en cualquier modo). |
| `mode.changed` | `from`, `to`, `by` | Cambia el modo. |
| `alarm.triggered` | `causes`, `by` | Aparece una causa de alarma nueva (incluye todas las causas vigentes). |
| `siren.silenced` | `by` | Se silencia la sirena (comando o al desarmar con humo presente). |
| `config.changed` | `entry_delay_s` y/o `exit_delay_s` | Cambia la configuración (solo los campos que cambiaron). |
| `exit_delay.ended` | — | Terminó el tiempo de salida ⚠️: desde ahora el sistema vigila. |

`by` indica el origen: `web`, `device` (botón físico, si existe), `timeout` (fin de la cuenta regresiva),
`sensor:<id>` o `demo` (lo armó `simulate_all`).

**n8n notifica por Telegram** al menos en `alarm.triggered`, y en `online` → `false`.

```json
{
  "v": 1,
  "id": "a3e1c7d2-9b8f-4a6e-8c5d-1f2e3d4c5b60",
  "type": "event",
  "ts": "2026-10-12T19:04:11Z",
  "deviceId": "casa-01",
  "payload": { "event": "alarm.triggered", "causes": ["intrusion", "smoke"], "by": "sensor:humo" }
}
```

```json
{
  "v": 1,
  "id": "c4d5e6f7-0a1b-4c2d-9e3f-4a5b6c7d8e90",
  "type": "event",
  "ts": "2026-10-12T19:03:46Z",
  "deviceId": "casa-01",
  "payload": { "event": "mode.changed", "from": "armado", "to": "intervencion", "by": "sensor:puerta" }
}
```

## 5. Comandos (`type: "cmd"`)

Los envía la web; los ejecuta el micro y responde con un `ack` (§6) y, si algo cambió, con un nuevo `state`.

| `cmd` | Campos | Válido en | Efecto |
|---|---|---|---|
| `arm` | — | `desarmado` | → `armado` |
| `disarm` | — | todo menos `desarmado` | → `desarmado`; si hay humo presente → `alarma` con sirena `muted` |
| `silence_siren` | — | `alarma` con sirena `on` | sirena → `muted` (sigue en `alarma`) |
| `get_state` | — | siempre | el micro republica `state` |
| `set_config` | `entry_delay_s` (5–60) y/o `exit_delay_s` (0–120) | siempre | aplica a la próxima cuenta regresiva |
| `simulate` ⚠️ | `sensor`, `active` | siempre | **solo demo**: como si ese sensor cambiara |
| `simulate_all` ⚠️ | — | siempre | **solo demo**: si está desarmado primero arma (sin tiempo de salida, `by: "demo"`); si está en tiempo de salida lo termina; después activa los 5 sensores a la vez. Así la demo siempre muestra intrusión y humo juntos. |

> ⚠️ **`simulate` y `simulate_all` son solo demo.** Los atiende el transporte mock de la web o un modo demo
> del micro. En producción el micro debe rechazarlos con `error: "demo_disabled"`.

```json
{
  "v": 1,
  "id": "e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a50",
  "type": "cmd",
  "ts": "2026-10-12T19:04:20Z",
  "deviceId": "casa-01",
  "payload": { "cmd": "silence_siren" }
}
```

```json
{
  "v": 1,
  "id": "f0e1d2c3-b4a5-4968-8776-655443322110",
  "type": "cmd",
  "ts": "2026-10-12T19:05:00Z",
  "deviceId": "casa-01",
  "payload": { "cmd": "simulate", "sensor": "humo", "active": true }
}
```

```json
{
  "v": 1,
  "id": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  "type": "cmd",
  "ts": "2026-10-12T19:05:30Z",
  "deviceId": "casa-01",
  "payload": { "cmd": "simulate_all" }
}
```

## 6. Respuesta a comandos (`type: "ack"`)

`payload.ack` repite el `id` del comando. La web espera el `ack` hasta 3 s; si no llega, muestra error.

| `error` | Significado |
|---|---|
| `invalid_transition` | El comando no aplica en el modo actual (p. ej. `arm` en `alarma`). |
| `invalid_payload` | Faltan campos o están fuera de rango. |
| `unknown_command` | Comando desconocido. |
| `unknown_sensor` | `simulate` con un sensor que no existe. |
| `demo_disabled` | Comando solo demo en un micro en modo producción. |

```json
{
  "v": 1,
  "id": "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a",
  "type": "ack",
  "ts": "2026-10-12T19:04:20Z",
  "deviceId": "casa-01",
  "payload": { "ack": "e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a50", "ok": true }
}
```

```json
{
  "v": 1,
  "id": "8e7d6c5b-4a39-4281-9f0e-5d4c3b2a1f0e",
  "type": "ack",
  "ts": "2026-10-12T19:06:00Z",
  "deviceId": "casa-01",
  "payload": { "ack": "0f1e2d3c-4b5a-4697-8877-665544332211", "ok": false, "error": "invalid_transition" }
}
```

## 7. Reglas de comportamiento (lo que el micro tiene que respetar)

Especificación ejecutable: `tests/alarm-machine.test.js`.

1. **Humo dispara alarma siempre**, armado o no.
2. Desarmado: aperturas y movimiento solo generan `sensor.changed`.
3. Armado (ya terminado el tiempo de salida): una detección pasa a `intervencion` con `countdown = entry_delay_s`
   y sirena `warning`.
4. Solo el paso a `active: true` es una detección. Volver a reposo no cambia el modo.
5. Durante la intervención, nuevas detecciones no reinician la cuenta.
6. Cuenta en 0 → `alarma` con causa `intrusion` (`by: "timeout"`).
7. Humo durante una intervención: la intrusión pendiente pasa a ser causa → `["intrusion", "smoke"]`.
8. En `alarma` estando armado, una nueva detección suma `intrusion` de inmediato.
9. Una causa nueva vuelve a encender la sirena aunque estuviera `muted`.
10. Silenciar no sale de `alarma`; para salir hay que desarmar.
11. Desarmar con humo presente → `alarma`, `causes: ["smoke"]`, sirena `muted`, luces encendidas.
12. Desarmar no cambia el estado de los sensores (lo informa el hardware).
13. Al armar arranca el tiempo de salida (`exit_countdown = exit_delay_s`, si es mayor a 0). Mientras dura, las
    aperturas y el movimiento solo generan `sensor.changed`; el humo dispara igual. Al llegar a 0 se emite
    `exit_delay.ended`. Desarmar lo corta.

### A confirmar con hardware ⚠️

- **Tiempo de salida**: si el micro lo implementa, con qué valor por defecto (propuesta: 30 s, rango 0–120) y si
  la sirena o el LED avisan durante la salida (propuesta: no; LED azul fijo).
- **Armar con una zona abierta** (p. ej. una ventana abierta): hoy se permite armar, y como solo el paso a
  `active: true` es una detección, esa zona no dispara hasta que se cierre y se vuelva a abrir. La alternativa
  habitual es rechazar `arm` con un error nuevo (`zone_open`) indicando qué sensores están activos.

## 8. Autenticación de la web (webhooks n8n)

Usuario fijo, validado por n8n. En el mock se usan credenciales de prueba de `.env`.

| Método y ruta | Body | Respuesta |
|---|---|---|
| `POST {VITE_N8N_URL}/auth/login` | `{ "email", "password", "remember" }` | `200 { "token", "user": { "email", "name" } }` · `401` si no coincide |
| `POST {VITE_N8N_URL}/auth/recover` | `{ "email" }` | `200` siempre (no revela si el correo existe) |

## 9. Seguridad y permisos del broker

- **La web usa un usuario del broker con permisos limitados**:

  | Tópico | Permiso de la web |
  |---|---|
  | `smarthome/{deviceId}/state` | solo lectura |
  | `smarthome/{deviceId}/event` | solo lectura |
  | `smarthome/{deviceId}/online` | solo lectura |
  | `smarthome/{deviceId}/ack` | solo lectura |
  | `smarthome/{deviceId}/cmd` | **solo escritura** |

  El micro tiene el permiso inverso (escribe `state`/`event`/`online`/`ack`, lee `cmd`) y n8n solo lectura
  (salvo que republique mensajes del micro por HTTP). En Mosquitto se configura con un archivo `acl`; en
  HiveMQ Cloud o EMQX, desde su panel.
- **Las credenciales en `.env` no son seguridad real.** Toda variable `VITE_*` termina dentro del JavaScript
  público y cualquiera que abra la web puede leerla. Sirven para que solo la web conocida se conecte y para
  limitar el daño con las ACL de arriba, no para proteger secretos. Si hiciera falta seguridad real: credenciales
  por usuario emitidas por n8n después del login, o un proxy propio entre la web y el broker.
- Usar siempre `wss://` y `https://` fuera de la máquina local.
- No usar brokers públicos (`test.mosquitto.org`, `broker.hivemq.com`) con datos reales: cualquiera puede leerlos.
