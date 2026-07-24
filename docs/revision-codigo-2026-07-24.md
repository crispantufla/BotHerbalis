# Revisión de código — 2026-07-24

Revisión en busca de bugs, fallos, código muerto/en desuso y mejoras.
**Este archivo es el registro vivo de la revisión**: si la sesión de Claude se corta, retomar desde acá.

## Estado

- [x] Área 1: `src/flows/**` — **COMPLETADA** (ver hallazgos abajo)
- [x] Área 2: `src/services/**` — **COMPLETADA** (ver hallazgos abajo)
- [x] Área 3: `src/api/**` + `src/handlers/**` + `index.ts` + `src/utils/**` — **COMPLETADA** (ver hallazgos abajo)
- [x] Área 4: `client/src/**` — **COMPLETADA** (ver hallazgos abajo)

**REVISIÓN COMPLETA — las 5 áreas terminadas. Ver "Resumen ejecutivo" al final.**
- [x] Área 5: barrido transversal de código muerto — **COMPLETADA** (ver hallazgos abajo)

## Contexto excluido de la revisión (intencional / ya conocido / ya arreglado)

- P2002 ignorado en upserts = intencional (race de upsert concurrente).
- Pausas que no se auto-liberan = diseño.
- Mezcla CommonJS/ESM, TS errors ioredis/bullmq, @types/jest = tech debt conocido (CLAUDE.md).
- Leak de crons del scheduler en stopSeller = ya en arreglo en otra sesión (task del worktree).
- `stepWaitingMpPayment.ts`, `mpPushConfirm.ts`, `payment.routes.js`, sweep de `refreshPendingPayments` = revisados adversarialmente el 23-jul; solo bugs nuevos.
- Fix TDZ de prisma en order.routes + `_claudeParseAddress` en ai.ts = recientes e intencionales.

## Hallazgos

_(pendiente — se completa cuando terminen los agentes)_

### Área 1 — flows ✅ (27 archivos + state.ts + knowledge_v7.json)

**BUGS ALTA:**
- `stepWaitingFinalConfirmation.ts:115` — **regex de confirmación sin anclar confirma pedidos con frases que NO confirman**: `_isAffirmative(...) || /\b(si|dale|ok|listo|confirmo|...)\b/i.test(...)`. "¿y si no estoy en casa ese día?" o "no, mejor dale de baja" → matchea `\bsi\b`/`\bdale\b` → guarda orden + notifica admin + waiting_admin_validation. El `||` anula el `_isAffirmative` ULTRA-STRICT y hace inalcanzable la rama de IA que sabe distinguir preguntas.
- `salesFlow.ts:389-393` + `stepGreeting.ts:38-47` — **recursión infinita posible**: `handleGreeting` con `hasManualGreeting` llama `processSalesFlow` SIN pasar `_recursionDepth` (resetea a 0). Ad-trigger exacto + sin weightGoal + history con "Cuántos kilos buscás bajar" (el cron de re-engagement manda exactamente ese texto; clientes V5 tienen "Buscás bajar hasta 10 kg") → AD-RE-ENTRY→greeting→waiting_weight→recursión→loop async infinito → worker colgado.

**BUGS MEDIA:**
- `stepWaitingPaymentMethod.ts:338-369` (y atajo 544-572) — submenú MP/Transferencia no maneja negaciones: "no me gusta la transferencia" / "no quiero pagar con tarjeta" → matchea keyword → el bot manda alias/link, lo contrario de lo pedido. El branch DISTRUST_PREPAY está gateado con `!paymentSubChoiceAsked` y dentro del submenú nunca actúa.
- `stepWaitingFinalConfirmation.ts:20-45` — multi-unidad en confirmación final: "¿puedo pedir 3 cajas?" → newPlan='180' → `_getPrice` cae al fallback de '60' → cart `{plan:'180', price:precio_60}` y el bot dice "60 días" para 3 unidades. stepWaitingData usa `buildCartFromSelection` (correcto); este step no.
- `stepWaitingData.ts:72-82` — cambio de PLAN en waiting_data borra `partialAddress` → cliente que ya dio nombre/ciudad los pierde y se los re-pide. Inconsistente con stepWaitingPlanChoice:266-268 que los conserva.
- `stepWaitingMapsConfirmation.ts:53,111` — usa `currentState.price || _getPrice(...)` para el cart — el mismo footgun que el fix F2 eliminó de stepWaitingData; precio viejo de otro plan puede colarse y acá no corre `_orderPriceCoherent`.
- `globalSafety.ts:19` — `SAFETY_REGEX` contiene `niñ[oa]s?` / `años?` con ñ literal pero se testea contra texto NFD-stripped (ñ→n) → esas alternativas NO matchean nunca. "es para un niño de 12" no dispara safety. globalSystem.ts:94 lo hace bien con `a[ñn]os`.

