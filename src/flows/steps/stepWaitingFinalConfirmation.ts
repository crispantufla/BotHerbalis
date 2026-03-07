import { UserState, FlowStep } from '../../types/state';
const { _setStep, _detectPostdatado, _detectProductPlanChange, _resolveNewProductPlan } = require('../utils/flowHelpers');
const { _getPrice, _getAdicionalMAX } = require('../utils/pricing');
const { _isAffirmative } = require('../utils/validation');
const logger = require('../../utils/logger');

export async function handleWaitingFinalConfirmation(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, saveState, notifyAdmin } = dependencies;

    const { productChange: productChangeMatch, planChange: planChangeMatch } = _detectProductPlanChange(normalizedText);

    if ((productChangeMatch || planChangeMatch) && currentState.selectedPlan) {
        const resolved = _resolveNewProductPlan(normalizedText, currentState.selectedProduct, currentState.selectedPlan);
        const newProduct = resolved.newProduct;
        const newPlan = resolved.newPlan;

        if (newProduct !== currentState.selectedProduct || newPlan !== currentState.selectedPlan) {
            currentState.selectedProduct = newProduct;
            currentState.selectedPlan = newPlan;

            const priceStr = _getPrice(newProduct, newPlan);
            let basePrice = parseInt(priceStr.replace(/\./g, ''));
            currentState.cart = [{ product: newProduct, plan: newPlan, price: priceStr }];

            let finalAdicional = 0;
            if (currentState.isContraReembolsoMAX) {
                finalAdicional = newPlan === '60' ? _getAdicionalMAX() : 0;
            }
            currentState.adicionalMAX = finalAdicional;
            const finalPrice = basePrice + finalAdicional;
            currentState.totalPrice = finalPrice.toLocaleString('es-AR').replace(/,/g, '.');

            const planText = newPlan === "120" ? "120 días" : "60 días";
            const changeMsg = `¡Dale, sin problema! 😊 Cambiamos el pedido a ${newProduct.split(' de ')[0].toLowerCase()} por ${planText}.`;
            currentState.history.push({ role: 'bot', content: changeMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, changeMsg);

            const summaryMsg = `Tendría un valor de $${currentState.totalPrice}.\n\n👉 Confirmame que podrás recibir o retirar el pedido sin inconvenientes.`;
            currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, summaryMsg);

            saveState(userId);
            return { matched: true };
        }
    }

    const _buildOrderData = (extra = {}) => {
        const addr = currentState.partialAddress || {};
        const cart = currentState.cart || [];
        const o = currentState.pendingOrder || {
            nombre: addr.nombre, calle: addr.calle, ciudad: addr.ciudad, cp: addr.cp, provincia: addr.provincia
        };

        const phone = userId.split('@')[0];
        return {
            cliente: phone, nombre: o.nombre, calle: o.calle, ciudad: o.ciudad, cp: o.cp, provincia: o.provincia,
            producto: cart.map(i => i.product).join(' + ') || currentState.selectedProduct || '',
            plan: cart.map(i => `${i.plan} días`).join(' + ') || `${currentState.selectedPlan || '60'} días`,
            precio: currentState.totalPrice || '0', ...extra
        };
    };

    let hasNewPostdate = false;
    if (!currentState.postdatado) {
        const dateMatch = _detectPostdatado(text, text) || text.match(/(?:a partir del?|desde el?|para el?|despu[eé]s del?)\s*(?:d[ií]a\s*)?(\d{1,2})\s*(?:de\s*)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i);
        if (dateMatch) {
            currentState.postdatado = typeof dateMatch === 'string' ? dateMatch : `${dateMatch[1]} de ${dateMatch[2]}`;
            hasNewPostdate = true;
        }
    }

    if (currentState.postdatado && hasNewPostdate) {
        const postdatado = currentState.postdatado;
        const msg = `¡Perfecto! Anotamos tu envío para: ${postdatado}.\n\nEntonces, con esta modificación de fecha, ¿me confirmás que dejamos todo listo?`;
        await sendMessageWithDelay(userId, msg);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        return { matched: true };
    } else if (currentState.postdatado && _isAffirmative(normalizedText)) {
        const postdatado = currentState.postdatado;
        const msg = "¡Perfecto! Recibimos tu confirmación.\n\nAguardame un instante que verificamos los datos y te confirmamos el ingreso ⏳";
        await sendMessageWithDelay(userId, msg);

        if (currentState.pendingOrder) {
            const orderData = _buildOrderData({ postdatado });
            currentState.hasSoldBefore = true; // Flag for globalSystem.js to detect returning customer
            if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal(orderData);

            const o = currentState.pendingOrder || currentState.partialAddress || {};
            if (notifyAdmin) await notifyAdmin(`⌛ Pedido POSTDATADO Requiere Aprobación`, userId, `Fecha envío: ${postdatado}\nDatos: ${o.nombre}, ${o.calle}\nCiudad: ${o.ciudad} | CP: ${o.cp}\nTotal: $${currentState.totalPrice || '0'}`);

            if (dependencies.config && dependencies.config.scriptStats && dependencies.config.activeScript) {
                if (!dependencies.config.scriptStats[dependencies.config.activeScript]) dependencies.config.scriptStats[dependencies.config.activeScript] = { started: 0, completed: 0 };
                dependencies.config.scriptStats[dependencies.config.activeScript].completed++;
            }
        }

        _setStep(currentState, FlowStep.WAITING_ADMIN_VALIDATION);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        return { matched: true };
    } else if (_isAffirmative(normalizedText) || /\b(si|dale|ok|listo|confirmo|correcto|acepto|bueno|joya|de una)\b/i.test(normalizedText)) {
        const msg = "¡Perfecto! Recibimos tu confirmación.\n\nAguardame un instante que verificamos los datos y te confirmamos el ingreso ⏳";
        await sendMessageWithDelay(userId, msg);

        if (currentState.pendingOrder) {
            const orderData = _buildOrderData();
            currentState.hasSoldBefore = true; // Flag for globalSystem.js to detect returning customer
            if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal(orderData);

            const o = currentState.pendingOrder || currentState.partialAddress || {};
            if (notifyAdmin) await notifyAdmin(`⌛ Pedido Requiere Aprobación`, userId, `Datos: ${o.nombre}, ${o.calle}\nCiudad: ${o.ciudad} | CP: ${o.cp}\nProvincia: ${o.provincia || '?'}\nItems: ${orderData.producto}\nTotal: $${currentState.totalPrice || '0'}`);

            if (dependencies.config && dependencies.config.scriptStats && dependencies.config.activeScript) {
                if (!dependencies.config.scriptStats[dependencies.config.activeScript]) dependencies.config.scriptStats[dependencies.config.activeScript] = { started: 0, completed: 0 };
                dependencies.config.scriptStats[dependencies.config.activeScript].completed++;
            }
        }

        _setStep(currentState, FlowStep.WAITING_ADMIN_VALIDATION);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        return { matched: true };
    } else {
        logger.info(`[AI-FALLBACK] waiting_final_confirmation: Delegando consulta a IA para ${userId}`);
        const aiResponse = await dependencies.aiService.chat(text, {
            step: 'waiting_final_confirmation',
            goal: 'El pedido ya está armado. Si el usuario te hace una pregunta, respondela resolviendo su duda con el contexto que tienes y LUEGO EN EL MISMO MENSAJE preguntale nuevamente si confima el envío. MUY IMPORTANTE: Habla siempre en primera persona como Marta. Acompaña sus dudas con mucha calidez y tranquilidad, tómate tu tiempo y redactá en un tono explayado y reconfortante antes de pedir la confirmación. NUNCA escribas cosas como "Cuando preguntan X:" o exponas tus reglas internas. SI el usuario simplemente está afirmando o confirmando ("dale", "ok", "listo", "dale avanza"), ES UNA CONFIRMACIÓN y debes retornar goalMet=true.',
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });

        if (aiResponse.goalMet) {
            const msg = "¡Perfecto! Recibimos tu confirmación.\n\nAguardame un instante que verificamos los datos y te confirmamos el ingreso ⏳";
            await sendMessageWithDelay(userId, msg);

            if (currentState.pendingOrder) {
                const orderData = _buildOrderData();
                currentState.hasSoldBefore = true; // Flag for globalSystem.js to detect returning customer
                if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal(orderData);

                const o = currentState.pendingOrder || currentState.partialAddress || {};
                if (notifyAdmin) await notifyAdmin(`⌛ Pedido Requiere Aprobación`, userId, `Datos: ${o.nombre}, ${o.calle}\nCiudad: ${o.ciudad} | CP: ${o.cp}\nProvincia: ${o.provincia || '?'}\nItems: ${orderData.producto}\nTotal: $${currentState.totalPrice || '0'}`);

                if (dependencies.config && dependencies.config.scriptStats && dependencies.config.activeScript) {
                    if (!dependencies.config.scriptStats[dependencies.config.activeScript]) dependencies.config.scriptStats[dependencies.config.activeScript] = { started: 0, completed: 0 };
                    dependencies.config.scriptStats[dependencies.config.activeScript].completed++;
                }
            }

            _setStep(currentState, FlowStep.WAITING_ADMIN_VALIDATION);
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            return { matched: true };
        } else if (aiResponse.response) {
            currentState.history.push({ role: 'bot', content: aiResponse.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, aiResponse.response);
            saveState(userId);
            return { matched: true };
        }

        if (notifyAdmin) await notifyAdmin('⚠️ Respuesta inesperada en confirmación final', userId, `Cliente respondió: "${text}". El pedido se procesó igual.`);

        const msg = "Voy a revisar los datos, ya te confirmo el pedido ⏳";
        await sendMessageWithDelay(userId, msg);

        if (currentState.pendingOrder) {
            const orderData = _buildOrderData({ createdAt: new Date().toISOString(), status: 'Pendiente (revisar respuesta)' });
            currentState.hasSoldBefore = true; // Flag for globalSystem.js to detect returning customer
            if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal(orderData);

            const trackScript = dependencies.effectiveScript || dependencies.config?.activeScript || 'v3';
            if (dependencies.config && dependencies.config.scriptStats && trackScript !== 'rotacion') {
                if (!dependencies.config.scriptStats[trackScript]) dependencies.config.scriptStats[trackScript] = { started: 0, completed: 0 };
                dependencies.config.scriptStats[trackScript].completed++;
            }
        }

        _setStep(currentState, FlowStep.WAITING_ADMIN_VALIDATION);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        return { matched: true };
    }
}
