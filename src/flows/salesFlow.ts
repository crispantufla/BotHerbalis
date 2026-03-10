import { UserState, FlowStep } from '../types/state';
import { pauseUser } from '../services/pauseService';
const logger = require('../utils/logger');
const { processGlobals } = require('./globals');
const { processStep } = require('./steps');
const { _pauseAndAlert, _setStep, _extractSilentVariables, _cleanPhone } = require('./utils/flowHelpers');

interface SalesFlowDependencies {
    saveState: (userId?: string) => void;
    client?: any;
    sharedState?: any;
    notifyAdmin?: (reason: string, userPhone: string, details?: string | null) => Promise<any>;
    aiService?: any;
    sendMessageWithDelay?: (chatId: string, content: string, startTime?: number) => Promise<void>;
    logAndEmit?: (chatId: string, sender: string, text: string, step?: string) => void;
    saveOrderToLocal?: (order: any) => void;
    cancelLatestOrder?: (userId: string) => Promise<any>;
    config?: any;
    effectiveScript?: string;
}

// Keywords that signal clear purchase intent — if present, don't auto-pause
const PURCHASE_INTENT_KEYWORDS = /\b(comprar|quiero comprar|quiero pedir|me interesa|precio|precios|cuanto sale|cuánto sale|cuanto cuesta|cuánto cuesta|quiero encargar|necesito comprar|hagan envios|hacen envíos|hacen envios|quisiera pedir|quisiera comprar|quiero adquirir|quiero ordenar|tienen capsulas|tienen semillas|tienen gotas|nuez de la india|la direccion|la dirección|mi direccion|mi dirección|te paso mis datos|mis datos|los datos|te paso la direccion|te paso la dirección|informacion|información|quiero saber|quiero mas info|bajar|adelgazar|kilos|kilo|capsulas|cápsulas|semillas|gotas|peso|perder peso|bajar de peso|10 kg|20 kg|mas de 20)\b/i;