**BUG BAJA:**
- `stepWaitingTransferConfirmation.ts:17,69-77` — `RETIRO_OR_CASH_KEYWORDS` incluye `cuando llega` y `1` sueltos → pregunta de timing puede resetear paymentMethod de quien YA eligió transferencia (hoy ensombrecido porque globalFaq intercepta "cuándo llega"; si la FAQ cambia se destapa).

**CONVENCIÓN (baja):**
- `flowHelpers.ts:547` y `stepWaitingFinalConfirmation.ts:61` — `userId.split('@')[0]` en `_closeSaleAndNotify`/`_buildOrderData` en vez de `_cleanPhone`.

**MUERTO:**
- `cartHelpers.ts:68-111` (media) — `buildMultiProductCart` exportada, 0 llamadores.
- `extractedData.ts:40-44` — `parseProfile` sin llamadores (reimplementado inline en stepWaitingPlanChoice).
- `pricing.ts:85-90` — `_getCostoLogistico` sin llamadores.
- `state.ts:78` + `stepWaitingPreference.ts:106,166` — `consultativeSale` se setea, nadie lo lee.
- `flowHelpers.ts:34` — `cashRetryShown` solo se resetea, nunca se setea/lee (legacy documentado).
- `steps/index.ts:81-82` — entradas de `stepMigrations` inalcanzables (ambos steps tienen case propio).
- `stepGreeting.ts:195-205` — split del saludo en 2 mensajes busca copy que V7 ya no tiene → nunca matchea, saludo sale como 1 mensaje (feature silenciosamente muerta).
- `stepWaitingPlanChoice.ts:216,262,325,357` — 4× `const closingNode` sin usar (restos V5).

**MEJORAS:**
- `stepWaitingFinalConfirmation.ts:119,163` (media) — con `pendingOrder` null dice "Recibimos tu confirmación ⏳" y pasa a waiting_admin_validation SIN crear orden ni notificar (el guard anti venta-fantasma excluye ese step). Agregar `_pauseAndAlert` en la rama sin pendingOrder.
- `objectionDetector.ts:199-221` (baja) — rebuttals prometen "te reservo el precio hasta el viernes" — modalidad prohibida por el copy V7 y nada la honra.
- `stepWaitingData.ts:1012-1013` (baja) — "sí"/"dale" fuerza `parseAddress("si")` — llamada IA gastada por cada ack, riesgo de alucinar campos.
- `globalMedia.ts:79` (baja) — "no tengo fotos cargadas" se envía sin loguear a history ni saveState (rompe invariante del dashboard; `_isDuplicate` no lo ve).

**Verificado sin hallazgo**: sin queries Prisma sin instanceId, sin console.log en el área.

### Área 2 — services ✅ (16 archivos revisados)

**BUGS ALTA:**
- `ai.ts:1114` — **cache exact-match del path OpenAI cruza datos entre clientes**: key `chat_${step}_${userText}` sin historial ni estado, cacheado 45 min sin guard. Dos clientes que escriben lo mismo en el mismo step (ej: "cuánto sale?" en waiting_final_confirmation) → el 2º recibe la respuesta del 1º con SU total/nombre. Solo se dispara cuando Claude falla y cae a OpenAI (= outage de Anthropic, justo cuando todo pasa por ahí). El path Claude (713-715) sí incluye historial+estado en la key — este quedó atrás.
- `ai.ts:281-286` + `pricing.ts:67` — **"DESCUENTO DE JUNIO" sigue activo el 24-jul**: `_JUNE_DISCOUNT` sin gate por fecha; el prompt dice "vigente hasta 30/06/2026". O se cobra $10.000 de menos desde hace 3 semanas, o el bot miente con fechas vencidas. Comentario propio dice "REVERTIR/QUITAR el 01/07". **DECISIÓN DE NEGOCIO — preguntar al usuario.**

**BUGS MEDIA:**
- `adminService.ts:318` — `!pausados` llama `getPausedUsersWithDetails()` sin instanceId → cae a `INSTANCE_ID || 'default'` en vez de `sharedState.sellerId` (como sí hacen !stats/!pedido/!reset). Si INSTANCE_ID ≠ 'horacio' responde "No hay pausados" siempre.
- `adminService.ts:697-707` — link de pago por comando "soy tu amo" crea paymentLink **sin instanceId** → queda 'default' → `refreshPendingPayments` (filtra por sellerId) jamás lo refresca; solo webhook.
- `scheduler.ts:1034-1036` — stage 2 de checkPendingMpPayments pausa con `pausedUsers.add()` directo, salteando `pauseService.pauseUser()` → pausa invisible en DB/dashboard/!pausados y no se restaura tras restart.
- `scheduler.ts:866-868` — `snapshotDailyStats`: `toZonedTime + setHours(0,0,0,0)` opera en TZ del server (UTC) → "medianoche" = 21:00 ARG del día anterior → ventana de 27h, doble conteo de 21:00-24:00 en DailyStats. `!stats` (adminService:289-290) tiene el mismo corrimiento. Usar patrón de timeUtils.
- `ai.ts:1084` — circuit breaker OpenAI NO es per-seller: chat/parseAddress/transcribe/analyze/generateSuggestion no pasan sellerId → breaker 'global' compartido. Solo el path Claude es per-seller. 3 fallos bloquean 30s a todos.
- `clientPool.ts:556,571,473,794` — `auth_failure`/`disconnected`/`qr_timeout`/`reconnecting` emiten status_change SOLO al room sellerId, sin espejo al room `admin` → admin global no ve caídas en tiempo real (qr/ready/change_state sí cumplen).

