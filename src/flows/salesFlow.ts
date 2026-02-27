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
const PURCHASE_INTENT_KEYWORDS = /\b(comprar|quiero comprar|quiero pedir|me interesa|precio|precios|cuanto sale|cuánto sale|cuanto cuesta|cuánto cuesta|quiero encargar|necesito comprar|hagan envios|hacen envíos|hacen envios|quisiera pedir|quisiera comprar|quiero adquirir|quiero ordenar|tienen capsulas|tienen semillas|tienen gotas|nuez de la india)\b/i;

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
            const cleanPhone = userId.split('@')[0].replace(/\D/g, '');
            const existingOrder = await prisma.order.findFirst({
                where: { userPhone: cleanPhone },
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

        // --- CHECK 2: WhatsApp Chat History Detection ---
        // Only run this if we didn't already route to post-sale via Orders
        if (userState[userId].step !== 'completed') {
            try {
                if (dependencies.client) {
                    const chat = await dependencies.client.getChatById(userId);
                    if (chat) {
                        const messages = await chat.fetchMessages({ limit: 10 });

                        // --- POST-SALE DETECTION: auto-pause if outgoing post-sale messages exist ---
                        const outgoingMessages = messages.filter((m: any) => m.fromMe && m.body);
                        const hasPostSaleMessage = outgoingMessages.some((m: any) => {
                            const body = (m.body || '').trim();
                            // 1. Branch pickup notification
                            if (body.includes('MENSAJE DE HERBALIS') || body.includes('MENSAJDE DE HERBALIS')) return true;
                            // 2. Tracking code (starts with CO + 9 digits, e.g. CO767708617)
                            if (/^CO\d{9}$/i.test(body)) return true;
                            return false;
                        });

                        if (hasPostSaleMessage) {
                            console.log(`[POST-SALE] User ${userId} has post-sale messages in history. Auto-pausing.`);
                            if (dependencies.sharedState && dependencies.sharedState.pausedUsers) {
                                dependencies.sharedState.pausedUsers.add(userId);
                            }
                            return { matched: true, paused: true };
                        }

                        // --- EXISTING CONVERSATION DETECTION ---
                        // If there are ANY previous outgoing messages (bot or human),
                        // this person was already spoken to. Auto-pause UNLESS they show purchase intent.
                        const hasPriorOutgoing = outgoingMessages.length > 0;

                        if (hasPriorOutgoing) {
                            const showsPurchaseIntent = PURCHASE_INTENT_KEYWORDS.test(normalizedText);

                            if (showsPurchaseIntent) {
                                console.log(`[SMART-DETECT] User ${userId} has prior conversation but shows purchase intent ("${text.substring(0, 50)}"). Allowing sales flow.`);
                                // Let them through to the greeting flow normally
                            } else {
                                console.log(`[SMART-DETECT] User ${userId} has prior conversation and NO purchase intent. Auto-pausing.`);
                                if (dependencies.sharedState && dependencies.sharedState.pausedUsers) {
                                    dependencies.sharedState.pausedUsers.add(userId);
                                    try {
                                        if (dependencies.notifyAdmin) dependencies.notifyAdmin(
                                            '😴 Cliente con historial previo',
                                            userId,
                                            `Este contacto ya tenía mensajes previos en WhatsApp y volvió a escribir: "${text.substring(0, 100)}"\nEl bot se silenció automáticamente. Si es un prospecto nuevo, despausalo desde el panel.`
                                        );
                                    } catch (e) { }
                                }
                                return { matched: true, paused: true };
                            }
                        }
                    }
                }
            } catch (err: any) {
                console.error(`[SMART-DETECT] Failed to fetch chat history for ${userId}:`, err.message);
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

    // 5. Post-Processing Medical Reject Check
    if (currentState.history && currentState.history.length > 0) {
        const lastHistory = currentState.history[currentState.history.length - 1];
        if (lastHistory.role === 'bot' && (lastHistory.content.includes('por precaución no recomendamos el consumo') || lastHistory.content.includes('por precaución no recomendamos el uso durante'))) {
            console.log(`[AI MEDICAL REJECT] Intercepted AI rejection for user ${userId}. Halting flow.`);
            _setStep(currentState, FlowStep.REJECTED_MEDICAL);
            saveState(userId);
        }
    }
}
