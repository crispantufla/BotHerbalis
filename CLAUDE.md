# CLAUDE.md

Guía para trabajar en este repo. No repetir aquí cosas ya documentadas en código; solo lo no obvio.

## Qué es

Bot de WhatsApp multi-tenant para ventas **en España**. Un único proceso Node corre N vendedores (sellers), cada uno con su propio `whatsapp-web.js` Client + Puppeteer Stealth, estado aislado, y BullMQ queue namespaceada. Backend Express + Socket.IO sirve una SPA React (`client/`) que actúa como dashboard para admins y vendedores.

## ⚠️ Este repo es un FORK del bot argentino

El original vive en `D:\Bot Whatsapp` (GitHub: `crispantufla/BotHerbalis`) y está configurado aquí como remote `ar`. Comparten historia hasta el commit del fork, pero **son dos productos distintos y van a diverger**: no se mergean ramas entre ellos. Si un fix del bot argentino aplica aquí, se trae con un cherry-pick puntual y se revisa el copy (allá es voseo rioplatense, aquí español peninsular).

**Las migraciones ya NO son compartidas.** El historial argentino no puede reconstruir una base desde cero: cinco tablas (`AiErrorReport`, `DailyStats`, `Account`, `WhatsAppSession`, `QuickReply`) y las columnas `instanceId` del particionado se crearon allí con `prisma db push`, sin dejar migración. Allí no molesta porque su base ya las tiene; aquí, sobre una base nueva, `migrate deploy` moría a medias. Este repo tiene un único baseline (`20260804140000_init_es`) generado del schema con `prisma migrate diff`. Consecuencia práctica: **traer una migración del bot argentino con cherry-pick ya no funciona** — hay que mirar el cambio y escribirla aquí. El historial viejo sigue en los commits anteriores al fork.

Las tres diferencias estructurales, y por qué importan al tocar código:

1. **Solo contra reembolso.** No hay Mercado Pago, ni transferencia, ni link de pago, ni Bizum. Se borraron `stepWaitingMpPayment`, `stepWaitingTransferConfirmation`, `paymentOptions`, `mpPushConfirm`, `payment.routes` y el switch del panel. `FlowStep` ya no tiene `WAITING_MP_PAYMENT` ni `WAITING_TRANSFER_CONFIRMATION`. Si alguna vez hay que reintroducir un pago anticipado, no basta con el guion: hay que tocar `stepWaitingPaymentMethod.ts` y `_PAYMENT_POLICY` en `services/ai.ts`.
2. **El dinero se cuenta en céntimos.** Ver el bloque de documentación en `flows/utils/cartHelpers.ts`. Número = céntimos, string = euros en formato español ("49,90"). Convertir SOLO con `_parsePrice` / `_formatPrice`. Un `parseInt(precio.replace(...))` suelto lee "49,90" como 49. La única frontera donde se pasa a euros es `botHelpers._saveOrderAsync` (`Order.totalPrice` es un Float en euros, que es lo que suman los informes).
3. **España, no Argentina.** CP de 5 dígitos con provincia exacta por los 2 primeros dígitos, `Europe/Madrid` (que SÍ tiene horario de verano — ver el comentario de `getLocalMidnight`), Correos en vez de Correo Argentino.

## Stack

- **Runtime**: Node 20+, TypeScript via `tsx` (sin build step en dev). `type: commonjs` en package.json — mezcla `require()` y `import` (tech debt heredado).
- **WhatsApp**: `whatsapp-web.js` + `puppeteer-extra` con stealth plugin inyectado en `index.ts` sobreescribiendo `require.cache` de puppeteer.
- **DB**: PostgreSQL via Prisma 7. Todas las tablas están particionadas por `instanceId` (= `sellerId`).
- **Queue**: BullMQ sobre Redis. Una queue por seller: `whatsapp-messages-${sellerId}`.
- **Locks**: Redlock sobre Redis, compartido entre sellers. Lock keys incluyen `sellerId`.
- **AI**: OpenAI (GPT + embeddings) y/o Claude. Circuit breaker con cooldown de 30s tras 3 fallos consecutivos (ver `src/services/ai.ts`).
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

`greeting → waiting_weight → waiting_preference → waiting_plan_choice → waiting_payment_method → waiting_data → [waiting_maps_confirmation] → waiting_final_confirmation → waiting_admin_validation → completed`

- `processGlobals` corre antes de cada step — maneja cancelaciones, seguimiento, cliente recurrente, etc.
- Cada step devuelve `{ matched: boolean }`. Si no matchea, cae a IA vía `dependencies.aiService.chat()` con un `goal` específico al step.
- El AI devuelve `{ goalMet, response, extractedData }`. `extractedData` es un string con tags tipo `ENVIO: retiro` que el step parsea con regex.

## Convenciones no obvias

