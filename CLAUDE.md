# CLAUDE.md

Guía para trabajar en este repo. No repetir aquí cosas ya documentadas en código; solo lo no obvio.

## Qué es

Bot de WhatsApp multi-tenant para ventas. Un único proceso Node corre N vendedores (sellers), cada uno con su propio `whatsapp-web.js` Client + Puppeteer Stealth, estado aislado, y BullMQ queue namespaceada. Backend Express + Socket.IO sirve una SPA React (`client/`) que actúa como dashboard para admins y vendedores.

## Stack

- **Runtime**: Node 20+, TypeScript via `tsx` (sin build step en dev). `type: commonjs` en package.json — mezcla `require()` y `import` (tech debt conocido).
- **WhatsApp**: `whatsapp-web.js` + `puppeteer-extra` con stealth plugin inyectado en `index.ts` sobreescribiendo `require.cache` de puppeteer.
  El agente remoto (`agent/package.json`) lleva `whatsapp-web.js` fijado a un COMMIT de `main`
  (tarball de codeload, sin git en la PC del vendedor): la release 1.34.7 (abr-2026) no tiene los
  arreglos para el WhatsApp Web de julio de 2026 (`id._serialized` → `id.$1`, descarga de media por
  el cache de WA), y sin ellos `downloadMedia` y `fetchMessages` tiran `r` para todo (audios mudos
  desde el 2026-07). Si sale una release ≥1.34.8 volver al semver; si vuelve el `r`, mover el commit.
- **DB**: PostgreSQL via Prisma 7. Todas las tablas están particionadas por `instanceId` (= `sellerId`).
- **Queue**: BullMQ sobre Redis. Una queue por seller: `whatsapp-messages-${sellerId}`.
- **Locks**: Redlock sobre Redis, compartido entre sellers. Lock keys incluyen `sellerId`.
- **AI**: Claude (Sonnet/Haiku) conversa en prod. OpenAI queda para los embeddings del cache semántico, la transcripción de audios y el path GPT de `ai.ts`. Circuit breaker con cooldown de 30s tras 3 fallos consecutivos (ver `src/services/ai.ts`).
- **Frontend**: React + Vite en `client/`. Servido estático por Express desde `client/dist/`.

## Arquitectura

```
index.ts                    # Boot: Redlock + clientPool + Express
  └─ clientPool             # Mapa sellerId → SellerInstance
       ├─ Client (wwebjs)   # LocalAuth clientId=sellerId, datos en DATA_DIR/<sellerId>/
       ├─ sharedState       # userState, pausedUsers, config, io — aislado por seller
       ├─ stateManager      # load/save state hacia Postgres (debounced)
       ├─ queue + worker    # BullMQ namespaceada
       ├─ helpers           # logAndEmit, saveOrderToLocal, sendMessageWithDelay, notifyAdmin, cancelLatestOrder
       └─ messageHandler    # debounce + rutea a salesFlow
```

Módulos que se separaron en la limpieza de septiembre de 2026 para sacar funciones gigantes de encima:

- `src/flows/leadClassifier.ts` — qué hacer con un teléfono del que no hay estado (los
  dos checks contra Orders y contra el historial de chat). Salió de `processSalesFlow`,
  que tenía ese bloque inline con anidamiento 10. También exporta `createInitialUserState`,
  la única fábrica del estado inicial (antes copiada a mano en `playground.routes.js`).
- `src/services/adminCommands.ts` — los comandos `!` de WhatsApp, como registro
  (`BANG_COMMANDS`) en vez del if-chain de 659 líneas que era. Agregar un comando =
  agregar una entrada. `adminService.ts` NO lo re-exporta a propósito (sería un ciclo):
  los consumidores requieren `./adminCommands` directo.
- `src/services/aiPrompts.ts` — todo el texto de los prompts y su ensamblado: el system
  (`_buildSystemBlocks`, `_buildSystemPrompt`) y el turno user de `chat()`
  (`_buildKnowledgeContext`, `_buildStateContext`, `_buildChatUserPrompts`). `ai.ts` se
  quedó con el runtime del servicio. Cambiar algo acá mueve el prefijo del prompt cache:
  verificar con `scripts/ai-cache-probe.ts`. Los payloads exactos que `chat()` le manda a
  Claude y a OpenAI están fijados en `tests/ai_chat_payloads.test.js`.
