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

        // --- NEW PRE-BOT HISTORY CHECK ---
        try {
            if (dependencies.client) {
                const chat = await dependencies.client.getChatById(userId);
                if (chat) {
                    const messages = await chat.fetchMessages({ limit: 10 });
                    const previousUserMessages = messages.filter((m: any) => !m.fromMe).length;

                    let isRecentConversation = false;
                    if (messages.length > 0) {
                        const lastMsg = messages[messages.length > 1 ? messages.length - 2 : 0];
                        if (lastMsg && lastMsg.timestamp) {
                            const hoursSinceLastMsg = (Date.now() / 1000 - lastMsg.timestamp) / 3600;
                            if (hoursSinceLastMsg <= 24) {
                                isRecentConversation = true;
                            }
                        }
                    }

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
                        console.log(`[POST-SALE] User ${userId} has post-sale messages in history. Auto-pausing (post-sale management).`);
                        if (dependencies.sharedState && dependencies.sharedState.pausedUsers) {
                            dependencies.sharedState.pausedUsers.add(userId);
                        }
                        return { matched: true, paused: true };
                    }

                    if (previousUserMessages >= 5 && isRecentConversation) {
                        console.log(`[SPAM FILTER] User ${userId} has ${previousUserMessages} previous messages before bot init and conversation is recent. Auto-pausing.`);
                        if (dependencies.sharedState && dependencies.sharedState.pausedUsers) {
                            dependencies.sharedState.pausedUsers.add(userId);
                            try {
                                if (dependencies.notifyAdmin) dependencies.notifyAdmin('😴 Conversación Existente', userId, 'Se detectó que este cliente estaba respondiendo a un hilo de chat reciente activo. El bot se silenció automáticamente para no entrometerse.');
                            } catch (e) { }
                        }
                        return { matched: true, paused: true };
                    }
                }
            }
        } catch (err: any) {
            console.error(`[SPAM FILTER] Failed to fetch chat history for ${userId}:`, err.message);
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
