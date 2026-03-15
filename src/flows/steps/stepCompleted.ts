import { UserState } from '../../types/state';
const { _setStep } = require('../utils/flowHelpers');
const { _isAffirmative, _isNegative } = require('../utils/validation');
const logger = require('../../utils/logger');

interface CompletedDependencies {
    sendMessageWithDelay: (chatId: string, content: string) => Promise<void>;
    aiService: any;
    saveState: (userId: string) => void;
    notifyAdmin?: (subject: string, userId: string, detail?: string) => Promise<any>;
    cancelLatestOrder?: (userId: string) => Promise<{ success: boolean; reason?: string; currentStatus?: string }>;
    sharedState?: { pausedUsers?: Set<string> };
}

export async function handleCompleted(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: CompletedDependencies
): Promise<{ matched: boolean; paused?: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    logger.info(`[POST-SALE] Message from completed customer ${userId}: "${text}"`);

    // --- GUARD: Pending cancel confirmation ---
    // If we asked the customer to confirm cancellation and are waiting for yes/no
    if (currentState.pendingCancelConfirm) {
        if (_isAffirmative(normalizedText)) {
            currentState.pendingCancelConfirm = false;
            saveState(userId);

            if (dependencies.cancelLatestOrder) {
                const cancelResult = await dependencies.cancelLatestOrder(userId);
                let finalMsg = 'Hubo un problema procesando tu solicitud. Un asesor se va a comunicar con vos.';

                if (cancelResult.success) {
                    finalMsg = `✅ Listo. Tu pedido fue cancelado. Si la compra ya estaba pagada, el reembolso se procesará en breve.`;
                    if (dependencies.notifyAdmin) {
                        await dependencies.notifyAdmin('🚫 Pedido Cancelado por el Cliente', userId, `Cancelación confirmada por el cliente.\nMensaje: "${text}"`);
                    }
                } else if (cancelResult.reason === 'INVALID_STATUS') {
                    finalMsg = `Pucha, no puedo cancelarlo automáticamente porque está en estado *${cancelResult.currentStatus}* (ya fue despachado). Le aviso a un asesor para que lo revise.`;
                    if (dependencies.notifyAdmin) {
                        await dependencies.notifyAdmin('⚠️ Intento de Cancelación Fallido', userId, `El pedido ya estaba en estado: ${cancelResult.currentStatus}.`);
                    }
                } else if (cancelResult.reason === 'NOT_FOUND') {
                    finalMsg = `No encontré ningún pedido activo a tu nombre. Un asesor te va a contactar.`;
                    if (dependencies.notifyAdmin) {
                        await dependencies.notifyAdmin('⚠️ Cancelación (No encontrado)', userId, `Cliente quiso cancelar pero no hay pedido en la BD.`);
                    }
                }
                currentState.history.push({ role: 'bot', content: finalMsg, timestamp: Date.now() });
                await sendMessageWithDelay(userId, finalMsg);
            }
            return { matched: true };
        } else if (_isNegative(normalizedText)) {
            currentState.pendingCancelConfirm = false;
            saveState(userId);
            const msg = '¡Perfecto, lo dejamos así entonces! 😊 Si necesitás algo más, avisame.';
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, msg);
            return { matched: true };
        } else {
            const msg = '¿Confirmás que querés cancelar el pedido? Respondé sí o no 😊';
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, msg);
            return { matched: true };
        }
    }

    const today = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

    // --- REGEX PRE-DETECTION (works even when AI is unavailable) ---
    const TRACKING_REGEX = /\b(seguimiento|tracking|donde.{0,10}(pedido|paquete|envio|envío)|cuando.{0,10}llega|ya.{0,10}(despacha|enviar|mand)|llego.{0,10}(pedido|paquete)|estado.{0,10}(pedido|envio|envío)|codigo.{0,10}(seguimiento|envio|envío)|me lo traen|no.{0,10}(llego|llega|recibi)|demora|tarda.{0,10}(mucho|en llegar)|lo despacharon|rastreo|rastrear|correo.{0,10}(argentino|llego)|movimiento.{0,10}pedido)\b/i;
    const CANCEL_REGEX = /\b(cancelar|cancela|anular|anulo|dar de baja|no.{0,3}quiero.{0,10}pedido|devolver|devolucion|devolución|reembolso)\b/i;
    const COMPLAINT_REGEX = /\b(reclam|queja|denuncia|estafa|defensa.{0,10}consumidor|mal.{0,10}estado|vino.{0,10}(roto|mal)|no.{0,10}(sirve|funciona)|me hizo mal|diarrea|dolor|malestar|vomit|intoxic)\b/i;

    if (TRACKING_REGEX.test(normalizedText)) {
        logger.info(`[POST-SALE] [REGEX] Tracking query detected from ${userId}: "${text}". Auto-pausing.`);
        if (dependencies.sharedState?.pausedUsers) {
            const { pauseUser } = require('../../services/pauseService');
            await pauseUser(userId, '📦 Consulta de tracking post-venta', { sharedState: dependencies.sharedState });
        }
        if (dependencies.notifyAdmin) {
            await dependencies.notifyAdmin('📦 Consulta de Código/Envío', userId, `El cliente post-venta preguntó por su envío.\n\nMensaje original: "${text}"\n\nEl bot se silenció automáticamente para que le respondas.`);
        }
        return { matched: true, paused: true };
    }

    if (COMPLAINT_REGEX.test(normalizedText)) {
        logger.info(`[POST-SALE] [REGEX] Complaint detected from ${userId}: "${text}". Auto-pausing.`);
        if (dependencies.sharedState?.pausedUsers) {
            const { pauseUser } = require('../../services/pauseService');
            await pauseUser(userId, '🚨 Reclamo post-venta', { sharedState: dependencies.sharedState });
        }
        if (dependencies.notifyAdmin) {
            await dependencies.notifyAdmin('🚨 Reclamo Post-Venta', userId, `El cliente tiene un reclamo/queja.\n\nMensaje original: "${text}"\n\nEl bot se silenció automáticamente para que le respondas.`);
        }
        return { matched: true, paused: true };
    }

    const postSaleAI = await aiService.chat(text, {
        step: 'post_sale',
        goal: `Este cliente YA COMPRÓ. Sos un asistente post-venta amable. Hoy es ${today}. Reglas:
1. Si saluda ("hola", "buenas"), respondé breve. NO reiniciar el flujo.
2. Si pregunta por su paquete, seguimiento, correo, demora, donde está el pedido o si ya lo despacharon: extraé "TRACKING_INFO" en la variable extractedData. NUNCA respondas nada ante estas consultas, solo extraelo.
3. Si pide postergar EL ENVÍO (ej. "el 8 de marzo", "el mes que viene", "dentro de 5 días"):
   - SEGUÍ NORMALMENTE. Si la fecha es VAGA (ej: "el mes que viene", "a fin de mes"), PROPONÉ UNA FECHA CONCRETA temprana del período (ej: "¿A partir del 5 de [mes] estaría bien, o necesitás que sea más adelante?"). Si confirma → devolvé "POSTDATE: [fecha]" en extractedData. Si dice que no → preguntá qué día prefiere.
   - Si da una fecha exacta: aceptá amablemente y devolvé "POSTDATE: [fecha]" en extractedData.
   - ⚠️ BAJO NINGÚN PUNTO DE VISTA le vuelvas a pedir datos de envío.
4. Si tiene reclamo o duda compleja: extractedData="NEED_ADMIN" y avisá que lo comunicás.
5. Si quiere VOLVER A COMPRAR (MÁS productos): extractedData="RE_PURCHASE" y preguntale qué quiere.
6. Si pide CANCELAR SU PEDIDO o ANULAR LA COMPRA: extraé "CANCEL_ORDER" y en tu respuesta preguntale amablemente si está seguro/a de que quiere cancelarlo. NO ejecutes la cancelación todavía, esperá la confirmación del cliente.
7. NUNCA inventes información. NUNCA pidas datos de envío ni intentes venderle cápsulas/semillas/gotas sin que lo pida.`,
        history: currentState.history,
        summary: currentState.summary,
        userState: currentState
    });

    // --- AI UNAVAILABLE: auto-pause for safety (post-sale needs human attention) ---
    if (postSaleAI.aiUnavailable) {
        logger.info(`[POST-SALE] AI unavailable for ${userId}. Auto-pausing for admin.`);
        if (dependencies.sharedState?.pausedUsers) {
            const { pauseUser } = require('../../services/pauseService');
            await pauseUser(userId, '⚠️ Post-venta (IA no disponible)', { sharedState: dependencies.sharedState });
        }
        if (dependencies.notifyAdmin) {
            await dependencies.notifyAdmin('⚠️ Cliente post-venta (IA caída)', userId, `La IA no pudo responder al cliente post-venta.\n\nMensaje original: "${text}"\n\nEl bot se silenció automáticamente para que le respondas.`);
        }
        return { matched: true, paused: true };
    }

    if (postSaleAI.extractedData === 'TRACKING_INFO') {
        logger.info(`[POST-SALE] Customer ${userId} is asking for tracking/shipping info. Auto-pausing silently.`);
        if (dependencies.sharedState?.pausedUsers) {
            const { pauseUser } = require('../../services/pauseService');
            await pauseUser(userId, '📦 Consulta de tracking post-venta', { sharedState: dependencies.sharedState });
        }
        if (dependencies.notifyAdmin) {
            await dependencies.notifyAdmin('📦 Consulta de Código/Envío', userId, `El cliente post-venta preguntó por su envío.\n\nMensaje original: "${text}"\n\nEl bot se silenció automáticamente para que le respondas.`);
        }
        return { matched: true, paused: true };
    } else if (postSaleAI.extractedData === 'RE_PURCHASE') {
        logger.info(`[POST-SALE] Customer ${userId} wants to re-purchase. Skipping to preference.`);
        _setStep(currentState, 'waiting_preference');
        currentState.cart = [];
        currentState.pendingOrder = null;
        currentState.partialAddress = {};
        currentState.addressAttempts = 0;
        currentState.selectedProduct = null;
        currentState.selectedPlan = null;
        currentState.totalPrice = null;
        currentState.postdatado = null;
        currentState.weightGoal = null;
        saveState(userId);

        if (postSaleAI.response) {
            currentState.history.push({ role: 'bot', content: postSaleAI.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, postSaleAI.response);
        }
        return { matched: true };
    } else if (postSaleAI.extractedData === 'CANCEL_ORDER') {
        // Don't cancel yet — ask for confirmation first
        logger.info(`[POST-SALE] Customer ${userId} wants to cancel. Setting pendingCancelConfirm and asking for confirmation.`);
        currentState.pendingCancelConfirm = true;
        saveState(userId);

        if (postSaleAI.response) {
            currentState.history.push({ role: 'bot', content: postSaleAI.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, postSaleAI.response);
        } else {
            const confirmMsg = '¿Estás seguro/a de que querés cancelar el pedido? Respondé sí o no 😊';
            currentState.history.push({ role: 'bot', content: confirmMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, confirmMsg);
        }
        return { matched: true };
    } else if (postSaleAI.extractedData?.startsWith('POSTDATE:')) {
        const newDate = postSaleAI.extractedData.replace('POSTDATE:', '').trim();
        logger.info(`[POST-SALE] Customer ${userId} wants to post-date delivery to: ${newDate}`);
        currentState.postdatado = newDate;
        saveState(userId);

        if (dependencies.notifyAdmin) {
            await dependencies.notifyAdmin('📅 Cliente post-venta posdató envío', userId, `Nueva fecha solicitada: ${newDate}\nMensaje original: "${text}"`);
        }

        if (postSaleAI.response) {
            currentState.history.push({ role: 'bot', content: postSaleAI.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, postSaleAI.response);
        }
        return { matched: true };
    } else if (postSaleAI.extractedData === 'NEED_ADMIN') {
        if (dependencies.notifyAdmin) {
            await dependencies.notifyAdmin('⚠️ Cliente post-venta necesita asistencia', userId, `Mensaje: "${text}"`);
        }
        if (postSaleAI.response) {
            currentState.history.push({ role: 'bot', content: postSaleAI.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, postSaleAI.response);
        }
        return { matched: true };
    } else if (postSaleAI.response) {
        currentState.history.push({ role: 'bot', content: postSaleAI.response, timestamp: Date.now() });
        await sendMessageWithDelay(userId, postSaleAI.response);
        return { matched: true };
    }

    return { matched: true };
}

module.exports = { handleCompleted };