- `src/handlers/incomingSteps.ts` — los pasos con nombre del handler de entrada (descartar
  lo que no es charla, dedup, admin, audio/imagen/documento, pausa, debounce).
  `messageHandler.ts` quedó como orquestador de 8 pasos numerados. Cubierto por
  `tests/message_handler.test.js`.
- Dashboard: `CommsView` delega en `client/src/components/corporate/comms/` (armado de los
  textos del guion en `scriptTemplates.js`, búsqueda, encabezado, modales), `GuionView` en
  `guion/` y los interruptores de `SettingsView` en `settings/`.

Flujo de un mensaje: `client.on('message')` → `messageHandler` (debounce ~N segundos para agrupar mensajes consecutivos) → encola en BullMQ → worker pulls → `processSalesFlow` → step correspondiente en `src/flows/steps/` → `sendMessageWithDelay` (4-8s delay humanizado).

## Flujo de venta (`src/flows/steps/`)

Máquina de estados lineal con fallbacks a IA. Orden típico:

`greeting → waiting_weight → waiting_preference → waiting_plan_choice → waiting_ok → waiting_data → waiting_maps_confirmation → waiting_payment_method → [waiting_mp_payment] → waiting_price_confirmation → waiting_final_confirmation → waiting_admin_validation → completed`

- **Guion por zona (V8) revertido el 2026-09-28**: del 15 al 28-sep el menú de pago preguntaba la
  localidad (`waiting_zone`, reparto propio en Rosario). Se volvió al menú retiro/domicilio. Los
  estados que quedaron a mitad (`waiting_zone`, o `shippingChoice='reparto'` en datos) vuelven a
  `waiting_payment_method` en `processStep` (`src/flows/steps/index.ts`). El código V8 está en
  los commits `31cfd17` y `85b1f98`; los arreglos de `85b1f98` que no eran de la zona se
  trajeron de vuelta (`tests/sep17_fixes_v7.test.js`).
- `processGlobals` corre antes de cada step — maneja cancelaciones, seguimiento, cliente recurrente, etc.
- Cada step devuelve `{ matched: boolean }`. Si no matchea, cae a IA vía `dependencies.aiService.chat()` con un `goal` específico al step.
- El AI devuelve `{ goalMet, response, extractedData }`. `extractedData` es un string con tags tipo `POSTDATADO: 2026-05-20` que el step parsea con regex.

## Convenciones no obvias

