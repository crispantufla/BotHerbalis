# ADR-0001: Cliente remoto vía extensión Chrome (cerebro en Railway, brazo en la PC del vendedor)

**Fecha**: 2026-06-08
**Estado**: Propuesta (Fase 1 implementada en rama `feature/remote-client-bridge`)

## Contexto

Los números nuevos conectados al bot se banean **al instante del handshake**, antes de
enviar mensaje. Descartamos número (SIM real), comportamiento (no llega a enviar) y perfil
(wipe limpio → baneado igual). Lo que queda constante entre todos los bans: **IP de
datacenter/proxy** (Railway + proxy de egress) y el **fingerprint de automatización**
(Chromium headless + protocolo reimplementado de whatsapp-web.js).

Constraint del negocio: queremos seguir manejando todo (panel, flujo, precios, IA) de
forma **remota desde cualquier lado** — no perder el dashboard en Railway.

## Decisión

Separar **cerebro** y **brazo**:

- **Cerebro (Railway, sin cambios)**: dashboard, API, Socket.IO, `salesFlow`, IA, Postgres,
  BullMQ, estado de los N vendedores.
- **Brazo (PC del vendedor)**: una **extensión de Chrome** sobre el WhatsApp Web **real**
  (su IP residencial, su navegador, el cliente oficial de WA). Sostiene la sesión y hace
  solo I/O: captura mensajes entrantes y ejecuta los envíos que decide el cerebro.

El puente es un **WebSocket** que disca desde la PC del vendedor hacia Railway (`/agent`),
namespaceado por `sellerId` + token. Del lado Railway, un **adaptador `RemoteClient`** imita
la superficie de `whatsapp-web.js` (eventos `message`/`ready`/`qr`/…, métodos
`sendMessage`/`getChatById`/…), así que `clientPool` y todo lo de abajo **no cambian**: se
hace `new RemoteClient(sellerId)` en vez de `new Client({...})` detrás del flag
`WA_MODE_<SELLER>=remote`. Ambos modos conviven.

Esto elimina los tres vectores del ban: sin Chromium headless, sin IP de datacenter, sin
handshake de cliente reimplementado (la extensión usa `wa-js` sobre el código oficial de WA).

## Alternativas consideradas

- **Seguir parcheando wwebjs en Railway** (proxy residencial + randomizar deviceName): mitiga
  pero no ataca la raíz; nos siguieron baneando al instante. Descartada como solución durable.
- **App Electron en vez de extensión**: mejor para máquina desatendida 24/7 (auto-arranca,
  sobrevive reinicios, un `.exe`). Se eligió **extensión** por preferencia del usuario y por
  máxima legitimidad de fingerprint (Chrome real del vendedor). El lado Railway es idéntico
  para ambas, así que migrar a Electron después no cuesta.
- **wwebjs no-headless local en la PC del vendedor**: el camino más barato, pero pone TODO
  (dashboard incluido) en la casa del vendedor → se pierde el manejo remoto. Descartada.
- **WhatsApp Business Cloud API**: oficial e imbaneable, pero costo por conversación,
  verificación de negocio, plantillas para outbound y pérdida del "número personal". Queda
  como plan B si la extensión no aguanta.

## Consecuencias

- La PC del vendedor debe estar **prendida con la pestaña de WhatsApp Web abierta**. Si se cae
  su luz/internet, ese vendedor queda offline (inherente a usar su IP). Se monitorea por
  heartbeat desde el gateway.
- Re-escanear QR requiere acceso a esa PC (AnyDesk/RustDesk) — no viajar.
- **Fragilidad ante updates de WA Web**: si cambian los chunks internos, `wa-js` se rompe y hay
  que actualizar el bundle. Misma clase de fragilidad que wwebjs, pero las llamadas están
  centralizadas en `extension/bridge.js`.
- Sigue siendo zona gris de ToS: el ban-instantáneo-al-connect se va, pero un ban **conductual**
  por spamear sigue siendo posible (ya humanizamos delays server-side).
- `wa-js` es un binario de terceros: no se commitea (`extension/wa-js.js` en `.gitignore`), se
  bundlea por PC.

## Archivos

- `src/services/agentBridge.ts` — gateway WSS `/agent` (AgentHub singleton).
- `src/services/remoteClient.ts` — adaptador que imita whatsapp-web.js.
- `src/services/clientPool.ts` — flag `WA_MODE_<SELLER>=remote` + swap del cliente.
- `src/api/server.js` — `agentHub.attach(server)`.
- `extension/` — la extensión (manifest, connector, bridge, opciones).
