# Go-live — conectar un vendedor real

El gateway ya está deployado en Railway (main). Estos son los pasos de **infra** para poner
un vendedor real (ej. `horacio`) a correr por el agente en su PC.

## 1. Variables en Railway (Variables del servicio)

```
WA_MODE_HORACIO=remote
WA_AGENT_TOKEN_HORACIO=6372abcc16bf1671ce34eb8f1ec661cb3ee7579d19a522db
```

- `WA_MODE_HORACIO=remote` → Railway deja de lanzar Chromium para horacio y espera al agente.
- `WA_AGENT_TOKEN_HORACIO` → secreto compartido con el agente (token generado; podés cambiarlo).
- ⚠️ Al guardar, horacio queda **offline** hasta que el agente se conecte. Hacé esto y prendé
  el agente seguido para minimizar la ventana.

## 2. En la PC del vendedor

1. Instalar **Node 20+**.
2. Copiar la carpeta `agent/`, y dentro: `npm install`.
3. Crear `agent/config.json`:
   ```json
   {
     "gatewayUrl": "wss://mainherbalisbot-production.up.railway.app/agent",
     "sellerId": "horacio",
     "token": "6372abcc16bf1671ce34eb8f1ec661cb3ee7579d19a522db",
     "apiBase": "https://mainherbalisbot-production.up.railway.app",
     "apiToken": "<JWT de horacio>"
   }
   ```
   - **`apiToken`** (para los botones del panel: pausar, resumen, guion, confirmar): se saca del
     dashboard logueado como horacio → F12 → Application → Local Storage → copiar la clave `token`.
4. `npm start` → se abre Chrome con el QR. Escanear con el **WhatsApp de horacio** (su número,
   su celu en la misma wifi de la PC).

## 3. Verificar

- Agente: `✅ WhatsApp listo. Número: …`
- Railway (`railway logs`): `[AGENT][horacio] Agente conectado` + `[REMOTE][horacio] Agente online`.
- Mandar un WhatsApp de prueba al número de horacio → el bot responde (con su IP residencial).
- Panel (botón 🤖): los pasos del guion cargan, y los botones (pausar/resumen/confirmar) operan.

## 4. Auto-arranque (que sobreviva reinicios)

- Windows: acceso directo a `npm start` (o un `.bat` con `node agent.js`) en la carpeta de Inicio,
  o Task Scheduler al iniciar sesión.
- Acceso remoto para re-escanear QR sin viajar: **AnyDesk / RustDesk**.

## Notas

- El agente ya está corriendo localmente contra el eco de prueba (`domtest`). Para el vendedor
  real es OTRO `config.json` (el de arriba), idealmente en la PC del vendedor.
- Los 3 vendedores actuales siguen en wwebjs en Railway mientras no tengan `WA_MODE_*`. Migrás
  de a uno.
- Pendientes a verificar en el primer vendedor real: multimedia (comprobantes), y que pedidos/
  alertas usen el teléfono correcto (Railway resuelve @lid).
