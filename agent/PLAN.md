# Plan: agente wwebjs en la PC del vendedor

El "brazo" del bot, pero con **whatsapp-web.js** (la librería que el bot ya usa y que
funciona contra la WhatsApp Web de hoy) corriendo en la **PC del vendedor**. Resuelve
las dos paredes de la extensión: tiene el **número de teléfono** (estado interno, no DOM)
y **lee/envía** sin depender de wa-js.

Es, en esencia, **tu bot actual con el Chromium mudado de Railway a la casa del vendedor**:
su IP residencial real (objetivo anti-ban), su navegador real. El cerebro sigue en Railway.

## Arquitectura

```
PC del vendedor (su IP, su Chrome)
  └─ agent.js  ──── whatsapp-web.js (Chromium real, LocalAuth) ── WhatsApp
        │
        │  WebSocket (mismo protocolo que remoteClient.ts)
        ▼
   Railway: agentBridge (gateway) → remoteClient → salesFlow   ← SIN CAMBIOS
```

El agente disca hacia afuera (PC → gateway), igual que la extensión. Cero puertos en la
casa del vendedor.

## Qué se reusa (todo)

- ✅ `agentBridge.ts` — gateway WSS `/agent`.
- ✅ `remoteClient.ts` — adaptador. **El agente habla el mismo protocolo de frames.**
- ✅ `test-gateway.ts` — el harness de eco sirve para probar el agente local, aislado.
- ✅ salesFlow, IA, DB, pricing — Railway intacto.

## El agente (qué hace)

Un proceso Node chico. Reusa la config de wwebjs que ya está en `clientPool.ts`
(LocalAuth, stealth, args de Chromium), pero **headful** (ventana visible) para que el
vendedor escanee el QR y vea que anda.

**Eventos wwebjs → frames al gateway:**

| wwebjs | frame |
|---|---|
| `qr` | `{t:'qr', data}` |
| `ready` | `{t:'ready', phone}` |
| `message` (entrante) | `{t:'incoming', msg}` |
| `message_create` (saliente/manual) | `{t:'outgoing', msg}` |
| `disconnected` / `change_state` | `{t:'state', ...}` |

**Comandos del gateway → acciones wwebjs (+ ack):**

| frame | acción |
|---|---|
| `send_text` | `client.sendMessage(chatId, text)` |
| `send_media` | `new MessageMedia(...)` + `sendMessage` |
| `typing` / `seen` | `chat.sendStateTyping()` / `sendSeen()` |
| `download` | `getMessageById(id).downloadMedia()` |
| `fetch_messages` | `getChatById(id).fetchMessages({limit})` |

El `msg` serializa lo que `remoteClient._wrapMessage` espera: `id._serialized, from,
body, type, hasMedia, timestamp, author, fromMe` — y `from` ya es el `chatId` real
(`549...@c.us`). **Ahí está el teléfono que el DOM no daba.**

Los delays humanizados (4-8s) siguen en Railway: el `send_text` sale recién después.

## Estructura de archivos

```
agent/
  package.json      # whatsapp-web.js + ws + qrcode-terminal
  agent.js          # el agente (eventos + comandos + WS + reconexión)
  config.example.json
  README.md         # instalación en la PC del vendedor
```

Config (gatewayUrl, sellerId, token) por `config.json` o variables de entorno.

## Fases

| Fase | Entrega | Cómo se prueba |
|---|---|---|
| **1. Core** | conectar, recibir (`incoming`), `send_text`, QR/ready, reconexión WS | contra `test-gateway.ts` (eco) con un número de prueba → ves el ENTRANTE y el eco se manda solo |
| **2. Multimedia + resto** | `download`, `send_media`, `typing`, `seen`, `fetch_messages` | mandar imagen/audio, comprobantes |
| **3. Hardening** | reconexión wwebjs, auto-arranque al bootear, heartbeat/monitoreo en dashboard | reinicios, caídas de red |

## Cómo se prueba (sin tocar producción)

Mismo esquema que ya montamos: `npx tsx extension/test-gateway.ts` (eco, sin DB/Redis)
→ el agente apunta a `ws://localhost:3100/agent` → escaneás con un número de prueba →
el eco confirma recepción + envío. Cuando funciona, se apunta a Railway con un seller real.

## Instalación en la PC del vendedor (resumen)

1. Instalar Node 20+.
2. Copiar la carpeta `agent/`, `npm install`.
3. Completar `config.json` (URL del gateway de Railway, sellerId, token).
4. `npm start` → se abre Chrome, el vendedor escanea el QR una vez (su celu en la misma wifi).
5. Auto-arranque al bootear (Task Scheduler / acceso directo en Inicio). Acceso remoto
   para re-escanear QR sin viajar: AnyDesk / RustDesk.

## Riesgos

- **wwebjs también se rompe si WhatsApp actualiza** — pero está mantenida y **funciona hoy**
  (tu bot lo prueba). Se actualiza el paquete cuando haga falta.
- **La PC debe estar prendida con el agente corriendo.** Si se cae luz/internet, ese
  vendedor queda offline (inherente a usar su IP). Monitoreo por heartbeat.
- **Ban conductual** sigue posible si se spamea — ya humanizamos delays (server-side). El
  ban-instantáneo-al-handshake se va (IP residencial + navegador real + número con sesión).
```