**BUGS BAJA:**
- `pauseService.ts:98` — `unpauseUser` borra `adminNotifiedAt` con key `userId` pero `pauseUser` escribe `${sellerId}:${userId}` → delete nunca matchea → re-pausa dentro de 5 min se debouncea en silencio (admin no se entera).
- `ai.ts:234` + `scheduler.ts:645` — fallback `DATA_DIR = path.join(__dirname,'../../..')` copiado de pricing.ts (que está un nivel más profundo) → apunta FUERA del repo (D:\). Sin env DATA_DIR: `_getPrices` de ai.ts cae en silencio a precios hardcodeados; checkAiBudget escribe fuera del proyecto. Prod setea DATA_DIR; foot-gun de dev.
- `clientPool.ts:683-748` — stopSeller/wipeSessionAndRestart no esperan `startingPromises` → wipe durante un start en vuelo borra `.wwebjs_auth` debajo de un `client.initialize()` en curso.
- `stateManager.ts:218-225` — fallback de loadState con DB caída solo restaura `config` del archivo; pierde `pausedUsers`/`chatResets` → tras outage de Postgres al boot, el bot le responde a clientes pausados para intervención manual.
- `clientPool.ts:245` + `stateManager.ts:108` — `loadKnowledge` async tipada void, nadie la awaitea → ventana al boot con knowledge vacío; el param `knowledge` de createMessageHandler es snapshot muerto (el handler usa sharedState.knowledge).
- `adminService.ts:488-493` — `!precios` itera `Object.entries` sobre `costoLogistico` (string) → línea basura por carácter; además muestra precios base sin el descuento real.

**MUERTO:**
- `scheduler.ts:198-224` — `checkStaleUsers` sin cron ni llamador (media — la feature "alerta cliente estancado >20min" está apagada en silencio; el flag `staleAlerted` que _setStep resetea no lo setea nadie). Registrarla o borrarla. [ya detectado por Área 5 también]
- `scheduler.ts:421-457` — `checkSecondFollowUp` inerte Y fuera del export (el comentario "por compatibilidad/exports" es falso) + `SECOND_FOLLOW_UP_MESSAGES` (185) huérfanos.
- `ai.ts:1548-1585` — `generateContextualBridge` sin llamadores.
- `queueService.ts:146-157` — exports legacy `botQueue/initWorker/shutdownQueue` sin llamadores; PEOR: `botQueue = createQueue('default')` es side-effect de import que crea una Queue real `whatsapp-messages-default` en Redis en cada proceso.
- `clientPool.ts:225-229` — `getSellerByPhone` sin llamadores.

**MEJORAS:**
- `stateManager.ts:168-190` (media) — `saveState()` sin arg = hasta 5000 upserts de User en un solo Promise.all sin chunking → puede saturar el pool de Prisma. Chunkear de a ~25 o persistir solo `_pendingUsers`.
- `ai.ts:796-815` (baja) — backoff duerme también en el ÚLTIMO intento: ~9s de latencia extra antes de tirar Max Retries. Saltear sleep cuando `attempt === MAX_RETRIES-1`.

### Área 3 — api/handlers ✅ (30 archivos + 6 de apoyo)

**BUG ALTA:**
- `system.routes.js:467` — **`POST /global-pause-all` roto**: registrado solo con `requireAdmin` sin `jwtAuthMiddleware` (no hay auth global de router) → `req.account` nunca se setea → 403 SIEMPRE, incluso admin válido. El botón "Pausar todos" del dashboard (DashboardView.jsx:171) siempre cae en toast de error. Fix: agregar `...withSeller(clientPool)` o `jwtAuthMiddleware` antes de `requireAdmin`.