- **`waiting_payment_method` ya no elige medio de pago.** Elige MODALIDAD DE ENTREGA: `1` = envío a casa (paga al repartidor), `2` = recogida en oficina de Correos (paga al recogerlo). Conserva el id histórico porque es la clave del embudo y del panel. El **orden importa**: el menú del guion (`flow.payment_menu`) y `_deliveryMenu()` en el step tienen que listar lo mismo en el mismo orden, o "la 1" del cliente elige lo contrario de lo que leyó.
- **`shippingChoice: 'retiro' | 'domicilio'`** conserva los valores del original: `'retiro'` = recogida en oficina. Los informes y el panel filtran por esos strings.
- **`PICKUP_STREET`** (`flowHelpers.ts`) es el centinela que va en `calle` cuando es recogida; comparar SIEMPRE con `_isPickupAddress()`, nunca a mano (una diferencia de mayúsculas convertía una recogida en un envío a domicilio).
- **`_cleanPhone(userId)`** en `flowHelpers.ts` es la forma canónica de extraer teléfono. Usar siempre en vez de `userId.split('@')[0]` manual.
- **`_setStep(state, FlowStep.X)`** — NO asignar `state.step` directamente. Esto resetea flags (`staleAlerted`, `reengagementSent`, etc.) y loguea transición al funnel.
- **`_pauseAndAlert(...)`** — cuando el bot no sabe qué hacer, pausa al user y notifica al admin. No intentar "auto-recovery" silenciosos.
- **Pausas NO se auto-liberan**. Un user pausado con `pauseReason` requiere intervención manual del admin. Si un outage (ej: OpenAI 429) pausa users, hay que despausarlos a mano.
- **Pricing**: siempre leer con `_getPrice/_getPrices` de `pricing.ts` y convertir con `_parsePrice`. NUNCA inventar precios en código ni en prompts de IA.
- **Pagar con tarjeta al repartidor**: el bot NO lo promete ni lo niega — pausa y deriva a una persona (lo cobra Correos y depende de la zona). Ver `CARD_OR_NO_CASH` en `stepWaitingPaymentMethod.ts`.
- **DB upserts bajo race**: código P2002 de Prisma = concurrent upsert race. Ignorar (ver `botHelpers.ts`).
- **Locks**: `order_lock:${phone}:${sellerId}` TTL 3000ms. Queries internas al lock deben tener timeout < TTL (ver `cancelLatestOrder` con 2500ms).
- **Socket.IO rooms**: emitir siempre a `sellerId` room y a `admin` room (admins ven todo). Payload del admin debe incluir `sellerId`.

## Localización

Todo lo que depende del país vive en [src/config/market.ts](src/config/market.ts): moneda, transportista, punto de recogida, plazos, zona horaria, prefijo telefónico. Si un dato de esos aparece escrito a mano en un step, es un bug esperando a la próxima vez que cambie.

Lo que NO va ahí: precios (los edita el vendedor en `data/prices.json` desde el panel) ni copy de venta (vive en `knowledge_v7.json`).

## Cumplimiento publicitario (`src/services/compliance.ts`)

Todo lo que el bot escribe es comunicación comercial de un complemento alimenticio en España, así que le aplica el Reglamento (CE) 1924/2006 (el art. 12b prohíbe mencionar magnitud o ritmo de pérdida de peso) y el precedente de la AEMPS con este mismo producto (alerta ICM/MI 13/2012: presentarlo como adelgazante lo convierte en medicamento sin autorización).

`checkCompliance()` tiene las reglas y su base legal. **Pásalo siempre que toques copy o prompts: `npm run auditar`.**

Lo no obvio, aprendido el 15-08-2026 cuando una auditoría encontró 124 incumplimientos heredados del guion argentino:

- **No basta con limpiar `knowledge_v7.json`.** La IA redacta buena parte de los mensajes, y varios *prompts* le ORDENABAN escribir claims ("Aclara que los tres funcionan igual para bajar de peso"). Con el guion impecable, el bot seguía diciéndolo. Por eso el auditor barre las tres superficies: guion, prompts de IA y mensajes automáticos.
- **El bot puede ENTENDER kilos, pero no ESCRIBIRLOS.** Si la clienta dice "quiero perder 10 kilos", eso son sus palabras y el `weightGoal` se sigue usando para elegir plan; lo que no puede es repetírselos. La cualificación pregunta por tipo de plan (rutina corta / plan completo), no por kilos, y enruta igual.
- **Ojo con los acentos en las regex**: `\w` no incluye vocales acentuadas, así que una regla escrita como `\w*` deja pasar "Bajá" y "eliminación". Y `\b` no cierra tras vocal acentuada — hace falta lookahead.
- **Cuidado con los falsos positivos de voseo**: "mira", "sabes" y "descarga" son tuteo peninsular correcto; el voseo lleva tilde ("mirá", "sabés", "descargá"). Una regla que acepte la forma sin tilde bloquea copy válido.