- **`_cleanPhone(userId)`** en `flowHelpers.ts` es la forma canónica de extraer teléfono. Usar siempre en vez de `userId.split('@')[0]` manual.
- **Chats `@lid`**: en prod todos los chats de clientes llegan como `<lid>@lid` (medido ago–sep 2026), en el `from` del entrante y en el `to` de lo que el vendedor escribe a mano (`message_create`). Todo lo que se guarda por chat (userState, pausa, ChatLog) va bajo el teléfono: resolver con `resolveUserIdFrom` de `incomingSteps.ts` (getContact + resolución pegajosa en Redis), nunca filtrar por `@c.us`. Hasta el 2026-09-17 el handler de salientes lo hacía y nada de lo que Horacio contestaba a mano quedaba en ChatLog ni pausaba el chat (`tests/manual_chat.test.js`).
- **Eco de lo que manda el bot**: todo envío vuelve como `message_create` propio, igual que lo que el vendedor escribe a mano. Se distinguen con `trackBotSends` (`messageHandler.ts`), nunca con una espera fija: en remoto el eco llega ANTES que el ack. El primer deploy del arreglo de `@lid` esperaba 100 ms y se revirtió a los 5 minutos porque el saludo del bot pausó el chat. Y el id tampoco alcanza: medido en prod el 17-sep, 20 de 20 ecos se reconocieron por CONTENIDO y ninguno por id, porque al mandar a `<telefono>@c.us` un chat que WhatsApp guarda bajo `@lid` el `sendMessage` de wwebjs devuelve `undefined` y el ack va sin id (por eso `agent.js` lo saca del `message_create` del propio envío, `_sentMsgId`). Al tocar esto, mirar las líneas `[MANUAL-CHAT]` de prod: si dicen "Eco de un envío del bot", el camino del id sigue muerto.
- **`_setStep(state, FlowStep.X)`** — NO asignar `state.step` directamente. Esto resetea flags (`staleAlerted`, `reengagementSent`, etc.) y loguea transición al funnel.
- **NO anotar mensajes del bot en el history a mano.** `sendMessageWithDelay` lo hace solo, cuando el mensaje REALMENTE salió. El flujo solo envía:
  ```ts
  await sendMessageWithDelay(userId, msg);   // el history se anota adentro
  ```
  El motivo: `sendMessageWithDelay` devuelve `false` sin enviar en cinco caminos (guard anti venta-fantasma, anti-duplicado, pausa durante el delay de 4-8s, `stillValid`, excepción del cliente). Mientras el push lo hacía cada call site, cualquiera de esos cinco dejaba en el historial un mensaje que el cliente nunca recibió, y la IA arrancaba el turno siguiente creyendo que ya lo había dicho — de 143 call sites solo 6 miraban el booleano. Es el mismo criterio por el que `logAndEmit` ya se había movido adentro (ver [[dashboard-message-ordering]]). Cubierto por `tests/phantom_history.test.js`.
  **Sí** se llama `_pushHistory(state, { role, content })` a mano en los caminos que envían por `client.sendMessage` directo (panel, comandos del admin) y para los marcadores que no son texto enviado (`[Imagen adjunta: X]`). Nunca `state.history.push({...})` crudo: el helper inicializa `history` si falta y aplica el cap (250 → deja los 150 más recientes), que antes solo corría en `salesFlow` y dejaba crecer sin techo todo lo que no re-entra al flujo. Cubierto por `tests/push_history.test.js`.
- **`_pauseAndAlert(...)`** — cuando el bot no sabe qué hacer, pausa al user y notifica al admin. No intentar "auto-recovery" silenciosos.
- **Guion guardado vs guion del repo**: `stateManager.loadKnowledge` prefiere la copia de
  `DATA_DIR/knowledge_v7_<seller>.json` si existe; si `meta.version` del repo es más nueva que la
  de la copia, gana el repo y la copia queda como `.bak`. Al cambiar el guion, subir
  `meta.version`, o prod sigue con el viejo (por eso el V7 restaurado lleva 8.2 o más: la copia de prod
  podía ser 8.x). La versión y una huella de `prices.json` son parte del namespace del cache
  semántico (`_cacheContentTag` en `ai.ts`).