**SEGURIDAD:**
- `admin.routes.js:203-210` (media/alta) — `GET /agent/installer` firma JWT de 365 días con `findFirst({ where: { sellerId } })` sin filtrar `role`/`isActive` ni orderBy. Si coexisten cuenta seller y tenant-admin con el mismo sellerId (caso Horacio), el seller puede recibir token con `role:'admin'` → escalación (con eso `sellerContext` le permite `?sellerId=` de cualquier tenant). También resucita cuentas desactivadas (jwtAuth no re-verifica isActive). Fix: `where: { sellerId, role:'seller', isActive:true }`.
- `server.js:289-311` + `sellerContext.ts:18-38` (media) — **modelo tenant-admin contradictorio**: el comentario de server.js dice que tenant admin NO debe ver otras rooms, pero `switch-seller` deja a cualquier admin unirse a cualquier room sin validar (incluso literalmente `'admin'` como newSellerId → fire-hose cross-tenant completo). En REST, `sellerContext` permite a tenant admin `?sellerId=otro`. DECIDIR modelo (scoped vs supervisor global) y alinear los 3 puntos; como mínimo validar `newSellerId` contra `clientPool.isKnown()`.
- `server.js:89` (media) — **`/media` estático SIN auth** sirve audios de clientes con nombres semi-predecibles `<telefono>_<timestamp>.ogg` → cualquiera sin login puede descargar audios (PII de salud/peso). Mover detrás de auth o nombres UUID.
- `admin.routes.js:47-115` (media) — `POST /mp-link` con `sendToChat:true` manda link MP a cualquier número sin `_verifyChatOwnership` (que `/send` sí tiene); `amount` sin tope; y con admin en vista agregada `instanceId: null` → PrismaClientValidationError 500 DESPUÉS de crear la preferencia en MP (preferencia viva sin registro local). Mismo `instanceId: null` posible en `POST /ai-reports` (chat.routes.js:1038).
- `order.routes.js:52-66` (baja) — `GET /orders/sellers` sin `requireAdmin`: cualquier seller lista los instanceId de todos los tenants.

**BUGS MEDIA:**
- `auth.routes.js:327-352` — `splitSessionByHour` con signo de offset invertido (`cursorMs - (-180)*60_000` = UTC+3, AR es UTC−3) → buckets de hora/día corridos +6h en `/accounts/stats/daily` y heatmap. Patrón correcto en analytics.routes.js:765.
- `botHelpers.ts:182` — evento socket `new_order` emite `status:'Pendiente'` hardcodeado aunque la orden se cree como 'Confirmado' → dashboard muestra estado viejo hasta recargar. Debe ser `status: newOrderData.status`.
- `system.routes.js:40` — `GET /api/health` inalcanzable para todos (jwtAuth skipea sin setear account → sellerContext 401 incondicional). 0 llamadores; el healthcheck real es el `/health` público de server.js:92. Borrar.

**BUGS BAJA:**
- `auth.routes.js:192-220` — `PUT /accounts/:id` no lowercasea `name`/`sellerId` ni valida `role` (el POST sí) → renombrar a "Horacio" deja la cuenta sin poder loguear; role arbitrario rompe checks silenciosamente.
- `chat.routes.js:149` — `resolveChatId(..., sellerId='default')`: NINGÚN caller pasa el 3er arg → la cache LRU "per-seller" opera siempre en bucket 'default'; con multi-seller mezclaría resoluciones @lid entre tenants.
- `messageHandler.ts:494` (+botHelpers.ts:70,106) — limpieza manual de teléfono en vez de `_cleanPhone` (convención).

**MUERTO (baja):**
- `system.routes.js:114` — `GET /scan` sin referencias e inusable desde browser (exige Bearer).
- `order.routes.js:2-4` — imports `fs`, `path`, `authMiddleware` sin uso; `admin.routes.js:5` — `authMiddleware` sin uso.
- `auth.routes.js:299` — `POST /logout` sin llamadores (el cliente solo descarta el token).

**MEJORA (baja):**
- `server.js:124-129` — SPA fallback devuelve index.html 200 para `/api/*` inexistentes → endpoints tipeados mal dan HTML 200 en vez de 404 JSON. Excluir `req.path.startsWith('/api')`.

**Verificado sin hallazgo**: todos los llamadores de `sendMessageWithDelay` correctos con la nueva firma; webhook MP HMAC fail-closed intacto; `/chat-state` y `/waiting-customers` vivos (agent.js:431, WaitingCustomersPanel.jsx:21); Express v5 → throws async llegan al error handler; sin console.log.

### Área 4 — client ✅ (46 archivos)

**BUGS ALTA:**
- `Toast.jsx:52-58,135` — el objeto `toast` se recrea en cada render y el value del context no está memoizado → cada toast re-renderiza a TODOS los consumidores con identidad nueva; todo `useCallback` con `toast` como dep se recrea y sus effects se re-disparan. Consecuencia: **loop infinito de refetch en error** (error→toast→nuevo callback→effect→refetch→error…) martillando la API. Fix: memoizar `toast` (irónicamente `confirm` sí lo está).
- `PlaygroundView.jsx:58-60` — por el bug anterior: **cualquier toast dentro del Playground crea sesión nueva y borra la conversación**. "Forzar step" muestra toast.success → se recrea `startNewSession` → effect postea new-session → el salto de step se deshace solo al instante. Mismo patrón de loop-en-error en RescueQueueView:89, FunnelAnalyticsView:136, AccountStatsView:62, AccountsView:517.