Las redes sociales y la publicidad viven en **otro proyecto**: `D:\Herbalis Social`, con su propia base de datos y su propio panel. El bot no publica nada — solo atiende a quien llega por WhatsApp.

## Multi-tenant scoping

- Toda query Prisma DEBE filtrar por `instanceId: sellerId`. Si se omite, el admin ve cosas de todos los sellers (a veces querido, a veces bug).
- `req.sellerId` lo setea `sellerContext` middleware: viene del JWT para sellers (locked), de `?sellerId=` query param para admins.
- `req.account.role === 'admin' && req.account.sellerId === null` → admin global (ve todo agregado). `role === 'admin' && sellerId !== null` → tenant admin (scoped a su seller).
- Un seller nunca inicia su Chromium hasta que escanea QR por primera vez (`lazy`). Sesiones con historial se auto-inician staggered en boot.

## Comandos

- `npm run dev` — concurrente server (tsx watch en index.ts) + client (vite)
- `npm run dev:server` — solo server (sin watch)
- `npm start` — producción: `prisma generate && migrate deploy && tsx index.ts`
- `npm test` — Jest. Integración real contra la DB (no se mockea).
- `npm run auditar` — **pásalo siempre que toques copy o prompts.** Barre el guion, los prompts de IA y los mensajes automáticos buscando claims que no se pueden publicar en España. Sale con código 1 si encuentra algo.
- `npm run venta:prueba [recogida]` — simula una venta entera contra la IA real y muestra el pedido resultante. Es el harness de simulación de V7.
- `npx prisma migrate dev --name <x>` — nueva migración
- `railway logs --service bot-es` — logs de producción (proyecto "Herbalis Bot Esp")

## Despliegue

Railway, proyecto **Herbalis Bot Esp** — separado del argentino ("Herbalis Bots"), con su propio Postgres y su propio Redis. Servicio `bot-es`: un solo contenedor que corre el bot y sirve el panel compilado (el Dockerfile hace el `vite build` dentro de la imagen, así que el front viaja con el deploy).

- `railway up --service bot-es` despliega desde el directorio local.
- `DATABASE_URL` y `REDIS_URL` son referencias (`${{Postgres.DATABASE_URL}}`) a los servicios de ESTE proyecto. Si algún día apuntan a un host que no sea `*.railway.internal` de aquí, están cruzadas con otro negocio.

## Qué NO hacer

- No mockear la DB en los tests — integración real con la DB.
- No añadir `console.log`; usar `logger` de `src/utils/logger.ts` (pino).
- No tocar `index.ts` sin necesidad — es orquestador puro, la lógica vive en `clientPool` + handlers.
- No añadir features/abstracciones más allá de lo pedido. Tres líneas similares son mejor que una abstracción prematura.
- No usar destructive git (reset --hard, force-push, branch -D) sin pedir.
- No asumir que un precio o plan en un mensaje de usuario es válido — validar contra `pricing.ts`.
- **No reintroducir medios de pago anticipados** sin decisión explícita del dueño: el argumento de venta central del guion es "no pagas nada hasta tenerlo en la mano".

## Archivos clave para orientarse

- [index.ts](index.ts) — boot + shutdown
- [src/config/market.ts](src/config/market.ts) — todo lo que cambia por país
- [src/services/clientPool.ts](src/services/clientPool.ts) — orquestador multi-tenant
- [src/handlers/messageHandler.ts](src/handlers/messageHandler.ts) — entrada de mensajes
- [src/flows/salesFlow.ts](src/flows/salesFlow.ts) — router de steps
- [src/flows/steps/stepWaitingPaymentMethod.ts](src/flows/steps/stepWaitingPaymentMethod.ts) — elección de entrega
- [src/flows/utils/flowHelpers.ts](src/flows/utils/flowHelpers.ts) — `_cleanPhone`, `_setStep`, `_pauseAndAlert`, `PICKUP_STREET`
- [src/flows/utils/cartHelpers.ts](src/flows/utils/cartHelpers.ts) — modelo de dinero (céntimos)
- [src/flows/utils/pricing.ts](src/flows/utils/pricing.ts) — única fuente de precios
- [src/services/ai.ts](src/services/ai.ts) — persona, reglas y política de pago del prompt
- [knowledge_v7.json](knowledge_v7.json) — guion editable desde el panel
- [prisma/schema.prisma](prisma/schema.prisma) — schema completo
- [src/api/server.js](src/api/server.js) — montaje Express/Socket.IO
- [src/api/routes/](src/api/routes/) — endpoints REST (todos pasan por `sellerContext`)

## Estado actual / tech debt

- Mezcla CommonJS + ES6 imports en utils (no unificado, heredado).
- Los tests todavía están calibrados sobre el guion argentino: hay que rehacerlos contra el flujo español.
- `WebOrder` (tienda web) sigue en el schema y en el panel, pero en España no hay tienda web conectada: la tabla queda vacía.