- **Pausas NO se auto-liberan**. Un user pausado con `pauseReason` requiere intervención manual del admin. Si un outage (ej: OpenAI 429) pausa users, hay que despausarlos a mano. Única excepción: al arrancar, `restorePausedUsersFromDB` borra las pausas de más de 7 días (`STALE_PAUSE_DAYS` en `pauseService.ts`).
- **Pricing**: siempre leer con `_getPrice/_getPrices/_getAdicionalMAX` de `pricing.ts`. NUNCA inventar precios en código ni en prompts de IA. Tampoco umbrales derivados de precios: para deducir el plan (60/120) de un monto usar `_inferPlanFromPrice`, y para el nombre canónico del producto `_normalizeProductName` (ambos en `pricing.ts`). Hasta el 2026-09-09 esa lógica estaba duplicada con umbrales hardcodeados en `botHelpers.ts` y `order.routes.js` (ver `stepWaitingFinalConfirmation.ts` para el patrón: se inyecta `pricingContext` en el prompt). El respaldo si falta `data/prices.json` es `FALLBACK_PRICES` (también en `pricing.ts`) y tiene que igualar al JSON. `GET /prices`, los flujos y los prompts leen por la misma función, así que un cambio en el Editor de Precios se ve en la lectura siguiente (cubierto por `tests/prices_single_source.test.js`). En el panel, los textos del guion con precios pasan por `fillPricePlaceholders` (`client/src/utils/scriptPlaceholders.js`) con lo que devuelve `/api/prices`: sin precios cargados, el placeholder queda visible.
- **Interruptor de Mercado Pago**: `config.mpEnabled` (switch "Pago con tarjeta" en Configuración, default ON). En OFF el bot no ofrece ni genera links: domicilio ⇒ transferencia directa, y quien pida tarjeta recibe un aviso de "fuera de servicio". Leerlo SIEMPRE con `isMpEnabled(dependencies.config)` de `flows/utils/paymentOptions.ts`. Si agregás copy que nombre la tarjeta: en código usá `prepayMeans/prepayMenu`; en `knowledge_v7.json` agregá una variante `responseNoMp` (la eligen `getFlowTemplate(key, knowledge, mpOff)` y `globalFaq`). Los prompts de IA lo reciben vía `context.mpEnabled`, que inyecta el proxy de `salesFlow` — no hace falta pasarlo por call site.
- **Adicional contrarembolso**: solo aplica a plan 60 + pagos en efectivo/contrarembolso. MP/transferencia lo exime. Recalcular tras cambios de plan/producto (no confiar en `isContraReembolsoMAX` previo).
- **DB upserts bajo race**: código P2002 de Prisma = concurrent upsert race. Ignorar (ver `botHelpers.ts:65`).
- **Locks**: `order_lock:${phone}:${sellerId}` TTL 3000ms. Queries internas al lock deben tener timeout < TTL (ver `cancelLatestOrder` con 2500ms).
- **Socket.IO rooms**: emitir siempre a `sellerId` room y a `admin` room (admins ven todo). Payload del admin debe incluir `sellerId`.
- **Auth: solo JWT**, en la API REST (`jwtAuthMiddleware`) y en el socket. El fallback `x-api-key` (API_KEY = admin global) se sacó el 2026-09-14 porque el dashboard mandaba la clave incrustada en el JS público. `API_KEY` sigue solo como respaldo del secreto JWT cuando falta `JWT_SECRET`. Nada secreto puede ir en una variable `VITE_*`: Vite la escribe en el bundle que baja cualquiera.
- **Panel de ventas (ventas-app)**: el botón "Enviar a sistema" de SalesView pega contra
  `POST /orders/:id/sistema`, que traduce el `Order` en `sistemaSync.ts` y lo postea al
  panel (`D:\ventas-app`, otro repo, Mongo). El token (`SISTEMA_TOKEN`) vive solo en el
  servidor — el navegador nunca lo ve. El panel es idempotente sobre
  `(origen, externalId=Order.id)`: reenviar devuelve el pedido que ya creó, así que
  `externalId` NO se puede recalcular ni derivar. Una venta cargada queda con
  `sistemaOrderId` y status `En sistema`, y el botón se deshabilita.
- **Campañas promo (pestaña Promos, oct-2026)**: el bot le escribe PRIMERO a quien habló y no
  compró, con el plan de 60 días a `promoPrice60` (Editor de Precios). Vive en
  `src/services/promo/`: `promoAudience` arma la lista (default: últimos 180 días menos los
  últimos 30, que pueden tener un pedido en curso) desde `FunnelEvent` + `User.profileData`.
  FunnelEvent es la ÚNICA memoria de quién habló hace más de ~40 días: los estados se limpian
  a los 30 y ChatLog se purga; medido el 8-oct: 6.285 personas, 95% solo con rastro del
  embudo (sin nombre ni estado: el despachador les crea uno limpio). El texto de cada envío lo
  reescribe Claude (modelo simple) a partir del mensaje base del vendedor (`promoVariation`:
  valida precio, PROMO, largo y que no aparezca otro precio; 2 intentos) y si falla cae a
  `promoTemplates` (bloques + spintax, determinístico por campaña+teléfono); en los dos caminos
  el precio entra solo por placeholder. `promoDispatcher`
  manda de a uno desde un cron por minuto del scheduler: ventana horaria ARG, tope diario,
  pausa sorteada entre envíos, cortes largos, y re-validación del destinatario al momento de
  mandar. La respuesta cae en el step `promo_offer` (`stepPromoOffer.ts`): sin kilos, elige
  presentación y pasa directo al menú de pago. La promo es SOLO gotas (decisión del
  10-oct, tras pasar por "las tres" y "cápsulas o gotas"): `_getPromoPrice60` devuelve null para
  cualquier otra presentación, así que cápsulas y semillas van a lista. PROMO/sí arma las
  gotas directo (sin preguntar presentación); si piden otra, `promo_other_product` aclara y, si
  insisten, `promo_product_confirm_list`. El flyer de `public/promo/` es el de gotas. Mientras `state.promo.active`, el plan 60 se
  cotiza con `_getEffectivePrice(product, plan, state)` (pricing.ts): TODO lo que arma o
  verifica el cart tiene que usar esa función y no `_getPrice`, o la confirmación "corrige"
  el precio promo al de lista. Los rechazos pausan SIN alerta (`_quietPause`) y "no me
  escribas más" deja al teléfono fuera de toda campaña futura (`PromoRecipient.opted_out`).
  Esto manda fuera de la ventana de 24 h de WhatsApp (lo que `checkColdLeads` dejó de hacer
  en jun-2026 por riesgo de bloqueo): arrancar con tope bajo y mirar entregas. Tests:
  `tests/promo_*.test.js`. ADR-0002.