**BUGS MEDIA:**
- `SalesView.jsx:46-48` — `isSucursal` marca "Sucursal" si `paymentMethod==='contrarembolso'`, pero el COD-con-seña crea órdenes a DOMICILIO con ese paymentMethod (stepWaitingMpPayment:623) → badge "Sucursal" contradice al modal ("Cobrar al cartero"). Señal correcta: solo `calle === 'A sucursal'`.
- `ChatSidebarItem.jsx:154-157` — badge de no-leídos lee `chat.unread` pero el campo real es `unreadCount` → **el contador nunca se renderiza**. Ojo al arreglar: useChat.js:213 incrementa también con mensajes del bot/admin (número quedaría inflado).
- `useChat.js:140-233` — `handleNewLog` ignora `data.sellerId` → un admin viendo seller X recibiría chats/mensajes de seller Y (invisible hoy con 1 seller; bug multi-tenant latente).
- `CorporateDashboard.jsx:238-249` — botón "Aprobar" de alertas postea manual-complete SIN `preview:true` → si el backend extrae los datos, crea orden + manda WhatsApp salteando el modal de verificación obligatorio → transferencias aprobadas por alerta quedan "Sin verificar". Y cuando cae al modal vía 422, el prefill no trae prices/total → modal muestra Total "—" y el precio se calcula server-side a ciegas.
- `CommsView.jsx:222-229` — `formatScriptMessage` con **precios hardcodeados como fallback** ('46.900', '66.900'…): si /api/prices falla, el panel de guión rellena {{PRICE_*}} con valores fijos que el admin puede enviar al cliente. Viola "NUNCA inventar precios en código". Fallback correcto: dejar placeholder o bloquear inserción.
- `CommsView.jsx:465-472,675` — `selectedChat` es copia congelada: si el bot se auto-pausa server-side con el chat abierto, el header sigue "Auto-bot activo" y los guards deciden sobre `isPaused` viejo. Derivar del array `chats`.

**BUGS BAJA:**
- `CorporateDashboard.jsx:159-169` — listeners `new_alert`/`alerts_updated` anónimos sin cleanup → se acumulan duplicados con cada switch de seller (hoy solo llamadas redundantes idénticas).
- `ManualOrderEntryModal.jsx:88` — checkbox `paymentVerified` no se resetea al cambiar método de pago → transferencia→MP→transferencia lo deja tildado en silencio. Resetear en handleField.

**MUERTO (baja):**
- `SellerSelector.jsx` — 0 importadores (quedó del cambio a un solo vendedor).
- `WaitingCustomersPanel.jsx` — 0 importadores Y roto por partida doble (llama `/api/chat/...` que no existe → 404; axios crudo sin interceptores). Borrar o recablear. [OJO: el endpoint backend `/waiting-customers` SÍ está vivo por agent.js]
- `CommsView.jsx:26` y `SalesView.jsx:119` — prop `initialSearch` que ningún caller pasa.

**MEJORAS (media):**
- `SalesView.jsx:220-234` — "Exportar CSV" exporta solo la página actual (máx 50 filas) sin avisarlo; y no incluye método de pago ni verificación. Pedir al backend todas las filas con filtros (soporta limit 500).
- `PlaygroundView.jsx:40` — playground arranca con `model:'gpt'` por defecto, pero prod corre 100% Claude → se valida el guión contra el motor equivocado. Default: 'claude'.

**Verificado sin hallazgo**: reset del modal al abrir/cerrar OK; contrato del submit vs /orders/manual-complete OK; acople envío↔pago OK; carrera socket-vs-fetch de useChat manejada; cleanups de SettingsView/GuionView/PaymentsView/useOrders/SellerContext correctos.

---

## Resumen ejecutivo (las 5 áreas)

**Arreglar YA (afectan ventas/plata/seguridad hoy):**
1. Confirmación fantasma de pedidos (flows — regex sin anclar, `stepWaitingFinalConfirmation.ts:115`).
2. Descuento de junio vigente en julio (services — **decisión de negocio pendiente del usuario**).
3. Cache IA cruza total/nombre entre clientes en fallback OpenAI (`ai.ts:1114`).
4. Recursión infinita re-engagement + ad re-entry (`salesFlow.ts:389` + `stepGreeting.ts:38`).
5. Audios de clientes públicos sin auth (`server.js:89`).
6. Escalación seller→admin vía `/agent/installer` (`admin.routes.js:203`).
7. "Pausar todos" roto 403 siempre (`system.routes.js:467`).
8. Toast no memoizado → loops de refetch + Playground se auto-borra (`Toast.jsx:52`).

**Decisiones del usuario pendientes:**
- ¿Descuento de junio venció o se extendió? (define el fix de `_JUNE_DISCOUNT` + prompt)
- ¿Modelo tenant-admin: scoped a su seller o supervisor global? (define fix de switch-seller + sellerContext + useChat)
- ¿Borrar `Herbalis_Setup.bat`?

**Segunda tanda (media):** negaciones en submenú de pago, multi-unidad en confirmación final, partialAddress borrado, precio viejo en maps, safety regex ñ, !pausados/paymentLink sin instanceId, pausa invisible stage 2, timezone doble conteo stats + heatmap +6h, breaker OpenAI global, mp-link sin ownership check, new_order status hardcodeado, badge Sucursal COD-seña, unreadCount, Aprobar alertas saltea verificación, precios hardcodeados en CommsView, selectedChat congelado.

