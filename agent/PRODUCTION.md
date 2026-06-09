# Plan a producción — agente wwebjs

Objetivo: reemplazar el wwebjs headless en Railway (que banean) por el **agente en la PC
del vendedor** (su IP residencial, navegador real), conectado al cerebro real en Railway.

Lo que YA funciona (probado): el agente recibe y envía, resuelve el teléfono real del
`@lid`, y tiene una botonera para enviar manualmente. Falta llevarlo al flujo real.

---

## Fase A — Cerebro en Railway (gateway vivo)

Hoy Railway corre `main`, que **no tiene** el gateway (agentBridge/remoteClient). Hay que
subirlo, sin romper a los 3 vendedores actuales (es opt-in por flag).

1. **Mergear `feature/remote-client-bridge` → `main`** (trae gateway + adaptador + flag
   `WA_MODE`). Sin `WA_MODE_<SELLER>`, cada vendedor sigue en wwebjs como hoy.
2. **Limpiar el server**: revertir el cambio de helmet del iframe (lo abandonamos) para
   restaurar `X-Frame-Options`. Quitar `dashboardUrl` del agente (sin uso).
3. **Verificar** en logs: `[AGENT] Gateway montado en /agent`.

## Fase B — Resolución `@lid` → teléfono (CRÍTICO)

El salesFlow se identifica por **teléfono** (pedidos, alertas al admin, estado, precios).
WhatsApp manda `@lid` para contactos guardados; el agente ya **sabe** resolverlo
(`contact.id._serialized` = teléfono real), pero hoy solo lo loguea.

- **Tarea**: que el agente ponga `from = teléfono@c.us` en los `incoming` (no el `@lid`).
- **Verificar el envío de vuelta**: que `client.sendMessage(telefono@c.us, …)` llegue al
  chat correcto aunque el chat sea `@lid`. (Probar; si no rutea, mapear `@lid`↔teléfono.)
- Sin esto, el estado/pedidos no matchean → es lo #1 a cerrar antes de clientes reales.

## Fase C — Multimedia (comprobantes son core)

El flujo depende de **imágenes de comprobante** y **notas de voz**. El agente ya tiene el
código (`send_media`, `download`) pero **sin probar**.

- **Probar**: recibir imagen de comprobante (download), recibir audio, enviar imagen/audio.
- Ajustar lo que falle contra el flujo real.

## Fase D — Robustez

- ✅ Reconexión WS + reconexión wwebjs + blindaje anti-crash (hecho).
- **Heartbeat → dashboard**: que el panel muestre el agente online/offline (ya hay hb;
  falta reflejarlo en la UI del dashboard).
- **Auto-arranque** en la PC del vendedor (Task Scheduler / acceso directo en Inicio).
- **Re-escaneo de QR** sin viajar: AnyDesk / RustDesk.

## Fase E — Piloto con UN vendedor

1. Elegir un vendedor (uno de bajo volumen, o un número de prueba dado de alta como
   vendedor real en la DB con knowledge/pricing).
2. En Railway: `WA_MODE_<SELLER>=remote` + `WA_AGENT_TOKEN_<SELLER>=<secreto>`.
3. En su PC: instalar Node + el agente, `config.json` con `wss://…railway.app/agent` +
   sellerId + token, `npm start`, escanear QR con SU número (su IP, su celu en la wifi).
4. **Correr una venta real completa** por el salesFlow: saludo → … → pedido → validación
   admin → completado. Verificar: estado, pedido creado, alertas al admin, multimedia, pausas.

## Fase F — Rollout

- Migrar los vendedores restantes uno por uno (agente en su PC + `WA_MODE` en Railway +
  escanear QR). El `WA_MODE` apaga el wwebjs headless de Railway para ese vendedor.

---

## Riesgos abiertos a cerrar antes de producción

1. **`@lid`→teléfono en ambos sentidos** (Fase B) — el más importante.
2. **Multimedia** round-trip (Fase C).
3. **Dedup bot vs. manual** — verificar que los `outgoing` del propio bot no se lean como
   intervención manual (el ack devuelve el msgId real → `botSentMessageIds`; ya alineado,
   pero confirmar en el flujo real).
4. **Límite de dispositivos vinculados** — el celu del vendedor + la sesión del agente
   (WhatsApp permite ~4; ok, pero tenerlo en cuenta).

## Reparto (quién hace qué)

- **Yo (código)**: Fase B (resolución), Fase C (ajustes de multimedia), limpieza (helmet,
  dashboardUrl), heartbeat→dashboard.
- **Vos (infra)**: mergear/deploy a Railway, setear envs, instalar el agente en la PC del
  vendedor, escanear QR, auto-arranque.

## Orden sugerido

B (resolución) → C (multimedia) → A (deploy a Railway) → E (piloto 1 vendedor) → F (rollout).
Hacemos B y C contra el harness/agente local; A y E ya tocan Railway y un vendedor real.