- **Prompt cache de Claude**: el system del `chat()` va en 2 bloques (`_buildSystemBlocks` en `aiPrompts.ts`): core compartido entre steps + módulo del step, cada uno con `cache_control` de 1h. NADA que dependa del mensaje, del cliente o de la hora puede entrar al system (rompe el prefijo para todas las llamadas); eso va al turno user. Verificar con `scripts/ai-cache-probe.ts` y con las líneas `[AI][usage]` de los logs (`cache_r` debe dominar a `in`).

## Multi-tenant scoping

- Toda query Prisma DEBE filtrar por `instanceId: sellerId`. Si se omite, el admin ve cosas de todos los sellers (a veces querido, a veces bug).
- `req.sellerId` lo setea `sellerContext` middleware: viene del JWT para sellers (locked), de `?sellerId=` query param para admins.
- `req.account.role === 'admin' && req.account.sellerId === null` → admin global (ve todo agregado). `role === 'admin' && sellerId !== null` → tenant admin (scoped a su seller).
- Un seller nunca inicia su Chromium hasta que escanea QR por primera vez (`lazy`). Sesiones con historial se auto-inician staggered en boot.

## Comandos

- `npm run dev` — concurrente server (tsx watch en index.ts) + client (vite)
- `npm run dev:server` — solo server (sin watch)
- `npm start` — producción: `prisma generate && migrate deploy && tsx index.ts`
- `npm test` — Jest. Suite verde (44 suites, 576 tests; 1 suite skipped es la `.live`). Corre contra la DB de prod (`DATABASE_URL` del `.env` apunta a Railway), así que **ninguna suite puede escribir**: si el código bajo test escribe, el test mockea `../db`. Hasta el 2026-09-13 `web_order_notify.test.js` no lo hacía y dejó una pausa real en prod. **Solo V7**: las suites acopladas a `archive/knowledge_v3.json`/v4 (simulaciones, recommendation, multi_product, salesFlow, etc.) se retiraron el 2026-05-31 — testeaban un guion muerto. Cobertura de flujo V7: `sena_flow_smoke.test.js` + `payment_flow.test.js`; el resto cubre utilidades (address, pricing, objection escalation, order flow). Pendiente: rehacer un harness de simulación contra V7. Para refactors hay tests de caracterización: `message_handler.test.js` y `ai_chat_payloads.test.js` graban una traza de efectos (`MH_TRACE_FILE` / `AI_TRACE_FILE`) para comparar byte a byte antes y después de mover código.
- `npx prisma migrate dev --name <x>` — nueva migración
- `railway logs --lines 300` — logs de producción

## Qué NO hacer

- No mockear la DB en los tests que solo leen — integración real. Si el código bajo test escribe, mockear `../db` es obligatorio: la DB es la de prod.
- No añadir `console.log`; usar `logger` de `src/utils/logger.ts` (pino).
- No tocar `index.ts` sin necesidad — es orquestador puro, la lógica vive en `clientPool` + handlers.
- No añadir features/abstracciones más allá de lo pedido. Tres líneas similares son mejor que una abstracción prematura.
- No usar destructive git (reset --hard, force-push, branch -D) sin pedir.
- No asumir que un precio o plan en un mensaje de usuario es válido — validar contra `pricing.ts`.

## Archivos clave para orientarse