**Limpieza (cuando se quiera):** PII txt + gitignore, cdp-eval.js, docs/_render-*, checkStaleUsers y demás muertos, deps sin usar, git rm --cached de artefactos pre-regla, CLAUDE.md "9 suites"→31.

---

## Fase de arreglos (24-jul, aprobada por el usuario)

**Decisiones del usuario:** quitar descuento de junio; modelo mono-seller (solo horacio, único admin — sin redesign tenant-admin, solo fixes puntuales de seguridad); borrar Herbalis_Setup.bat; arreglar todo lo demás.

**Limpieza (Batch E) — HECHA:**
- [x] PII: los 4 .txt movidos a `backups/pii-2026-07/` (gitignoreado) — ahí quedan las listas de ventas pendientes de Horacio por si las necesita.
- [x] Borrados: agent/cdp-eval.js, docs/_render-*.js (3), docs/bot-vs-horacio.html, docs/reglas-pago-envio.html.
- [x] .gitignore: + ventas-horacio*.txt, conversaciones-*.txt, agent/cdp-eval.js, docs/_render-*.js.
- [x] git rm --cached: docs/V5_vs_V6_comparison.pdf, logs/report_2026-02-13.md, logs/report_2026-02-16.md.
- [x] git rm Herbalis_Setup.bat.
- [x] git mv scripts/generate-guion-v5-v6-pdfs.js → archive/scripts/.
- [x] Deps: raíz sin supertest, @types/bcryptjs+jsonwebtoken+node-cron movidos a devDeps; client sin jspdf/@xyflow/react/@tanstack/react-table/date-fns. Lockfiles sincronizados.
- [x] CLAUDE.md: "9 suites" → "31 suites".

**Agentes de arreglo (corriendo en paralelo):**
- [x] Batch A — flows — **HECHO 13/13**. Notas: _isAffirmative ganó "confirmo/confirmado/correcto/acepto" como mensaje entero; negaciones cubiertas también en el combo retiro+transferencia (misma clase de bug, no listado); recursión corta en depth 3 con _pauseAndAlert; rebuttals reformulados a "reservar el pedido" (2 del tier 1 tenían la misma modalidad prohibida). Tests actualizados: complex_sales (conservar partialAddress), improvements (sin consultativeSale), objection_escalation (not.toMatch congelar precio).

**Retoques finales (main session):**
- [x] `stepWaitingFinalConfirmation.ts` — guard `pendingOrder` null → `_pauseAndAlert` en ambas ramas de confirmación (estricta e IA) — la mejora que no estaba asignada a ningún batch.
- [x] `scheduler.ts:39` — tipo de `sendMessageWithDelay` en SchedulerDependencies corregido a `Promise<boolean>` → los 6 TS1345 "preexistentes" eliminados; **tsc del proyecto ahora da CERO errores**.
- [x] `validation.ts:21` — "no" suelto agregado a la blacklist de _isAffirmative ("no, dale de baja" matcheaba \bdale\b y confirmaba).
- [x] Stash residual del incidente: ya lo había dropeado el agente de services; el drop accidental de un stash viejo ("WIP on botConMp") fue restaurado por SHA — stash list intacta (3 entradas).

**VERIFICACIÓN FINAL:**
- `npx tsc --noEmit` → **0 errores** en todo el proyecto.
- `npm test` → 30 suites passed, 332 tests OK; única falla: address.test.js con los 6 fails PREEXISTENTES (OpenAI local sin cuota, 429). Re-run de las 5 suites de flujo tras retoques: 111/111 verdes.
- `client npm run build` → OK (verificado por el agente del client).
- Diff total: 59 archivos, +693/−2311 líneas. pricing.ts y validation.ts revisados a mano.

**DEPLOYADO 24-jul ~12:30 UTC** — commits `b27263a` (limpieza) + `4046d3d` (fixes) pusheados a main; container `707c176347f1` verificado: boot OK, horacio conectado en 8s, los 14 crons del scheduler registrados, sin errores. Los precios volvieron a base (sin descuento junio) desde este deploy.

**Riesgos residuales / pendientes post-deploy:** cargar saldo OpenAI (los 6 fails de address.test.js y el SEM-CACHE muerto dependen de eso — usuario dijo "de momento no").

## Cierre de pendientes (24-jul tarde)

