# Plan: extensión por DOM (sin wa-js)

wa-js quedó descartado: no encuentra los módulos internos de la WhatsApp Web actual
(issue #3419, `MsgStore`/`ChatStore` not found). En vez de engancharnos a las tripas
internas, **leemos y manipulamos el HTML que WhatsApp ya pinta en pantalla**, como lo
haría un humano. No depende de versiones internas de WhatsApp.

## Qué se reusa (no se toca)

- ✅ `agentBridge.ts` — gateway WSS en Railway.
- ✅ `remoteClient.ts` — adaptador que imita whatsapp-web.js.
- ✅ `connector.js` — WebSocket + config (chrome.storage).
- ✅ El protocolo de frames (`incoming` / `send_text` / `seen` / etc.).

## Qué cambia

- ❌ Se elimina `wa-js.js` y el script `bridge.js` (mundo MAIN).
- ✅ Toda la lógica pasa a **un solo content script en el mundo ISOLATED**
  (`dom.js`), que tiene acceso al DOM, a `chrome.storage` y puede abrir el WebSocket.
  Más simple: sin `wa-js`, sin mundo MAIN, sin puente `postMessage`.

```
WhatsApp Web (Chrome del vendedor)
  └─ dom.js (ISOLATED): lee/escribe el DOM + WebSocket a Railway
        ▲ incoming (mensaje leído del DOM)
        ▼ send_text (escribe en el chat y clickea enviar)
   Railway: agentBridge → remoteClient → salesFlow   (sin cambios)
```

## Anclas estables del DOM (no usar clases ofuscadas)

WhatsApp ofusca las clases CSS (`_ak8q`), pero hay anclas semánticas estables:

| Ancla | Para qué |
|---|---|
| `#pane-side` | contenedor de la lista de chats (id estable) |
| `#main` | conversación abierta (id estable) |
| `div[data-id]` | cada mensaje. `data-id` = `<fromMe>_<chatId>@c.us_<hash>` → da **msgId, chatId y fromMe** de una |
| `[data-pre-plain-text]` | atributo con `[HH:MM, D/M/YYYY] Nombre:` → timestamp + remitente |
| `.message-in` / `.message-out` | burbuja entrante / saliente |
| `span.selectable-text` | texto del mensaje |
| `footer [contenteditable="true"]` | caja para escribir |
| `[data-icon="send"]` | botón enviar (los `data-icon` son estables) |

Los selectores exactos se fijan en la Fase 1 inspeccionando el DOM en vivo (con la
página abierta). Se centralizan en un objeto `SEL = {...}` para que un cambio de
WhatsApp sea un solo lugar a tocar.

## Recepción de mensajes (lo central)

Un bot de ventas recibe de muchos chats distintos, y WhatsApp solo muestra uno abierto
a la vez. Estrategia:

1. `MutationObserver` sobre `#pane-side` (lista de chats).
2. Detectar un chat que pasa a **no leído** (sube arriba + badge de conteo).
3. Click en ese chat → esperar que `#main` cargue la conversación.
4. Leer los mensajes entrantes nuevos: `#main div[data-id^="false_"]` con su
   `[data-pre-plain-text]` y `span.selectable-text`.
5. **Dedupe por `data-id`** (set persistido en `chrome.storage`) → no reenviar lo ya visto.
6. Abrir el chat ya lo marca como leído.
7. Enviar frame `incoming` a Railway por el WebSocket.
8. Cola interna para procesar varios chats no leídos de a uno (sin pisarse).

## Envío de mensajes

Comando `send_text {chatId, text}` desde Railway:

1. Abrir el chat: enfocar el buscador de `#pane-side`, escribir el número, click en el
   primer resultado. (O reusar el chat si ya está abierto.)
2. Enfocar `footer [contenteditable="true"]`.
3. Insertar el texto con `document.execCommand('insertText', false, text)` o un evento
   `paste` sintético (el editor de WhatsApp ignora `innerText` directo).
4. Click en `[data-icon="send"]` (o `Enter`).
5. Responder `ack` con el `data-id` del mensaje recién enviado (para `botSentMessageIds`).

## Fases

| Fase | Entrega | Riesgo |
|---|---|---|
| **1. Recepción** | Observa no-leídos, abre, extrae texto, dedup, manda `incoming` a Railway. Probar: mandar WhatsApp → ver el mensaje en logs de Railway. | medio |
| **2. Envío** | `send_text` → abre chat, escribe, envía. Probar: el bot responde en WhatsApp. | medio |
| **3. Multimedia** | recibir imágenes/audio (descarga del DOM o blob) + enviar imágenes/audio. | alto |
| **4. Hardening** | cola de chats concurrentes, reconexión, dedup persistente, `typing`/`seen`, resiliencia de selectores. | — |

## Riesgos y mitigaciones

- **WhatsApp cambia el DOM** → selectores centralizados en `SEL`; usamos anclas
  semánticas (`data-id`, `data-icon`, ids `#main`/`#pane-side`) que cambian poco.
- **Localización** (texto de "no leído" varía por idioma) → no dependemos de texto:
  usamos estructura/atributos.
- **Carrera al abrir chats** → cola serial, un chat por vez, con esperas por `#main`.
- **Editor contenteditable** → `execCommand insertText` / evento `paste`, no `innerText`.
- **Intermitencia** → al ser DOM puro (no inyección de webpack), NO rompe la carga de
  WhatsApp como wa-js. Es la gran ventaja sobre lo anterior.

## Primer paso

Fase 1: reescribir el content script como `dom.js` (ISOLATED), sacar wa-js/bridge del
manifest, e implementar recepción. Pinear selectores contra el DOM en vivo.