- [index.ts](index.ts) — boot + shutdown
- [src/services/clientPool.ts](src/services/clientPool.ts) — orquestador multi-tenant
- [src/handlers/messageHandler.ts](src/handlers/messageHandler.ts) — entrada de mensajes
- [src/handlers/incomingSteps.ts](src/handlers/incomingSteps.ts) — los pasos de esa entrada
- [src/flows/salesFlow.ts](src/flows/salesFlow.ts) — router de steps
- [src/flows/utils/flowHelpers.ts](src/flows/utils/flowHelpers.ts) — `_cleanPhone`, `_setStep`, `_pauseAndAlert`
- [src/flows/utils/pricing.ts](src/flows/utils/pricing.ts) — única fuente de precios
- [src/flows/leadClassifier.ts](src/flows/leadClassifier.ts) — ruteo del lead nuevo + estado inicial
- [src/services/aiPrompts.ts](src/services/aiPrompts.ts) — texto de los prompts (ai.ts = runtime)
- [src/services/adminCommands.ts](src/services/adminCommands.ts) — comandos `!` del admin
- [src/api/routes/manualComplete.js](src/api/routes/manualComplete.js) — pasos de la carga manual de pedidos
- [prisma/schema.prisma](prisma/schema.prisma) — schema completo
- [src/api/server.js](src/api/server.js) — montaje Express/Socket.IO
- [src/api/routes/](src/api/routes/) — endpoints REST (todos pasan por `sellerContext`)
- [src/services/sistemaSync.ts](src/services/sistemaSync.ts) — traducción y push de una venta al panel de ventas

## Estado actual / tech debt

Limpieza del 2026-09-09 (148 archivos fuera). Si buscás algo de esto, ya no está:
`mobile-app/` (APK Capacitor abandonada, fork congelado del dashboard), `extension/`
(la extensión Chrome que reemplazó `agent/`; ver ADR-0001, marcada como superada),
`archive/scripts/` (rotos — los `archive/*.json` SÍ siguen, los sirve `system.routes.js`),
y 36 de los 39 one-offs de `scripts/` (quedaron `ai-cache-probe`, `audit-semantic-cache`
y `wipe-semantic-cache`). Todo recuperable del historial de git.


- Mezcla CommonJS + ES6 imports en utils (no unificado). Hay ~65 `require()` inline dentro de
  funciones en los `.ts`, y casi ninguno protege un ciclo real: solo `stepGreeting → salesFlow`
  y `flowHelpers → pauseService`. Antes de subir otro a `import`, fijarse que no esté
  difiriendo algo a propósito (carga pesada, orden de los mocks en los tests).
- `npx tsc --noEmit` pasa limpio (exit 0). Los TS errors de `ioredis`/`bullmq` y `@types/jest`
  que decía esta sección ya no existen.
- Funciones que siguen siendo grandes: `clientPool.startSeller` (~470 líneas) y
  `server.js startServer` (~325). Las dos son factories: su largo incluye los helpers
  anidados que devuelven, así que pesan menos de lo que dice el número. Partirlas implica
  recablear cómo se arma `sharedState` — mucho movimiento en el arranque para poca ganancia
  de lectura. `createMessageHandler` se partió el 2026-09-13 (ver `incomingSteps.ts`).
- Dashboard (`client/`): `npm run lint` da 0 errores y 1 warning (`@tanstack/react-virtual` no
  es compatible con el React Compiler, que no se usa). Los effects que sincronizan con algo de
  afuera (servidor, socket, localStorage, react-query) llevan
  `eslint-disable-next-line react-hooks/set-state-in-effect` con el motivo: uno nuevo sin
  motivo es error. recharts (Estadísticas) y emoji-picker van con `React.lazy` dentro de
  `LazyBoundary`, y `main.jsx` recarga una vez si tras un deploy falta un chunk.
- Admins globales (`sellerId=null`) vs tenant admins distinción reciente — verificar scoping cuando se agregan rutas nuevas.

## Agent skills

### Issue tracker

GitHub Issues en `crispantufla/BotHerbalis` vía CLI `gh`. Ver `docs/agents/issue-tracker.md`.

### Triage labels

Vocabulario por defecto (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). Ver `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` y `docs/adr/` en la raíz. Ver `docs/agents/domain.md`.