- [x] **Audios viejos públicos: RESUELTO SOLO.** El volumen persistente de Railway está montado solo en `/app/data`; `public/media/audio` es filesystem efímero → el deploy del mediodía borró todos los audios con nombre adivinable. Los nuevos ya nacen con nombre no adivinable.
- [x] **Instalador del agente: fix definitivo.** Prod tiene solo 2 cuentas, ambas admin (horacio activa, cristian inactiva) y `sellerId` es `@unique` → imposible crear cuenta seller paralela. El endpoint ahora busca cualquier cuenta activa del sellerId pero **firma el token SIEMPRE con `role:'seller'`** (mínimo privilegio). Verificado: el panel del agente solo usa endpoints de nivel seller (la mención a /api/agent/update en agent.js es un comentario — ese push llega por websocket).
- [x] **Link MP conservado en rechazo (fix de raíz).** `stepWaitingMpPayment` ya NO nullea `mpPaymentLinkId/Url` cuando un pago se rechaza: la preferencia sigue vigente y el reintento va por el mismo checkout (se re-manda el mismo link). Antes se regeneraba otro link y el cliente pagaba en la pestaña vieja → mismatch "link no vigente". Test nuevo [8.5] en payment_flow (95/95 verdes).
- [x] **Leak de crons del scheduler (commit 03759c8, integrado de la sesión worktree).** startScheduler ahora devuelve `SchedulerHandle{stop()}`; clientPool lo frena en stopSeller (antes del flush), recovery tras init fallido, y wipeSessionAndRestart. Sin esto cada restartSeller acumulaba otro juego de crons sobre sharedState viejo. Worktree `infallible-allen-b8c810` y su rama eliminados. tsc 0 errores; scheduler_window 7/7; suite 30 verdes (address.test.js: 6 fails preexistentes por OpenAI).

