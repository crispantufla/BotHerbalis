import { UserState, FlowStep, SharedState, BotConfig } from '../types/state';
import { pauseUser } from '../services/pauseService';
import logger from '../utils/logger';
import { processGlobals } from './globals';
import { processStep } from './steps';
import { _pauseAndAlert, _setStep, _extractSilentVariables, _cleanPhone, _isGhostClose } from './utils/flowHelpers';
import { detectObjection } from './utils/objectionDetector';
import { parseControlTag } from './utils/extractedData';

interface SalesFlowDependencies {
    saveState: (userId?: string) => void;
    client?: Record<string, any>;
    sharedState?: SharedState;
    notifyAdmin?: (reason: string, userPhone: string, details?: string | null) => Promise<void>;
    aiService?: Record<string, any>;
    sendMessageWithDelay?: (chatId: string, content: string, startTime?: number) => Promise<void>;
    logAndEmit?: (chatId: string, sender: string, text: string, step?: string) => void;
    saveOrderToLocal?: (order: Record<string, unknown>) => void;
    cancelLatestOrder?: (userId: string) => Promise<Record<string, unknown>>;
    config?: BotConfig;
    effectiveScript?: string;
    connectedAt?: number; // Unix timestamp (seconds) of when the bot connected — used to detect pre-existing chats
    sellerId?: string; // seller identity for scoped DB queries
}

// Ad source detection from pre-filled Click-to-WhatsApp messages (literal match)
const AD_SOURCES: { text: string; name: string }[] = [
    { text: '¡Hola! Quiero más información', name: 'anuncio_1' },
    { text: '¡Hola! Me gustaría conseguir más información sobre esto.', name: 'anuncio_2' }
];

function _detectAdSource(text: string): string | null {
    const trimmed = text.trim();
    for (const ad of AD_SOURCES) {
        if (trimmed === ad.text) return ad.name;
    }
    return null;
}

// Keywords that signal clear purchase intent — if present, don't auto-pause
// Note: normalizedText is accent-stripped, so only unaccented variants are needed
const PURCHASE_INTENT_KEYWORDS = /\b(comprar|quiero comprar|quiero pedir|me interesa|precio|precios|cuanto sale|cuanto cuesta|quiero encargar|necesito comprar|hagan envios|hacen envios|quisiera pedir|quisiera comprar|quiero adquirir|quiero ordenar|tienen capsulas|tienen semillas|tienen gotas|nuez de la india|la direccion|mi direccion|te paso mis datos|mis datos|los datos|te paso la direccion|informacion|quiero saber|quiero mas info|bajar|adelgazar|kilos|kilo|capsulas|semillas|cemillas|semilla|gotas|gota|peso|perder peso|bajar de peso|10 kg|20 kg|mas de 20)\b/i;

