# HANDOFF — estado en vivo (cliente remoto / agente wwebjs)

Contexto para retomar la conversación (incluido control del navegador). Resumen de la
arquitectura: ver `memory/project_remote_agent.md`, `docs/adr/0001-cliente-remoto-extension.md`,
`agent/PRODUCTION.md`, `agent/GO-LIVE.md`.

## Qué se logró (jun-2026)

Se reemplazó el wwebjs headless de Railway (que banean) por un **agente wwebjs en la PC**
que sostiene WhatsApp (IP real) y se conecta al **cerebro en Railway** vía un gateway WSS
(`/agent`). El cerebro (salesFlow/IA/DB/dashboard) no cambió.

- **Gateway** (`src/services/agentBridge.ts`) + **adaptador** (`src/services/remoteClient.ts`)
  + flag `WA_MODE_<SELLER>=remote` en `clientPool.ts`. **Ya mergeado a `main` y deployado.**
- **`agent/`** = el brazo: `node agent.js` corre en la PC, se conecta al gateway, y tiene un
  **panel** inyectado en WhatsApp Web (`agent/sidebar.js`, a la derecha, redimensionable) que
  replica el Asistente IA del dashboard: Pausar/Reactivar, Resumen, Limpiar, pasos del guion
  (insertan texto), Confirmar pedido CON/SIN mensaje, enviar al chat abierto / a un número.
  Los botones llaman a la API de Railway **desde el agente** (Node, sin CORS) con el JWT.

## ESTADO LIVE AHORA

- **Railway**: solo **horacio** activo (`Found 1 active seller(s): horacio`), `WA_MODE_HORACIO=remote`,
  gateway vivo (`[AGENT] Gateway montado en /agent`). ines/pablo desactivados (isActive=false).
- **Agente**: corriendo localmente (`node agent.js` en `agent/`), conectado a Railway como
  horacio (`[REMOTE][horacio] Agente online`). WhatsApp vinculado al número **34621332862**
  (número de PRUEBA — para producción real hay que escanear el número REAL de horacio en la
  PC de horacio, su IP residencial).
- **config.json** (`agent/config.json`, gitignored): tiene `gatewayUrl` (wss Railway), `sellerId`
  horacio, `token` (=WA_AGENT_TOKEN_HORACIO, auth del gateway), y `apiToken` (JWT de horacio,
  recién generado → los botones del panel ya deberían funcionar). **No commitear este archivo.**

## Dos tokens (no confundir)

- `token` = `WA_AGENT_TOKEN_HORACIO` → auth del WebSocket agente↔gateway.
- `apiToken` = JWT de horacio → auth de las llamadas a la API (botones del panel). Generado con
  `npx tsx -r dotenv/config prisma/gen-token.ts horacio` (lo escribe en config.json).

## Cómo correr/reiniciar el agente

```bash
cd agent
node agent.js          # config.json ya está seteado
```
Reusa la sesión de WhatsApp (LocalAuth), no re-pide QR salvo que se haya deslogueado.
El QR (si aparece) sale en ESA ventana de Chrome, no en el dashboard (a propósito).

## Pendiente / a verificar (bueno para control del navegador)

1. **Probar el panel ahora que el apiToken está seteado**: abrir el botón 🤖 → ¿cargan los
   pasos del guion (antes daba "Unauthorized")? ¿Funcionan Pausar/Resumen/Confirmar?
2. **Verificar que las conversaciones aparecen en el chat del dashboard** (el flujo ya las
   loguea vía salesFlow; confirmar end-to-end con un mensaje real).
3. **Producción real**: escanear el número REAL de horacio en la PC de horacio (su IP). Ahora
   está con un número de prueba en la PC del dev.
4. **Multimedia** (comprobantes img/audio): sin probar en el flujo real.
5. Opcional: sacar la **sección del QR** del frontend del dashboard (rebuild) — hoy no muestra
   QR para remoto, pero la UI sigue ahí.

## Errores de consola que NO son nuestros (ignorar)

`dit.whatsapp.net/deidentified_telemetry` (CORS), `storage bucket persistence denied`,
`x-storagemutated-1`, `PerformanceObserver buffered`, `crashlogs.whatsapp.net 400` → todos de
WhatsApp Web.

## Rama / git

Rama `feature/remote-client-bridge` (agent/, extension/, docs/, harness). El gateway + adaptador
+ helmet ya están en `main` (deployado). `extension/` (wa-js y DOM) fueron intentos DESCARTADOS.