## Botón "Solo registrar" (reporte de Horacio, 24-jul tarde)
Diagnóstico: NO es bug de código. Backend y front deployados correctos (previews de las 12:55 procesados OK, sin errores en logs, 0 órdenes creadas porque nadie confirmó el modal). Causa probable: SPA con bundle viejo cacheado (3 deploys hoy). Acción: pedir a Horacio Ctrl+Shift+R. Cambio de comportamiento intencional desde ayer: "Solo registrar" ya NO registra directo — abre SIEMPRE el modal de verificación primero. Pendiente confirmar con Horacio qué ve exactamente tras el refresh.
- [x] Batch B — services — **HECHO 17/17**. Notas: descuento de junio ELIMINADO (pricing.ts + prompt de ai.ts; precios vuelven a base; el prompt ahora dice "hoy NO hay ninguna promo vigente"; knowledge_v7.json no lo mencionaba); cache OpenAI keyed por userPrompt completo (incluye historial+estado); `getArgentinaMidnight()` nuevo en timeUtils usado por snapshotDailyStats y !stats; breaker per-seller threaded (llamadores de handlers/flows quedan en 'global' hasta pasar el param); stage 2 MP pausa vía pauseService; queueService ya no crea la Queue Redis fantasma al importar; tests actualizados: sim_horacio_jun21 (52.900→62.900). tsc: solo los 6 TS1345 preexistentes de scheduler, cero nuevos. **INCIDENTE**: el agente hizo `git stash` que barrió trabajo sin commitear de las sesiones paralelas; restaurado completo (verificado a mano después: todos los batches presentes; hubo que rehacer el `git rm --cached` de los 3 artefactos, que perdió el staging).
- [x] Batch C — api/handlers — **HECHO 15/15**. Notas: audios nuevos con nombre no adivinable (messageHandler: `aud_<ts>_<uuid>`; chat.routes /history: HMAC determinístico para no romper la idempotencia de descarga); `/api/health` y `/logout` y `/scan` eliminados; SPA fallback ahora 404 JSON para /api/*; switch-seller validado contra `clientPool.isKnown()`; `_cleanPhone` aplicado también en cancelLatestOrder:194 (3er sitio no listado); resolveChatId eran 9 call sites (no 8). **Riesgos residuales**: (1) audios VIEJOS `<telefono>_<ts>.ogg` siguen públicos/adivinables en public/media/audio — migrar/borrar en prod si se quiere cerrar del todo; (2) si en prod horacio solo tiene cuenta role='admin', `GET /agent/installer` ahora da 404 hasta crear cuenta role='seller' activa — **verificar cuentas en prod DB antes de regenerar el instalador**; (3) primer fetch de /history re-descarga audios una vez bajo el nombre nuevo.
- [x] Batch D — client — **HECHO 13/13, build OK** (2560 módulos; warning chunk >500kB preexistente). Notas: Toast memoizado (raíz de los loops); Playground default 'claude'; unreadCount solo incrementa con sender 'user'; "Aprobar" alertas ahora SIEMPRE preview:true + modal (el prefill del backend ya traía prices/total — sin carga extra); CSV hasta 500 filas con filtros + columnas método pago/verificación; selectedChat derivado del array chats (id + useMemo); SellerSelector.jsx y WaitingCustomersPanel.jsx borrados. Queda un "46.900" solo como placeholder visual de un input (nunca se inserta).

**Al terminar los 4:** `npx tsc --noEmit` (solo errores nuevos), `npm test` completo (recordar: address.test.js tiene 6 fails preexistentes por OpenAI local), revisar diff completo, commitear. Pendiente preguntar al usuario si push/deploy.

### Área 5 — código muerto transversal ✅

**Sin huérfanos en src/**: los 76 archivos .ts/.js tienen cadena de imports viva (los `index.ts` de globals/steps se importan como directorio; `db.js`, `safeWrite.js`, `analyze_day.js`, `knowledge_v7.json` todos referenciados).

**Exports muertos:**
- `scheduler.ts:198` — `checkStaleUsers`: exportada, **0 llamadas en todo el repo** (ningún cron la registra, nadie la importa). ~100 líneas muertas. → eliminar.
- `scheduler.ts` — `cleanStalePausedUsers`, `snapshotDailyStats`, `reconcileWebOrders`: solo uso interno (crons); export sin consumidores. Trivial: sacar del export.
- `ai.ts` — interfaces `APIContext` y `AIParsedResponse` exportadas sin importadores externos. Trivial.

**Archivos sueltos / PII (untracked salvo indicación):**
- `agent/cdp-eval.js` — su header dice "borrar tras la verificación"; el go-live pasó. → borrar.
- **PII sin gitignorear**: `conversaciones-resto-hoy.txt`, `ventas-horacio.txt`, `ventas-horacio-intentos.txt`, `ventas-horacio-pendientes.txt` — teléfonos/conversaciones reales de clientes. Nunca commiteados (verificado con git log --all) pero a un `git add .` de filtrarse. → borrar o mover fuera del repo + gitignorar `ventas-horacio*.txt` y `conversaciones-*.txt`.
- `docs/_render-pdf.js`, `docs/_render-bot-vs-horacio.js`, `docs/_render-sim-compare.js` — scripts one-off de sesiones de análisis; `_render-sim-compare.js` hardcodea un scratchpad de sesión vieja (no puede volver a correr). → borrar.
- `docs/bot-vs-horacio.html`, `docs/reglas-pago-envio.html` — insumos generados. → borrar.
- `docs/V5_vs_V6_comparison.pdf`, `logs/report_2026-02-13.md`, `logs/report_2026-02-16.md` — **trackeados** a pesar de reglas `*.pdf`/`logs/` (pre-regla). → `git rm --cached`.
- `Herbalis_Setup.bat` (trackeado) — 0 referencias; instalador viejo reemplazado por `agent/installer`. → borrar (confirmar con usuario).

**Deps sin usar (0 referencias verificadas):**
- Raíz: `supertest` (dev).
- client/: `jspdf`, `@xyflow/react`, `@tanstack/react-table`, `date-fns` (en raíz date-fns SÍ se usa).
- Misplaced: `@types/bcryptjs`, `@types/jsonwebtoken`, `@types/node-cron` en dependencies → mover a devDependencies.
- NO tocar (verificadas en uso): proxy-chain, uuid, node-cache, ws, compression, helmet, express-rate-limit, qrcode-terminal, envalid, mercadopago, @anthropic-ai/sdk, date-fns-tz, tailwind-scrollbar.

**Tests:** ninguna suite muerta (31 suites, todos los requires existen; único fixture externo knowledge_v7.json presente). Cruft inofensivo: 6 suites mockean con `{virtual:true}` módulos que ya no existen (sheets_sync, google-spreadsheet, @google/generative-ai). Doc stale: CLAUDE.md dice "9 suites" y hay 31.

**archive/:** NO borrar — `system.routes.js` (~626-660, `GET /script/:version`) sirve knowledge v1-v6 desde archive/ en runtime. Colateral: `scripts/generate-guion-v5-v6-pdfs.js` roto (lee knowledge_v5/v6 desde raíz, ya solo están en archive/). → borrar o archivar.

**Acciones recomendadas (resumen):**
1. Borrar untracked: agent/cdp-eval.js, docs/_render-*.js, docs/bot-vs-horacio.html, docs/reglas-pago-envio.html.
2. PII: borrar/mover los 4 .txt + gitignorar patrones.
3. `git rm --cached` los 3 artefactos pre-regla.
4. Eliminar `checkStaleUsers` del scheduler.
5. `npm uninstall supertest` (raíz); en client: jspdf @xyflow/react @tanstack/react-table date-fns; mover @types/* a devDeps.
6. Borrar/archivar scripts/generate-guion-v5-v6-pdfs.js.
7. Con confirmación: borrar Herbalis_Setup.bat; actualizar conteo de suites en CLAUDE.md.

## Pendientes previos (no de esta revisión, para no perderlos)

- Usuario: cargar saldo OpenAI (platform.openai.com) — embeddings/Whisper siguen OpenAI-only.
- Horacio: recargar ventas fallidas del 23-jul (5493754570015, 5492995936680, 5491164163569) y responder a Rosa (5492994553847).
- Otra sesión: detener crons del scheduler en stopSeller (task en worktree aparte).
- Sugerencia no implementada: no nullear `mpPaymentLinkId` al rechazarse un pago (fix de raíz para pagos sobre links viejos).
- Archivos sueltos sin decidir: `docs/_render-*.js`, `docs/*.html` generados, `agent/cdp-eval.js` (su header dice borrarlo), `ventas-horacio*.txt` / `conversaciones-resto-hoy.txt` (PII — no commitear).
