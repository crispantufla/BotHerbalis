# Herbalis Agent (whatsapp-web.js)

El **brazo** del bot: corre en la PC del vendedor, sostiene la sesión de WhatsApp con
whatsapp-web.js (Chromium real, IP del vendedor) y la conecta al **cerebro en Railway**
vía el gateway `/agent`. Toda la lógica (ventas, IA, precios, DB) vive en Railway.

A diferencia de la extensión, esto **tiene el número de teléfono** del cliente (estado
interno de wwebjs, no DOM) y funciona contra la WhatsApp Web actual.

## Probar localmente (sin tocar producción)

Necesitás un número de WhatsApp de prueba.

1. **Levantá el harness de eco** (en la raíz del repo, otra terminal):
   ```bash
   npx tsx extension/test-gateway.ts
   ```
   Queda escuchando en `ws://localhost:3100/agent` (sellerId `domtest`, token `test-token-123`).

2. **Configurá el agente**: copiá `config.example.json` a `config.json` (ya viene apuntando
   al harness local).

3. **Instalá y corré**:
   ```bash
   cd agent
   npm install
   npm start
   ```
   Se abre una ventana de Chrome con el QR (también sale en la terminal). Escaneá con el
   número de prueba.

4. **Probá**: desde otro teléfono mandá un mensaje al número de prueba.
   - Terminal del harness: `◀ ENTRANTE …` → `▶ respondido`.
   - WhatsApp: llega el eco `🤖 eco: …`.

Eso valida recepción + envío + el teléfono real, aislado de producción.

## Producción (en la PC del vendedor)

1. Instalar Node 20+.
2. Copiar la carpeta `agent/`, `npm install`.
3. `config.json`:
   ```json
   {
     "gatewayUrl": "wss://TU-APP.railway.app/agent",
     "sellerId": "horacio",
     "token": "<WA_AGENT_TOKEN_HORACIO de Railway>"
   }
   ```
   (En Railway: `WA_MODE_HORACIO=remote` + `WA_AGENT_TOKEN_HORACIO=<secreto>`.)
4. `npm start` → escanear el QR con el celu del vendedor (en la misma wifi).
5. **Auto-arranque al bootear**: acceso directo a `npm start` en la carpeta de Inicio, o
   Task Scheduler. Para re-escanear QR sin viajar: AnyDesk / RustDesk.

## Config

Por `config.json` o variables de entorno: `GATEWAY_URL`, `SELLER_ID`, `AGENT_TOKEN`.

## Estado (Fase 1)

Implementado: conexión al gateway, recepción (`incoming`), envío (`send_text`/`send_media`),
`typing`/`seen`, `download`, `fetch_messages`, QR/ready, reconexión del WebSocket.
Pendiente (Fase 3): auto-reconexión robusta de wwebjs, auto-arranque, monitoreo.
