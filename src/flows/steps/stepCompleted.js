const { _setStep } = require('../utils/flowHelpers');

async function handleCompleted(userId, text, normalizedText, currentState, knowledge, dependencies) {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    console.log(`[POST-SALE] Message from completed customer ${userId}: "${text}"`);

    const today = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

    const postSaleAI = await aiService.chat(text, {
        step: 'post_sale',
        goal: `Este cliente YA COMPRÓ. Sos un asistente post-venta amable. Hoy es ${today}. Reglas:
1. Si saluda ("hola", "buenas"), respondé breve. NO reiniciar el flujo.
2. Si pregunta por su paquete, seguimiento, correo, demora, donde está el pedido o si ya lo despacharon: extraé "TRACKING_INFO" en la variable extractedData. NUNCA respondas nada ante estas consultas, solo extraelo.
3. Si pide postergar EL ENVÍO (ej. "el 8 de marzo", "el mes que viene", "dentro de 5 días"):
   - Si la fecha que pide es en MENOS DE 10 DÍAS desde hoy: decile amablemente que los envíos de por sí tardan mínimo 10 días.
   - Si la fecha es en MÁS DE 10 DÍAS desde hoy: aceptá amablemente, confirmá que se pospone y devolvé "POSTDATE: [fecha]" en extractedData.
   - ⚠️ BAJO NINGÚN PUNTO DE VISTA le vuelvas a pedir datos de envío.
4. Si tiene reclamo o duda compleja: extractedData="NEED_ADMIN" y avisá que lo comunicás.
5. Si quiere VOLVER A COMPRAR (MÁS productos): extractedData="RE_PURCHASE" y preguntale qué quiere.
6. Si pide CANCELAR SU PEDIDO o ANULAR LA COMPRA: preguntale amablemente el motivo y devolvé "CANCEL_ORDER" en extractedData. ATENCIÓN: Solo hacé esto si es muy claro.
7. NUNCA inventes información. NUNCA pidas datos de envío ni intentes venderle cápsulas/semillas/gotas sin que lo pida.`,
        history: currentState.history,
        summary: currentState.summary,
        // Eliminamos "knowledge: knowledge" para que el bot no se contamine con el agresivo guion de ventas
        userState: currentState
    });

    if (postSaleAI.extractedData === 'TRACKING_INFO') {
        console.log(`[POST-SALE] Customer ${userId} is asking for tracking/shipping info. Auto-pausing silently.`);
        if (dependencies.sharedState && dependencies.sharedState.pausedUsers) {
            dependencies.sharedState.pausedUsers.add(userId);
        }
        if (dependencies.notifyAdmin) {
            await dependencies.notifyAdmin('📦 Consulta de Código/Envío', userId, `El cliente post-venta preguntó por su envío o código de seguimiento.\n\nMensaje original: "${text}"\n\nEl bot se silenció automáticamente para que le respondas.`);
        }
        // Devuelve paused: true para evitar que globals/salesFlow continúen. No enviamos ningún SMS.
        return { matched: true, paused: true };
    } else if (postSaleAI.extractedData === 'RE_PURCHASE') {
        console.log(`[POST-SALE] Customer ${userId} wants to re-purchase. Skipping to preference.`);
        _setStep(currentState, 'waiting_preference');
        currentState.cart = [];
        currentState.pendingOrder = null;
        currentState.partialAddress = {};
        currentState.addressAttempts = 0;
        saveState(userId);

        if (postSaleAI.response) {
            currentState.history.push({ role: 'bot', content: postSaleAI.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, postSaleAI.response);
        }
        return { matched: true };
    } else if (postSaleAI.extractedData === 'CANCEL_ORDER') {
        console.log(`[POST-SALE] Customer ${userId} wants to cancel their order.`);

        if (dependencies.cancelLatestOrder) {
            const cancelResult = await dependencies.cancelLatestOrder(userId);
            let finalMsg = "Hubo un problema procesando tu solicitud de cancelación. Un asesor se comunicará con vos.";

            if (cancelResult.success) {
                finalMsg = `✅ Listo. Tu pedido ha sido cancelado exitosamente. Si la compra ya estaba pagada, el reembolso se procesará en breve.\n\n¿Me podrías comentar brevemente el motivo de la cancelación? Me ayuda a mejorar.`;
                if (dependencies.notifyAdmin) {
                    await dependencies.notifyAdmin('🚫 Pedido Cancelado por el Cliente', userId, `El cliente solicitó la cancelación del pedido y fue procesada automáticamente.\nMensaje original: "${text}"`);
                }
            } else if (cancelResult.reason === 'INVALID_STATUS') {
                finalMsg = `Pucha, no puedo cancelar el pedido automáticamente porque actualmente está en estado *${cancelResult.currentStatus}* (ya fue despachado o preparado). Ya le avisé a un asesor para que lo revise y se comunique con vos.`;
                if (dependencies.notifyAdmin) {
                    await dependencies.notifyAdmin('⚠️ Intento de Cancelación Fallido', userId, `El cliente intentó cancelar el pedido pero su estado es: ${cancelResult.currentStatus}.\nMensaje: "${text}"`);
                }
            } else if (cancelResult.reason === 'NOT_FOUND') {
                finalMsg = `No encontré ningún pedido activo a tu nombre para cancelar. Si creés que es un error, aguardá que un asesor te va a contactar.`;
                if (dependencies.notifyAdmin) {
                    await dependencies.notifyAdmin('⚠️ Intento de Cancelación (No encontrado)', userId, `El cliente quiso cancelar un pedido pero no se encontró en la BD local.\nMensaje: "${text}"`);
                }
            }

            currentState.history.push({ role: 'bot', content: finalMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, finalMsg);
        } else {
            console.error("[POST-SALE] cancelLatestOrder dependency is missing.");
            await sendMessageWithDelay(userId, "Ya le pasé tu pedido de cancelación a un asesor, en breve te responde.");
        }

        return { matched: true };
    } else if (postSaleAI.extractedData && postSaleAI.extractedData.startsWith('POSTDATE:')) {
        const newDate = postSaleAI.extractedData.replace('POSTDATE:', '').trim();
        console.log(`[POST-SALE] Customer ${userId} wants to post-date delivery to: ${newDate}`);
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
        if (dependencies.notifyAdmin) await dependencies.notifyAdmin('⚠️ Cliente post-venta necesita asistencia', userId, `Mensaje: "${text}"`);
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
