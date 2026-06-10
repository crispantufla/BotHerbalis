# Go-live — conectar un vendedor real

El gateway ya está deployado en Railway (main). Estos son los pasos para poner un vendedor
real (ej. `horacio`) a correr por el agente en su PC, **con el instalador**.

## 1. Variables en Railway (Variables del servicio)

```
WA_MODE_HORACIO=remote
WA_AGENT_TOKEN_HORACIO=<secreto compartido>
```

- `WA_MODE_HORACIO=remote` → Railway deja de lanzar Chromium para horacio y espera al agente.
- `WA_AGENT_TOKEN_HORACIO` → secreto compartido con el agente. Lo usan el gateway WSS **y**
  el endpoint `/agent-dist` (distribución/updates).
- ⚠️ Al guardar, horacio queda **offline** hasta que el agente se conecte. Hacé esto y prendé
  el agente seguido para minimizar la ventana.

## 2. Generar el instalador (en TU PC, con el repo)

1. Verificar que `agent/config.json` tiene los valores del vendedor (URLs de Railway, sellerId,
   token, apiBase).
2. Regenerar el `apiToken` con vida larga (si expira, los botones del panel mueren):
   ```powershell
   $env:JWT_SECRET = '<JWT_SECRET de railway variables>'
   npx tsx -r dotenv/config prisma/gen-token.ts horacio 365d
   ```
3. `node agent/installer/make-installer.js` → deja la carpeta `agent/installer/dist/horacio/`
   con 2 archivos (`Instalar Bot Herbalis.bat` + `install.ps1` con el config embebido).

## 3. En la PC del vendedor

1. Copiar la carpeta `dist/horacio/` (USB, AnyDesk, etc.).
2. Doble click en **"Instalar Bot Herbalis.bat"**. El instalador:
   - instala Node 20 si falta (winget, o MSI de nodejs.org — único paso que pide permisos),
   - descarga el agente desde Railway a `%LOCALAPPDATA%\HerbalisAgent`,
   - corre `npm install`,
   - crea el acceso directo **"Bot Herbalis"** en el Escritorio y en Inicio (auto-arranque),
   - lanza el bot.
3. Se abre Chrome con el QR → escanear con el **WhatsApp del vendedor** (su número, su celu).

## 4. Verificar

- Agente: `✅ WhatsApp listo. Número: …`
- Railway (`railway logs`): `[AGENT][horacio] Agente conectado` + `[REMOTE][horacio] Agente online`.
- Mandar un WhatsApp de prueba al número de horacio → el bot responde (con su IP residencial).
- Panel (botón 🤖): los pasos del guion cargan, y los botones (pausar/resumen/confirmar) operan.

## 5. Actualizar el agente a distancia (ej. cambios en sidebar.js)

1. Commit + push a `main` → Railway redeploya (el manifest de `/agent-dist` cambia solo).
2. Esperar a que el agente reconecte al gateway nuevo (logs: `Agente conectado`).
3. Empujar el update (elegí un momento tranquilo — el reinicio deja ~1 min sin recibir):
   ```
   POST https://mainherbalisbot-production.up.railway.app/api/agent/update?sellerId=horacio
   Authorization: Bearer <JWT de admin>
   ```
   El agente baja los archivos nuevos, sale con código 99 y `run.bat` lo relanza. La sesión
   de WhatsApp persiste — **no hay que re-escanear el QR**.
4. Vía pasiva: aunque no empujes nada, el agente chequea updates en **cada arranque**
   (reinicio de la PC, crash, watchdog de frame zombie).

## Notas

- El agente tiene un **watchdog**: si el frame de WhatsApp queda zombie (PC suspendida +
  recarga de WA Web), se reinicia solo vía `run.bat`.
- Si `npm install` falla durante un update de deps, el agente sigue con los node_modules
  viejos y reintenta en cada arranque.
- Rotar `WA_AGENT_TOKEN_<SELLER>` en Railway invalida el `config.json` de la PC del vendedor:
  hay que regenerar el instalador (o editar el config a mano vía AnyDesk).
- Los vendedores sin `WA_MODE_*` siguen en wwebjs en Railway. Migrás de a uno.
- Pendientes a verificar en el primer vendedor real: multimedia (comprobantes), y que pedidos/
  alertas usen el teléfono correcto (Railway resuelve @lid).
