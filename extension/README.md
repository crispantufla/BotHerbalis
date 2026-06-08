# Herbalis Agent (extensión Chrome)

El **brazo** del bot: corre en la PC del vendedor, sobre el WhatsApp Web real (su IP,
su navegador), y conecta esa sesión con el **cerebro** en Railway vía un WebSocket al
gateway `/agent`. Toda la lógica de ventas, IA, precios y DB sigue en Railway — esta
extensión solo captura mensajes entrantes y ejecuta los envíos que el cerebro decide.

```
WhatsApp Web (Chrome del vendedor)
  ├─ wa-js.js   → expone window.WPP (API sobre el cliente oficial de WA)
  ├─ bridge.js  → traduce wa-js ⇆ frames del protocolo  (mundo MAIN)
  └─ connector.js → WebSocket a wss://…/agent           (mundo ISOLATED)
        ▲
        │  cmd: send_text / send_media / typing / seen / download / fetch_messages
        ▼
   Railway: agentBridge.ts (gateway) → remoteClient.ts (adaptador) → salesFlow
```

## Instalación (una vez por PC de vendedor)

### 1. Bundlear wa-js

La extensión necesita el bundle `window.WPP` en `extension/wa-js.js`. **No está incluido**
(es un binario de terceros). Descargalo así:

```bash
npm i @wppconnect/wa-js
cp node_modules/@wppconnect/wa-js/dist/wppconnect-wa.js extension/wa-js.js
```

> O bajá `wppconnect-wa.js` de una release de https://github.com/wppconnect-team/wa-js
> y guardalo como `extension/wa-js.js`.

### 2. Cargar la extensión

1. Chrome → `chrome://extensions` → activá **Modo de desarrollador**.
2. **Cargar descomprimida** → elegí la carpeta `extension/`.
3. Click en **Detalles → Opciones de la extensión** y completá:
   - **URL del gateway**: `wss://TU-APP.railway.app/agent`
   - **ID de vendedor**: ej. `horacio` (debe coincidir con el `sellerId` en Railway)
   - **Token**: el valor de `WA_AGENT_TOKEN_HORACIO` configurado en Railway.

### 3. Conectar WhatsApp

Abrí `https://web.whatsapp.com`, escaneá el QR con el celular del vendedor (que está en
la misma casa/wifi). Listo: la consola de la pestaña muestra `[HERBALIS] wa-js listo` y
`WS abierto, auth enviado`. En el dashboard de Railway el vendedor pasa a *conectado*.

## Lado Railway (ya implementado en este repo)

- Activar modo remoto para el vendedor: variable `WA_MODE_HORACIO=remote`.
- Definir el token: `WA_AGENT_TOKEN_HORACIO=<algo-secreto-largo>`.
- En modo remoto el bot **no** lanza Chromium ni usa proxy: la sesión vive en la PC del
  vendedor. El resto (flujo, IA, panel) no cambia.

## Mantenimiento

- La PC del vendedor debe quedar **prendida con la pestaña de WhatsApp Web abierta**.
- Para acceso remoto sin viajar: AnyDesk / RustDesk.
- Si WhatsApp Web se actualiza y rompe `wa-js`, actualizá `wa-js.js` (paso 1) y recargá
  la extensión. Las llamadas a wa-js están centralizadas en `bridge.js`.
