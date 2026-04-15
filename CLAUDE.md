# CLAUDE.md

Guía para trabajar en este repo. No repetir aquí cosas ya documentadas en código; solo lo no obvio.

## Qué es

Bot de WhatsApp multi-tenant para ventas. Un único proceso Node corre N vendedores (sellers), cada uno con su propio `whatsapp-web.js` Client + Puppeteer Stealth, estado aislado, y BullMQ queue namespaceada. Backend Express + Socket.IO sirve una SPA React (`client/`) que actúa como dashboard para admins y vendedores.

## Stack

- **Runtime**: Node 20+, TypeScript via `tsx` (sin build step en dev). `type: commonjs` en package.json — mezcla `require()` y `import` (tech debt conocido).
- **WhatsApp**: `whatsapp-web.js` + `puppeteer-extra` con stealth plugin inyectado en `index.ts` sobreescribiendo `require.cache` de puppeteer.
- **DB**: PostgreSQL via Prisma 7. Todas las tablas están particionadas por `instanceId` (= `sellerId`).
- **Queue**: BullMQ sobre Redis. Una queue por seller: `whatsapp-messages-${sellerId}`.
- **Locks**: Redlock sobre Redis, compartido entre sellers. Lock keys incluyen `sellerId`.
- **AI**: OpenAI (GPT + embeddings). Circuit breaker con cooldown de 30s tras 3 fallos consecutivos (ver `src/services/ai.ts`).
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

Flujo de un mensaje: `client.on('message')` → `messageHandler` (debounce ~N segundos para agrupar mensajes consecutivos) → encola en BullMQ → worker pulls → `processSalesFlow` → step correspondiente en `src/flows/steps/` → `sendMessageWithDelay` (4-8s delay humanizado).

## Flujo de venta (`src/flows/steps/`)

Máquina de estados lineal con fallbacks a IA. Orden típico:

`greeting → waiting_weight → waiting_preference → waiting_plan_choice → waiting_ok → waiting_data → waiting_maps_confirmation → waiting_payment_method → [waiting_mp_payment] → waiting_price_confirmation → waiting_final_confirmation → waiting_admin_validation → completed`

- `processGlobals` corre antes de cada step — maneja cancelaciones, seguimiento, cliente recurrente, etc.
- Cada step devuelve `{ matched: boolean }`. Si no matchea, cae a IA vía `dependencies.aiService.chat()` con un `goal` específico al step.
- El AI devuelve `{ goalMet, response, extractedData }`. `extractedData` es un string con tags tipo `POSTDATADO: 2026-05-20` que el step parsea con regex.

## Convenciones no obvias

- **`_cleanPhone(userId)`** en `flowHelpers.ts` es la forma canónica de extraer teléfono. Usar siempre en vez de `userId.split('@')[0]` manual.
- **`_setStep(state, FlowStep.X)`** — NO asignar `state.step` directamente. Esto resetea flags (`staleAlerted`, `reengagementSent`, etc.) y loguea transición al funnel.
- **`_pauseAndAlert(...)`** — cuando el bot no sabe qué hacer, pausa al user y notifica al admin. No intentar "auto-recovery" silenciosos.
- **Pausas NO se auto-liberan**. Un user pausado con `pauseReason` requiere intervención manual del admin. Si un outage (ej: OpenAI 429) pausa users, hay que despausarlos a mano.
- **Pricing**: siempre leer con `_getPrice/_getPrices/_getAdicionalMAX` de `pricing.ts`. NUNCA inventar precios en código ni en prompts de IA (ver `stepWaitingFinalConfirmation.ts` para el patrón: se inyecta `pricingContext` en el prompt).
- **Adicional contrarembolso**: solo aplica a plan 60 + pagos en efectivo/contrarembolso. MP/transferencia lo exime. Recalcular tras cambios de plan/producto (no confiar en `isContraReembolsoMAX` previo).
- **DB upserts bajo race**: código P2002 de Prisma = concurrent upsert race. Ignorar (ver `botHelpers.ts:65`).
- **Locks**: `order_lock:${phone}:${sellerId}` TTL 3000ms. Queries internas al lock deben tener timeout < TTL (ver `cancelLatestOrder` con 2500ms).
- **Socket.IO rooms**: emitir siempre a `sellerId` room y a `admin` room (admins ven todo). Payload del admin debe incluir `sellerId`.

## Multi-tenant scoping

- Toda query Prisma DEBE filtrar por `instanceId: sellerId`. Si se omite, el admin ve cosas de todos los sellers (a veces querido, a veces bug).
- `req.sellerId` lo setea `sellerContext` middleware: viene del JWT para sellers (locked), de `?sellerId=` query param para admins.
- `req.account.role === 'admin' && req.account.sellerId === null` → admin global (ve todo agregado). `role === 'admin' && sellerId !== null` → tenant admin (scoped a su seller).
- Un seller nunca inicia su Chromium hasta que escanea QR por primera vez (`lazy`). Sesiones con historial se auto-inician staggered en boot.

## Comandos

- `npm run dev` — concurrente server (tsx watch en index.ts) + client (vite)
- `npm run dev:server` — solo server (sin watch)
- `npm start` — producción: `prisma generate && migrate deploy && tsx index.ts`
- `npm test` — Jest. `tests/complex_sales.test.js` tiene 1 test "Retries de direccion" que falla pre-audit (conocido, no fixear sin pedirlo).
- `npx prisma migrate dev --name <x>` — nueva migración
- `railway logs --lines 300` — logs de producción

## Qué NO hacer

- No mockear la DB en los tests — integración real con la DB.
- No añadir `console.log`; usar `logger` de `src/utils/logger.ts` (pino).
- No tocar `index.ts` sin necesidad — es orquestador puro, la lógica vive en `clientPool` + handlers.
- No añadir features/abstracciones más allá de lo pedido. Tres líneas similares son mejor que una abstracción prematura.
- No usar destructive git (reset --hard, force-push, branch -D) sin pedir.
- No asumir que un precio o plan en un mensaje de usuario es válido — validar contra `pricing.ts`.

## Archivos clave para orientarse

- [index.ts](index.ts) — boot + shutdown
- [src/services/clientPool.ts](src/services/clientPool.ts) — orquestador multi-tenant
- [src/handlers/messageHandler.ts](src/handlers/messageHandler.ts) — entrada de mensajes
- [src/flows/salesFlow.ts](src/flows/salesFlow.ts) — router de steps
- [src/flows/utils/flowHelpers.ts](src/flows/utils/flowHelpers.ts) — `_cleanPhone`, `_setStep`, `_pauseAndAlert`
- [src/flows/utils/pricing.ts](src/flows/utils/pricing.ts) — única fuente de precios
- [prisma/schema.prisma](prisma/schema.prisma) — schema completo
- [src/api/server.js](src/api/server.js) — montaje Express/Socket.IO
- [src/api/routes/](src/api/routes/) — endpoints REST (todos pasan por `sellerContext`)

## Estado actual / tech debt

- Mezcla CommonJS + ES6 imports en utils (no unificado).
- TS errors preexistentes: `ioredis` mismatch con `bullmq`, tests sin `@types/jest`.
- Admins globales (`sellerId=null`) vs tenant admins distinción reciente — verificar scoping cuando se agregan rutas nuevas.
