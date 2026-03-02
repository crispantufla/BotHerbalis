import { UserState, FlowStep } from '../types/state';
const { processGlobals } = require('./globals');
const { processStep } = require('./steps');
const { _pauseAndAlert, _setStep } = require('./utils/flowHelpers');

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
    dependencies: SalesFlowDependencies
): Promise<{ matched: boolean; paused?: boolean } | void> {
    const { saveState } = dependencies;

    // Remove accents and lowercase
    const lowerText = text.toLowerCase();
    const normalizedText = lowerText.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    // 1. Initialization
    if (!userState[userId]) {
        console.log(`[STATE] Initializing new internal state for user ${userId}`);
        userState[userId] = {
            step: knowledge.flow.greeting ? 'greeting' : 'completed',
            history: [],
            cart: [],
            summary: "",
            partialAddress: {},
            selectedProduct: null,
            selectedPlan: null,
            geoRejected: false,
            stepEnteredAt: Date.now()
        };

        // --- CHECK 1: Cross-reference against Orders DB ---
        // If this phone has an existing order, they're a past customer — route to post-sale
        try {
            const { prisma } = require('../../db');
            const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
            const cleanPhone = userId.split('@')[0].replace(/\D/g, '');
            const existingOrder = await prisma.order.findFirst({
                where: { userPhone: cleanPhone, instanceId: INSTANCE_ID },
                orderBy: { createdAt: 'desc' }
            });

            if (existingOrder) {
                console.log(`[ORDER-CHECK] User ${userId} has existing order (status: ${existingOrder.status}). Routing to post-sale.`);
                userState[userId].step = 'completed';
                userState[userId].selectedProduct = existingOrder.products;
                saveState(userId);
                // Don't return — let the flow continue into stepCompleted handler below
            }
        } catch (err: any) {
            console.error(`[ORDER-CHECK] Failed to query orders for ${userId}:`, err.message);
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
                const cleanPhone = userId.split('@')[0].replace(/\D/g, '');

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
                    console.log(`[CROSS-BOT] User ${userId} is already active in another bot instance. Sending redirect.`);
                    if (dependencies.sendMessageWithDelay) {
                        await dependencies.sendMessageWithDelay(
                            userId,
                            "¡Hola! Ya te está atendiendo mi compañera por el otro número 😊 Seguí la charla por ahí así no nos pisamos. ¡Cualquier cosa acá estoy!"
                        );
                    }
                    if (dependencies.sharedState?.pausedUsers) {
                        dependencies.sharedState.pausedUsers.add(userId);
                    }
                    userState[userId].step = 'cross_bot_redirected';
                    saveState(userId);
                    return { matched: true, paused: true };
                }
            } catch (err: any) {
                console.error(`[CROSS-BOT] Failed to check other instances for ${userId}:`, err.message);
            }
        }
        */

        // --- CHECK 2: WhatsApp Chat History Detection ---
        // Only run this if we didn't already route to post-sale via Orders
        if (userState[userId].step !== 'completed' && userState[userId].step !== 'cross_bot_redirected') {
            try {
                const { prisma } = require('../../db');
                const INSTANCE_ID = process.env.INSTANCE_ID || 'default';
                const cleanPhone = userId.split('@')[0].replace(/\D/g, '');

                // Grab the last 15 messages from DB locally (sub-millisecond compared to API)
                const messagesConfig = await prisma.chatLog.findMany({
                    where: { userPhone: cleanPhone, instanceId: INSTANCE_ID },
                    orderBy: { timestamp: 'desc' },
                    take: 15
                });

                // Check for existence of any prior post-sale outgoing message
                const outgoingMessages = messagesConfig.filter((m: any) => m.role === 'bot');
                const hasPostSaleMessage = outgoingMessages.some((m: any) => {
                    const body = (m.content || '').trim();
                    if (body.includes('MENSAJE DE HERBALIS') || body.includes('MENSAJDE DE HERBALIS')) return true;
                    if (/^CO\d{9}$/i.test(body)) return true;
                    return false;
                });

                if (hasPostSaleMessage) {
                    console.log(`[POST-SALE] User ${userId} has post-sale messages in local DB. Auto-pausing.`);
                    if (dependencies.sharedState && dependencies.sharedState.pausedUsers) {
                        dependencies.sharedState.pausedUsers.add(userId);
                    }
                    return { matched: true, paused: true };
                }

                // If no post-sale message exists, let's see if there's extensive prior interaction
                // 1-9 outgoing = likely bots replying to ads. 10+ means extensive interaction history.
                const hasSignificantHistory = outgoingMessages.length >= 10;

                if (hasSignificantHistory) {
                    const showsPurchaseIntent = PURCHASE_INTENT_KEYWORDS.test(normalizedText);

                    if (showsPurchaseIntent) {
                        console.log(`[SMART-DETECT] User ${userId} has prior history (outgoing bot: ${outgoingMessages.length}) but shows purchase intent. Allowing sales flow.`);
                    } else {
                        const reason = `Ya tenía ${outgoingMessages.length} mensaje(s) del bot previos en DB`;
                        console.log(`[SMART-DETECT] User ${userId}: ${reason} and NO purchase intent. Auto-pausing.`);

                        if (dependencies.sharedState && dependencies.sharedState.pausedUsers) {
                            dependencies.sharedState.pausedUsers.add(userId);
                            try {
                                if (dependencies.notifyAdmin) dependencies.notifyAdmin(
                                    '😴 Cliente con historial extenso',
                                    userId,
                                    `${reason}. Volvió a escribir: "${text.substring(0, 100)}"\nEl bot se silenció automáticamente.`
                                );
                            } catch (e) { }
                        }
                        return { matched: true, paused: true };
                    }
                } else if (outgoingMessages.length > 0) {
                    console.log(`[SMART-DETECT] User ${userId} has ${outgoingMessages.length} prior message(s) (< 10 threshold) in DB. Treating as active prospect.`);
                }
            } catch (err: any) {
                console.error(`[SMART-DETECT] Failed to fetch local chat history DB for ${userId}:`, err.message);
            }
        }
    }
    saveState(userId);

    const currentState = userState[userId];

    // Safety fallback for empty history
    if (!currentState.history) currentState.history = [];

    // Save User message
    currentState.history.push({ role: 'user', content: text, timestamp: Date.now() });
    saveState(userId);

    // 2. Execute Global Interceptors (Priority 0 and 1)
    const globalsResult = await processGlobals(userId, text, normalizedText, currentState, knowledge, dependencies);
    if (globalsResult && globalsResult.matched) {
        return; // Handled globally!
    }

    // 3. Process Specific Step Logic
    const stepResult = await processStep(userId, text, normalizedText, currentState, knowledge, dependencies);

    // Recursive safety for stale steps
    if (stepResult && stepResult.staleReprocess) {
        return await processSalesFlow(userId, text, userState, knowledge, dependencies);
    }

    // 4. Safety Net / Fallback
    if (!stepResult || !stepResult.matched) {
        console.log(`[PAUSE] No match for user ${userId} at step "${currentState.step}". Pausing and alerting admin.`);
        await _pauseAndAlert(userId, currentState, dependencies, text, `Bot no pudo responder en paso "${currentState.step}".`);
    }

    // 5. Post-Processing Context Triggers Check
    if (currentState.history && currentState.history.length > 0) {
        const lastHistory = currentState.history[currentState.history.length - 1];
        if (lastHistory.role === 'bot') {
            const botMsg = lastHistory.content;

            if (botMsg.includes('por precaución no recomendamos el consumo') || botMsg.includes('por precaución no recomendamos el uso durante')) {
                console.log(`[AI MEDICAL REJECT] Intercepted AI rejection for user ${userId}. Halting flow.`);
                _setStep(currentState, FlowStep.REJECTED_MEDICAL);
                saveState(userId);
            }

            if (botMsg.includes('Por falta de respeto damos por terminada la comunicación')) {
                console.log(`[ABUSE REJECT] Intercepted AI abuse rejection for user ${userId}. Halting flow.`);
                await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente insultó al bot y fue bloqueado automáticamente.');
                saveState(userId);
            }

            if (botMsg.includes('Pensalo tranquilo y cuando estés 100% segura retomamos el pedido')) {
                console.log(`[INDECISION PAUSE] Intercepted AI indecision limit for user ${userId}. Halting flow.`);
                await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente cruzó el umbral de indecisión/cambios. Pausa preventiva.');
                saveState(userId);
            }

            if (botMsg.includes('Voy a derivar tu caso a un asesor')) {
                console.log(`[CANCEL PAUSE] Intercepted cancel/complaint for user ${userId}. Halting flow.`);
                await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente desea cancelar, reclamar o derivar el caso a un humano.');
                saveState(userId);
            }

            if (botMsg.includes('3413755757') || botMsg.includes('Horacio')) {
                console.log(`[RESELLER PAUSE] Intercepted reseller intent for user ${userId}. Halting flow.`);
                await _pauseAndAlert(userId, currentState, dependencies, text, 'El cliente está interesado en reventa/compras por mayor. Derivado a Horacio.');
                saveState(userId);
            }
        }
    }
}