export async function processSalesFlow(
    userId: string,
    text: string,
    userState: Record<string, UserState>,
    knowledge: Record<string, any>,
    dependencies: SalesFlowDependencies,
    _recursionDepth: number = 0
): Promise<{ matched: boolean; paused?: boolean } | void> {
    const { saveState } = dependencies;

    // Remove accents and lowercase
    const normalizedText = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // 1. Initialization
    if (!userState[userId]) {
        logger.info(`[STATE] Initializing new internal state for user ${userId}`);
        userState[userId] = {
            step: knowledge.flow.greeting ? 'greeting' : 'completed',
            history: [],
            cart: [],
            summary: "",
            partialAddress: {},
            selectedProduct: null,
            selectedPlan: null,
            geoRejected: false,
            stepEnteredAt: Date.now(),
            addressAttempts: 0,
            fieldReaskCount: {},
            lastAddressMsg: null,
            postdatado: null,
            pendingOrder: null,
            currentWeight: undefined,
            consultativeSale: false,
            lastActivityAt: Date.now(),
            adSource: _detectAdSource(text),
            // Freeze the A/B assignment on first message so subsequent messages
            // don't re-roll the variant mid-conversation under 'rotacion' mode.
            assignedScript: dependencies.effectiveScript
        };

        // --- CHECK 1: Cross-reference against Orders DB ---
        // Si el phone tiene Order en este seller O en el namespace legacy
        // (__legacy_import__ — clientes históricos importados desde Clientes_AR.txt),
        // es un cliente conocido → ruta post-sale para que el bot no le hable.
        try {
            const { prisma } = require('../../db');
            const cleanPhone = _cleanPhone(userId);
            const instanceId = dependencies.sellerId || dependencies.sharedState?.sellerId || process.env.INSTANCE_ID || 'default';
            const existingOrder = await prisma.order.findFirst({
                where: {
                    userPhone: cleanPhone,
                    instanceId: { in: [instanceId, '__legacy_import__'] },
                },
                orderBy: { createdAt: 'desc' }
            });

            if (existingOrder) {
                const isLegacy = existingOrder.instanceId === '__legacy_import__';
                if (isLegacy) {
                    // Contacto del padrón histórico importado (Clientes_AR.txt,
                    // __legacy_import__): es un CLIENTE VIEJO, no un lead nuevo. El bot
                    // NO lo atiende (ni saludo ni flujo de venta): se PAUSA y se alerta
                    // al admin para que lo tome un humano. (rev 2026-06-04, reporte
                    // 5493564578992 — antes el match amplio de PURCHASE_INTENT_KEYWORDS
                    // lo mandaba a waiting_weight y la IA respondía "de nuevo, ¿cuántos
                    // kilos?" en vez de derivarlo.)
                    logger.info(`[ORDER-CHECK] User ${userId} es cliente del padrón histórico (import legacy) → mensaje de derivación + pausa + alerta admin.`);
                    // Mensaje al cliente: avisarle que se lo deriva a una oficial de
                    // atención (no dejarlo en visto). Después se pausa para que lo tome
                    // un humano (rev 2026-06-04).
                    const derivMsg = 'Teniendo en cuenta que ya sos cliente, te derivo con una oficial de atención al cliente que te va a ayudar enseguida 😊';
                    if (!userState[userId].history) userState[userId].history = [];
                    userState[userId].history.push({ role: 'bot', content: derivMsg, timestamp: Date.now() });
                    await dependencies.sendMessageWithDelay(userId, derivMsg);
                    await pauseUser(
                        userId,
                        '📇 Cliente del padrón histórico (import)',
                        { sharedState: dependencies.sharedState, notifyAdmin: dependencies.notifyAdmin },
                        `Teléfono del import histórico (Clientes_AR.txt). Volvió a escribir: "${text.substring(0, 100)}". Se le avisó la derivación y se pausó para atención humana.`
                    );
                    return { matched: true, paused: true };
                } else {
                    const showsPurchaseIntent = PURCHASE_INTENT_KEYWORDS.test(normalizedText);
                    if (showsPurchaseIntent) {
                        // Comprador real que VUELVE con intención de compra (pidió precio,
                        // quiere comprar, etc.): NO lo pausamos como post-venta — es el
                        // lead más tibio que hay. Lo atendemos como recompra pero SIN la
                        // presentación (ya nos conoce): saltamos el greeting yendo directo
                        // a waiting_weight, y el step responde su consulta.
                        logger.info(`[ORDER-CHECK] User ${userId} es comprador real y muestra intención de compra → atender como recompra (sin presentación).`);
                        _setStep(userState[userId], FlowStep.WAITING_WEIGHT);
                        (userState[userId] as any).isReturningClient = true;
                        saveState(userId);
                        // Don't return — continúa el flujo normal de venta.
                    } else {
                        logger.info(`[ORDER-CHECK] User ${userId} has existing order (status: ${existingOrder.status}). Routing to post-sale.`);
                        _setStep(userState[userId], FlowStep.COMPLETED);
                        userState[userId].selectedProduct = existingOrder.products;
                        saveState(userId);
                        // Don't return — let the flow continue into stepCompleted handler below
                    }
                }
            }
        } catch (err: any) {
            logger.error(`[ORDER-CHECK] Failed to query orders for ${userId}:`, err.message);
        }

        // --- CHECK 2: WhatsApp Chat History Detection ---
        // Only run this if we didn't already route to post-sale via Orders
        if (userState[userId].step !== 'completed') {
            try {
                const { prisma } = require('../../db');
                const INSTANCE_ID = dependencies.sellerId || dependencies.sharedState?.sellerId || process.env.INSTANCE_ID || 'default';
                const cleanPhone = _cleanPhone(userId);

                // Grab the last 15 messages from DB for this seller
                let dbMessages = await prisma.chatLog.findMany({
                    where: { userPhone: cleanPhone, instanceId: INSTANCE_ID },
                    orderBy: { timestamp: 'desc' },
                    take: 15
                });

                // Fallback to WhatsApp's native API if local DB has NO history
                if (dbMessages.length === 0 && dependencies.client) {
                    try {
                        const chat = await dependencies.client.getChatById(userId);
                        if (chat) {
                            const waMsgs = await chat.fetchMessages({ limit: 15 });
                            const waMapped = waMsgs.map((wm: any) => ({
                                id: wm.id._serialized,
                                userPhone: cleanPhone,
                                instanceId: INSTANCE_ID,
                                role: wm.fromMe ? 'bot' : 'user',
                                content: wm.body || '',
                                timestamp: new Date(wm.timestamp * 1000)
                            }));
                            // Reverse to match DB descending order (latest first)
                            dbMessages = waMapped.reverse();
                            logger.info(`[SMART-DETECT] DB vacío para ${userId}. Recuperados ${waMapped.length} msjs nativos de WhatsApp.`);

                            // --- CHECK 2b: Pre-existing chat detection ---
                            // whatsapp-web.js does NOT sync old message bodies on a fresh session,
                            // so fetchMessages() returns [] for old chats until the chat is opened manually.
                            // However, chat.lastMessage.timestamp IS available immediately (it's metadata).
                            // If that timestamp predates our bot's connection → pre-existing conversation → pause.
                            if (waMsgs.length === 0 && dependencies.connectedAt) {
                                try {
                                    const lastTs: number | undefined = chat?.lastMessage?.timestamp; // Unix seconds
                                    if (lastTs && lastTs < dependencies.connectedAt) {
                                        logger.info(`[PRE-EXISTING] User ${userId}: last chat msg at ${new Date(lastTs * 1000).toISOString()}, bot connected at ${new Date(dependencies.connectedAt * 1000).toISOString()}. Auto-pausing.`);
                                        await pauseUser(
                                            userId,
                                            '📋 Conversación pre-existente (anterior al bot)',
                                            { sharedState: dependencies.sharedState, notifyAdmin: dependencies.notifyAdmin },
                                            `Conversación iniciada antes de que el bot se conectara. Último mensaje: ${new Date(lastTs * 1000).toLocaleString('es-AR')}`
                                        );
                                        return { matched: true, paused: true };
                                    }
                                } catch (metaErr: any) {
                                    logger.warn(`[PRE-EXISTING] Could not read chat metadata for ${userId}: ${metaErr.message}`);
                                }
                            }
                        }
                    } catch (waErr: any) {
                        logger.warn(`[SMART-DETECT] Error recuperando historial nativo WA de ${userId}: ${waErr.message}`);
                    }
                }

                // Check for existence of any prior post-sale outgoing message
                const outgoingMessages = dbMessages.filter((m: any) => m.role === 'bot' || m.role === 'admin' || m.role === 'system');
                const hasPostSaleMessage = outgoingMessages.some((m: any) => {
                    const body = (m.content || '').trim().toUpperCase();
                    if (body.includes('MENSAJE DE HERBALIS')) return true;
                    if (body.includes('CONFIRMACIÓN DE ENVÍO') || body.includes('CONFIRMACION DE ENVIO')) return true;
                    if (body.includes('PEDIDO INGRESADO')) return true;
                    if (/^CO\d{9}$/i.test(body)) return true;
                    return false;
                });

                if (hasPostSaleMessage) {
                    logger.info(`[POST-SALE] User ${userId} has post-sale messages in local DB. Auto-pausing.`);
                    await pauseUser(userId, '📦 Cliente post-venta (historial en DB)', { sharedState: dependencies.sharedState, notifyAdmin: dependencies.notifyAdmin }, `El usuario tiene mensajes post-venta en el historial. No ha iniciado conversación nueva.`);
                    return { matched: true, paused: true };
                }

                // If no post-sale message exists, let's see if there's extensive prior interaction
                // 1-4 outgoing = likely bots replying to ads. 5+ means extensive interaction history.
                const hasSignificantHistory = outgoingMessages.length >= 5;

                if (hasSignificantHistory) {
                    const showsPurchaseIntent = PURCHASE_INTENT_KEYWORDS.test(normalizedText);

                    if (showsPurchaseIntent) {
                        logger.info(`[SMART-DETECT] User ${userId} has prior history (outgoing bot: ${outgoingMessages.length}) but shows purchase intent. Allowing sales flow.`);
                    } else {
                        const reason = `😴 Cliente con historial extenso (${outgoingMessages.length}+ mensajes)`;
                        logger.info(`[SMART-DETECT] User ${userId}: has ${outgoingMessages.length} msgs and NO purchase intent. Auto-pausing.`);
                        await pauseUser(
                            userId,
                            reason,
                            { sharedState: dependencies.sharedState, notifyAdmin: dependencies.notifyAdmin },
                            `${outgoingMessages.length} mensajes previos. Volvió a escribir: "${text.substring(0, 100)}"`
                        );
                        return { matched: true, paused: true };
                    }
                } else if (outgoingMessages.length > 0) {
                    logger.info(`[SMART-DETECT] User ${userId} has ${outgoingMessages.length} prior message(s) (< 10 threshold) in DB. Treating as active prospect.`);
                }
            } catch (err: any) {
                logger.error(`[SMART-DETECT] Failed to fetch local chat history DB for ${userId}:`, err.message);
            }
        }
    }
    saveState(userId);

    const currentState = userState[userId];

    // Tag de control de IA por-turno (lo setea el proxy de chat más abajo si la
    // IA emite REJECT_MEDICAL). Se limpia al inicio de cada turno para que un tag
    // de un turno previo (ej: que terminó en pausa) no dispare falsamente.
    (currentState as any)._aiControlTag = null;

    // Stash identity on state so _setStep / _pauseAndAlert pueden loguear
    // transiciones de funnel a DB sin cambiar las 59 firmas que ya existen.
    const _ctx = {
        sellerId: dependencies.sellerId || (dependencies.sharedState as any)?.sellerId || process.env.INSTANCE_ID || 'default',
        phone: _cleanPhone(userId),
    };
    (currentState as any)._ctx = _ctx;

    // Envuelvo aiService.chat para inyectar sellerId/phone en APIContext y que
    // ai.ts pueda registrar cada llamada a AI contra el FunnelEvent abierto.
    // Se hace en una copia local de dependencies para NO contaminar al worker.
    const origAi = dependencies.aiService;
    if (origAi && typeof origAi.chat === 'function') {
        const wrappedAi = new Proxy(origAi, {
            get(target: any, prop: string) {
                if (prop === 'chat') {
                    return async (text: string, context: any) => {
                        const res = await target.chat(text, { ...context, sellerId: _ctx.sellerId, phone: _ctx.phone });
                        // Routing robusto e independiente del modelo: Claude puede parafrasear
                        // la prosa, así que el control de flujo CRÍTICO (rechazo médico, abuso,
                        // cancelación, reventa) se rige por el TAG de extractedData, no por el
                        // texto. Lo stasheamos en el state para que el post-procesado lo lea.
                        // (Antes los tags se emitían pero nadie los consumía: el único
                        // disparador era un substring exacto, frágil tras la migración a Claude.)
                        try {
                            const tag = parseControlTag(res?.extractedData);
                            if (tag) (currentState as any)._aiControlTag = tag;
                        } catch { /* noop */ }
                        return res;
                    };
                }
                const v = target[prop];
                return typeof v === 'function' ? v.bind(target) : v;
            },
        });
        dependencies = { ...dependencies, aiService: wrappedAi };
    }

    // --- NEW REQUIREMENT (Unconditional Post-Sale Stop) ---
    // If the user's step is 'completed', it means they are a past customer.
    // Pause immediately and alert admin if not already paused.
    if (currentState.step === 'completed') {
        const isAlreadyPaused = dependencies.sharedState?.pausedUsers?.has(userId);

        // Save User message in history regardless
        if (!currentState.history) currentState.history = [];
        currentState.history.push({ role: 'user', content: text, timestamp: Date.now() });
        saveState(userId);

        if (!isAlreadyPaused && currentState.step === 'completed') {
            await pauseUser(
                userId,
                '👤 Cliente post-venta',
                { sharedState: dependencies.sharedState, notifyAdmin: dependencies.notifyAdmin },
                `El cliente ya compró y volvió a escribir.\n\nMensaje: "${text}"\n\nEl bot se pausó automáticamente.`
            );
        } else {
            logger.info(`[HARD STOP] User ${userId} is past customer. Already paused. Ignoring silently.`);
        }

        return { matched: true, paused: true };
    }

    // Safety fallback for empty history
    if (!currentState.history) currentState.history = [];

    // Defensive cap: prevent unbounded history growth (keep last 150 for AI context)
    if (currentState.history.length > 250) {
        currentState.history = currentState.history.slice(-150);
    }

    // Save User message and update activity timestamp
    currentState.history.push({ role: 'user', content: text, timestamp: Date.now() });
    currentState.lastActivityAt = Date.now();
    saveState(userId);

    // 1.4. Name extraction is handled by AI (parseAddress) in waiting_data.
    // This avoids false positives like treating "soy jubilada" as a person's name.

    // 1.5. Silent Variable Extraction (Age/Weight out of band)
    // NOTE: We intentionally exclude 'waiting_weight' because in that step the user IS answering
    // the weight question — intercepting it here would send "¡Anotado!" instead of advancing the flow.
    const activeSteps = ['waiting_preference', 'waiting_preference_consultation', 'waiting_plan_choice', 'waiting_ok', 'waiting_payment_method', 'waiting_mp_payment', 'waiting_data'];
    if (activeSteps.includes(currentState.step)) {
        const extraction = _extractSilentVariables(normalizedText, currentState);
        if (extraction.ageUpdated || extraction.weightUpdated) {
            saveState(userId);
            // If the user's message was merely "tengo 40 años" we don't want to confuse the AI
            // We just ACK and repeat the state's main question if it was merely a correction
            if (extraction.isSolelyCorrection) {
                logger.info(`[GLOBAL EXTRACTION] Intercepted sole correction for ${userId}. Age:${extraction.ageUpdated ?? false}, Weight:${extraction.weightUpdated ?? false}`);
                let ackMsg = "¡Anotado! 😊\n\nEntonces, decime...";

                // Customize the re-prompt based on the step we are stalled in
                switch (currentState.step) {
                    case 'waiting_plan_choice':
                        ackMsg += " ¿preferías avanzar con el plan de 60 o el de 120 días?";
                        break;
                    case 'waiting_preference':
                        ackMsg += " ¿qué opción preferías probar (Cápsulas, Semillas o Gotas)?";
                        break;
                    case 'waiting_ok':
                        ackMsg += " ¿te tomo los datos para el envío?";
                        break;
                    default:
                        ackMsg = "¡Anotado! 😊 Seguimos...";
                        break;
                }

                currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
                if (dependencies.sendMessageWithDelay) {
                    await dependencies.sendMessageWithDelay(userId, ackMsg);
                }
                saveState(userId);
                return; // HALT further processing
            }
        }
    }

    // Re-entry desde anuncio sin peso registrado (reporte 2026-05-27): un cliente
    // que retoma desde un click-to-WhatsApp y NO había dado kilos en sesión previa
    // debe volver al saludo. Sin este reset, stepWaitingWeight quedaba mascando
    // "Quiero más información" sin tier y la IA alucinaba un weightGoal.
    if (_detectAdSource(text) && !currentState.weightGoal && currentState.step !== 'greeting') {
        logger.info(`[AD-RE-ENTRY] User ${userId} re-entró desde ${_detectAdSource(text)} sin weightGoal (step previo: ${currentState.step}). Reset a greeting.`);
        _setStep(currentState, FlowStep.GREETING);
        saveState(userId);
    }

    // 2. Execute Global Interceptors (Priority 0 and 1)
    const globalsResult = await processGlobals(userId, text, normalizedText, currentState, knowledge, dependencies);
    if (globalsResult && globalsResult.matched) {
        return; // Handled globally!
    }

    // 2.5. Centralized objection detector — intercepts common rebuttable
    // objections ("caro", "tengo que consultar", "lo pienso", etc.) with
    // una respuesta calibrada por tier:
    //   standard  → rebuttal genérico (1ra vez)
    //   escalated → rebuttal + oferta concreta (2da vez, misma categoría)
    //   pause     → cierre suave + pausa al admin (3ra vez — bot se rinde)
    const objection = detectObjection(currentState.step, normalizedText, currentState);
    if (objection) {
        logger.info(`[OBJECTION] Intercepted "${objection.type}" for ${userId} at step ${currentState.step} (tier=${objection.tier})`);
        currentState.history.push({ role: 'bot', content: objection.response, timestamp: Date.now() });
        if (dependencies.sendMessageWithDelay) {
            await dependencies.sendMessageWithDelay(userId, objection.response);
        }
        saveState(userId);
        if (objection.pauseAfter) {
            // 3ra aparición de la misma objeción → pausamos y alertamos al admin
            // con quickReplies contextuales (los maneja _getQuickReplies en messages.ts).
            await _pauseAndAlert(
                userId, currentState, dependencies, normalizedText,
                `Objeción recurrente "${objection.type}" — 3ra vez. Bot agotó los rebuttals, requiere intervención humana.`
            );
        }
        return { matched: true };
    }

    // 3. Process Specific Step Logic
    const stepResult = await processStep(userId, text, normalizedText, currentState, knowledge, dependencies);

    // Recursive safety for stale steps (max 2 retries to prevent infinite recursion)
    if (stepResult && stepResult.staleReprocess) {
        if (_recursionDepth >= 2) {
            logger.error(`[SAFETY] Max recursion depth reached for ${userId} at step "${currentState.step}". Pausing.`);
            await _pauseAndAlert(userId, currentState, dependencies, text, `Recursion limit: step "${currentState.step}" no pudo resolverse tras ${_recursionDepth} intentos.`);
            return { matched: true, paused: true };
        }
        return await processSalesFlow(userId, text, userState, knowledge, dependencies, _recursionDepth + 1);
    }

    // Analytics: registrar mensaje procesado. El uso de IA se trackea en
    // FunnelEvent.aiCallCount, incrementado directo desde ai.ts. Métrica 4
    // (caída a IA) se computa como aiCallCount / messageCount por step.
    //
    // priceObjection: detector barato por regex (palabras frecuentes en ES-AR
    // para "precio alto" / "no puedo pagar"). Los falsos positivos los lee el
    // admin en bucket y decide refinar el patrón.
    const priceObjectionRegex = /\b(caro|car[íi]simo|muy\s+caro|descuento|precio\s+alto|no\s+me\s+alcanza|no\s+tengo\s+plata|no\s+puedo\s+pagar|no\s+puedo\s+(?:comprar|hacer|costear)|costoso|muy\s+costoso|no\s+me\s+entran|no\s+me\s+da|est[aá]\s+dif[ií]cil|imposible\s+pagar|fuera\s+de\s+mi\s+presupuesto)\b/i;
    const hasPriceObjection = priceObjectionRegex.test(normalizedText);

    try {
        const { logMessage } = require('../services/funnelLogger');
        logMessage({
            sellerId: _ctx.sellerId,
            phone: _ctx.phone,
            step: currentState.step,
            matched: !!(stepResult && stepResult.matched),
            priceObjection: hasPriceObjection,
        }).catch(() => {});
    } catch (e) { /* best effort */ }

    // 4. Safety Net / Fallback
    if (!stepResult || !stepResult.matched) {
        logger.info(`[PAUSE] No match for user ${userId} at step "${currentState.step}". Pausing and alerting admin.`);
        await _pauseAndAlert(userId, currentState, dependencies, text, `Bot no pudo responder en paso "${currentState.step}".`);
        return { matched: true, paused: true };
    }

    // 5.0 Robust control-tag routing (model-independent). Los tags de control
    // que emite la IA (stasheados por el proxy de chat) rigen el flujo crítico
    // SIN depender de que el modelo reproduzca una frase exacta — clave tras la
    // migración a Claude (parafrasea). Sólo tags cuyo falso positivo es
    // recuperable y NO afecta a un comprador (médico/abuso/cancelación/reventa).
    const _controlTag = (currentState as any)._aiControlTag;
    if (_controlTag === 'REJECT_MEDICAL') {
        logger.info(`[AI MEDICAL REJECT] User ${userId} marcado REJECT_MEDICAL vía tag. Halting flow.`);
        _setStep(currentState, FlowStep.REJECTED_MEDICAL);
        (currentState as any)._aiControlTag = null;
        saveState(userId);
    } else if (_controlTag === 'ADVERSE_REACTION') {
        // El cliente reportó que el producto le hizo mal / le causó síntomas. Es un
        // tema de SALUD: el bot ya respondió derivando (vía la regla reaccion_adversa)
        // y NO debe vender. Pausamos + alertamos para atención humana. (reporte Lidia
        // 5493782465845, 2026-06-04 — el bot había upselleado sobre el reporte.)
        logger.info(`[ADVERSE-REACTION] User ${userId} reportó reacción adversa al producto. Derivo a humano.`);
        (currentState as any)._aiControlTag = null;
        await _pauseAndAlert(userId, currentState, dependencies, text, '⚠️ Cliente reporta una REACCIÓN ADVERSA al producto (tema de salud). Derivado a atención humana — NO vender, revisar el caso.');
        saveState(userId);
    } else if (_controlTag === 'ABUSE') {
        logger.info(`[ABUSE REJECT] User ${userId} marcado ABUSE vía tag. Halting flow.`);
        _setStep(currentState, FlowStep.REJECTED_ABUSIVE);
        (currentState as any)._aiControlTag = null;
        await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente insultó al bot y fue bloqueado automáticamente.');
        saveState(userId);
    } else if (_controlTag === 'CANCEL_ORDER') {
        logger.info(`[CANCEL PAUSE] User ${userId} marcado CANCEL_ORDER vía tag. Halting flow.`);
        (currentState as any)._aiControlTag = null;
        await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente desea cancelar, reclamar o derivar el caso a un humano.');
        saveState(userId);
    } else if (_controlTag === 'RESELLER') {
        logger.info(`[RESELLER PAUSE] User ${userId} marcado RESELLER vía tag. Halting flow.`);
        (currentState as any)._aiControlTag = null;
        await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente está interesado en reventa/compras por mayor. Derivado a Horacio.');
        saveState(userId);
    }

    // Si ya actuó un tag de control arriba, NO repetimos el match por prosa de
    // la misma categoría (evita doble-pausa). El rechazo genérico y la indecisión
    // NO tienen tag (son sensibles a la conversión) → siempre por prosa.
    const _controlHandled = !!_controlTag;

    // 5. Post-Processing Context Triggers Check
    if (currentState.history && currentState.history.length > 0) {
        const lastHistory = currentState.history[currentState.history.length - 1];
        if (lastHistory.role === 'bot') {
            const botMsg = lastHistory.content;

            // Fallback por prosa (flujos viejos / modelos que no emiten el tag).
            // El path robusto es el tag de arriba.
            if (!_controlHandled && currentState.step !== FlowStep.REJECTED_MEDICAL &&
                (botMsg.includes('por precaución no recomendamos el consumo') || botMsg.includes('por precaución no recomendamos el uso durante'))) {
                logger.info(`[AI MEDICAL REJECT] Intercepted AI rejection (prosa) for user ${userId}. Halting flow.`);
                _setStep(currentState, FlowStep.REJECTED_MEDICAL);
                saveState(userId);
            }

            if (!_controlHandled && botMsg.includes('Por falta de respeto damos por terminada la comunicación')) {
                logger.info(`[ABUSE REJECT] Intercepted AI abuse rejection for user ${userId}. Halting flow.`);
                await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente insultó al bot y fue bloqueado automáticamente.');
                saveState(userId);
            }

            if (botMsg.includes('Disculpá la molestia') || botMsg.includes('Disculpa la molestia') || botMsg.includes('Perdón por la molestia')) {
                logger.info(`[REJECTION] Client explicitly rejected conversation for ${userId}. Pausing.`);
                await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente rechazó la conversación explícitamente ("no quiero nada", "no me interesa", etc.).');
                saveState(userId);
            }

            if (botMsg.includes('Pensalo tranquilo y cuando estés 100% segura retomamos el pedido')) {
                logger.info(`[INDECISION PAUSE] Intercepted AI indecision limit for user ${userId}. Halting flow.`);
                await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente cruzó el umbral de indecisión/cambios. Pausa preventiva.');
                saveState(userId);
            }

            if (!_controlHandled && botMsg.includes('Voy a derivar tu caso a un asesor')) {
                logger.info(`[CANCEL PAUSE] Intercepted cancel/complaint for user ${userId}. Halting flow.`);
                await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente desea cancelar, reclamar o derivar el caso a un humano.');
                saveState(userId);
            }

            // Señal robusta: el teléfono de reventa (único e inequívoco), tolerando
            // separadores ("341 375 5757"). NO matcheamos el nombre "Horacio" suelto
            // — es también un nombre de seller y disparaba pausas falsas.
            if (!_controlHandled && (botMsg.includes('3413755757') || botMsg.replace(/\D/g, '').includes('3413755757'))) {
                logger.info(`[RESELLER PAUSE] Intercepted reseller intent for user ${userId}. Halting flow.`);
                await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente está interesado en reventa/compras por mayor. Derivado a Horacio.');
                saveState(userId);
            }

            // 🛑 GUARD ANTI VENTA-FANTASMA (ver _isGhostClose): la IA "cerró" la venta
            // por texto pero el flujo NO generó la orden. En vez de perderla en
            // silencio, pausamos + avisamos al admin para que la cargue/contacte.
            if (_isGhostClose(botMsg, currentState.step, !!(currentState as any).pendingOrder)) {
                logger.warn(`[GHOST-CLOSE] User ${userId}: el bot dio por cerrada la venta en step "${currentState.step}" SIN orden generada (sin pendingOrder). Pausando + alertando.`);
                await _pauseAndAlert(userId, currentState, dependencies, text, '⚠️ VENTA FANTASMA: el bot dio por confirmado/listo un pedido pero el sistema NO lo registró (sin orden). Revisá la conversación y cargá/contactá al cliente manualmente.');
                saveState(userId);
            }
        }
    }
}