export async function processSalesFlow(
    userId: string,
    text: string,
    userState: Record<string, any>,
    knowledge: any,
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
            lastActivityAt: Date.now()
        };

        // --- CHECK 1: Cross-reference against Orders DB ---
        // If this phone has an existing order, they're a past customer — route to post-sale
        try {
            const { prisma } = require('../../db');
            const cleanPhone = _cleanPhone(userId);
            const existingOrder = await prisma.order.findFirst({
                where: { userPhone: cleanPhone }, // cross-instance: any prior order from this phone
                orderBy: { createdAt: 'desc' }
            });

            if (existingOrder) {
                logger.info(`[ORDER-CHECK] User ${userId} has existing order (status: ${existingOrder.status}). Routing to post-sale.`);
                userState[userId].step = 'completed';
                userState[userId].selectedProduct = existingOrder.products;
                saveState(userId);
                // Don't return — let the flow continue into stepCompleted handler below
            }
        } catch (err: any) {
            logger.error(`[ORDER-CHECK] Failed to query orders for ${userId}:`, err.message);
        }

        // --- CHECK 1.5: Cross-Instance Duplicate Detection ---
        // (DISABLED PER USER REQUEST)
        // If this phone is already in an active sales flow on ANOTHER bot instance,
        // redirect them politely instead of starting a duplicate conversation.
        /*
        if (userState[userId].step !== 'completed') {
            try {
                const { prisma } = require('../../db');
                const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
                const cleanPhone = _cleanPhone(userId);

                const otherInstanceUsers = await prisma.user.findMany({
                    where: {
                        phone: cleanPhone,
                        instanceId: { not: INSTANCE_ID }
                    },
                    select: { instanceId: true, profileData: true }
                });

                // Check if any of those other instances have an active (mid-funnel) conversation
                const activeInOtherBot = otherInstanceUsers.some((u: any) => {
                    try {
                        const data = JSON.parse(u.profileData || '{}');
                        const step = data.step || 'greeting';
                        const activeSteps = ['waiting_weight', 'waiting_preference', 'waiting_price_confirmation', 'waiting_plan_choice', 'waiting_ok', 'waiting_data', 'waiting_final_confirmation'];
                        return activeSteps.includes(step);
                    } catch (e) { return false; }
                });

                if (activeInOtherBot) {
                    logger.info(`[CROSS-BOT] User ${userId} is already active in another bot instance. Sending redirect.`);
                    if (dependencies.sendMessageWithDelay) {
                        await dependencies.sendMessageWithDelay(
                            userId,
                            "¡Hola! Ya te está atendiendo mi compañera por el otro número 😊 Seguí la charla por ahí así no nos pisamos. ¡Cualquier cosa acá estoy!"
                        );
                    }
                    if (dependencies.sharedState?.pausedUsers) {
                        const { pauseUser } = require('../services/pauseService');
                        await pauseUser(userId, '🔀 Redirigido a otro bot (cross-bot)', { sharedState: dependencies.sharedState });
                    }
                    userState[userId].step = 'cross_bot_redirected';
                    saveState(userId);
                    return { matched: true, paused: true };
                }
            } catch (err: any) {
                logger.error(`[CROSS-BOT] Failed to check other instances for ${userId}:`, err.message);
            }
        }
        */

        // --- CHECK 2: WhatsApp Chat History Detection ---
        // Only run this if we didn't already route to post-sale via Orders
        if (userState[userId].step !== 'completed' && userState[userId].step !== 'cross_bot_redirected') {
            try {
                const { prisma } = require('../../db');
                const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
                const cleanPhone = _cleanPhone(userId);

                // Grab the last 15 messages from DB locally (cross-instance)
                const messagesConfig = await prisma.chatLog.findMany({
                    where: { userPhone: cleanPhone },
                    orderBy: { timestamp: 'desc' },
                    take: 15
                });

                // Check for existence of any prior post-sale outgoing message
                const outgoingMessages = messagesConfig.filter((m: any) => m.role === 'bot' || m.role === 'admin' || m.role === 'system');
                const hasPostSaleMessage = outgoingMessages.some((m: any) => {
                    const body = (m.content || '').trim();
                    if (body.includes('MENSAJE DE HERBALIS') || body.includes('MENSAJDE DE HERBALIS')) return true;
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

    // --- NEW REQUIREMENT (Unconditional Post-Sale Stop) ---
    // If the user's step is 'completed', it means they are a past customer.
    // Pause immediately and alert admin if not already paused.
    if (currentState.step === 'completed' || currentState.step === 'cross_bot_redirected') {
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
            logger.info(`[HARD STOP] User ${userId} is past customer/redirected. Already paused or redirected. Ignoring silently.`);
        }

        return { matched: true, paused: true };
    }

    // Safety fallback for empty history
    if (!currentState.history) currentState.history = [];

    // Defensive cap: prevent unbounded history growth
    if (currentState.history.length > 200) {
        currentState.history = currentState.history.slice(-100);
    }

    // Save User message and update activity timestamp
    currentState.history.push({ role: 'user', content: text, timestamp: Date.now() });
    currentState.lastActivityAt = Date.now();
    saveState(userId);

    // 1.5. Silent Variable Extraction (Age/Weight out of band)
    // NOTE: We intentionally exclude 'waiting_weight' because in that step the user IS answering
    // the weight question — intercepting it here would send "¡Anotado!" instead of advancing the flow.
    const activeSteps = ['waiting_preference', 'waiting_preference_consultation', 'waiting_plan_choice', 'waiting_ok', 'waiting_data'];
    if (activeSteps.includes(currentState.step)) {
        const extraction = _extractSilentVariables(normalizedText, currentState);
        if (extraction.ageUpdated || extraction.weightUpdated) {
            saveState(userId);
            // If the user's message was merely "tengo 40 años" we don't want to confuse the AI
            // We just ACK and repeat the state's main question if it was merely a correction
            if (extraction.isSolelyCorrection) {
                logger.info(`[GLOBAL EXTRACTION] Intercepted sole correction for ${userId}. Age:${extraction.ageUpdated}, Weight:${extraction.weightUpdated}`);
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

    // 2. Execute Global Interceptors (Priority 0 and 1)
    const globalsResult = await processGlobals(userId, text, normalizedText, currentState, knowledge, dependencies);
    if (globalsResult && globalsResult.matched) {
        return; // Handled globally!
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

    // 4. Safety Net / Fallback
    if (!stepResult || !stepResult.matched) {
        logger.info(`[PAUSE] No match for user ${userId} at step "${currentState.step}". Pausing and alerting admin.`);
        await _pauseAndAlert(userId, currentState, dependencies, text, `Bot no pudo responder en paso "${currentState.step}".`);
    }

    // 5. Post-Processing Context Triggers Check
    if (currentState.history && currentState.history.length > 0) {
        const lastHistory = currentState.history[currentState.history.length - 1];
        if (lastHistory.role === 'bot') {
            const botMsg = lastHistory.content;

            if (botMsg.includes('por precaución no recomendamos el consumo') || botMsg.includes('por precaución no recomendamos el uso durante')) {
                logger.info(`[AI MEDICAL REJECT] Intercepted AI rejection for user ${userId}. Halting flow.`);
                _setStep(currentState, FlowStep.REJECTED_MEDICAL);
                saveState(userId);
            }

            if (botMsg.includes('Por falta de respeto damos por terminada la comunicación')) {
                logger.info(`[ABUSE REJECT] Intercepted AI abuse rejection for user ${userId}. Halting flow.`);
                await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente insultó al bot y fue bloqueado automáticamente.');
                saveState(userId);
            }

            if (botMsg.includes('Pensalo tranquilo y cuando estés 100% segura retomamos el pedido')) {
                logger.info(`[INDECISION PAUSE] Intercepted AI indecision limit for user ${userId}. Halting flow.`);
                await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente cruzó el umbral de indecisión/cambios. Pausa preventiva.');
                saveState(userId);
            }

            if (botMsg.includes('Voy a derivar tu caso a un asesor')) {
                logger.info(`[CANCEL PAUSE] Intercepted cancel/complaint for user ${userId}. Halting flow.`);
                await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente desea cancelar, reclamar o derivar el caso a un humano.');
                saveState(userId);
            }

            if (botMsg.includes('3413755757') || botMsg.includes('Horacio')) {
                logger.info(`[RESELLER PAUSE] Intercepted reseller intent for user ${userId}. Halting flow.`);
                await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente está interesado en reventa/compras por mayor. Derivado a Horacio.');
                saveState(userId);
            }
        }
    }
}
