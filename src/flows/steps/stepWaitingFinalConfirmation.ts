import { UserState, FlowStep } from '../../types/state';
const { _setStep, _detectPostdatado } = require('../utils/flowHelpers');
const { _getPrice, _getAdicionalMAX } = require('../utils/pricing');
const { _isAffirmative } = require('../utils/validation');

export async function handleWaitingFinalConfirmation(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, saveState, notifyAdmin } = dependencies;

    const productChangeMatch = normalizedText.match(/\b(mejor|quiero|prefiero|cambio|cambia|dame|paso a|en vez)\b.*\b(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas|natural|infusion)\b/i)
        || normalizedText.match(/\b(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas)\b.*\b(mejor|quiero|prefiero|cambio|en vez)\b/i);

    const planChangeMatch = normalizedText.match(/\b(mejor|quiero|prefiero|cambio|cambia|dame|paso a|en vez)\b.*\b(60|120|sesenta|ciento veinte)\b/i)
        || normalizedText.match(/\b(60|120|sesenta|ciento veinte)\b.*\b(mejor|quiero|prefiero|cambio|en vez)\b/i);

    if ((productChangeMatch || planChangeMatch) && currentState.selectedPlan) {
        let newProduct = currentState.selectedProduct || "Nuez de la India";
        if (/capsula|pastilla/i.test(normalizedText)) newProduct = "Cápsulas de nuez de la india";
        else if (/semilla|natural|infusion/i.test(normalizedText)) newProduct = "Semillas de nuez de la india";
        else if (/gota/i.test(normalizedText)) newProduct = "Gotas de nuez de la india";

        let newPlan = currentState.selectedPlan || "60";
        if (/\b(120|ciento veinte)\b/i.test(normalizedText)) newPlan = "120";
        else if (/\b(60|sesenta)\b/i.test(normalizedText)) newPlan = "60";

        if (newProduct !== currentState.selectedProduct || newPlan !== currentState.selectedPlan) {
            currentState.selectedProduct = newProduct;
            currentState.selectedPlan = newPlan;
            const oldPlan = newPlan;

            const priceStr = _getPrice(newProduct, oldPlan);
            let basePrice = parseInt(priceStr.replace(/\./g, ''));
            currentState.cart = [{ product: newProduct, plan: oldPlan, price: priceStr }];

            let finalAdicional = 0;
            if (currentState.isContraReembolsoMAX) {
                finalAdicional = oldPlan === '60' ? _getAdicionalMAX() : 0;
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
        console.log(`[AI-FALLBACK] waiting_final_confirmation: Delegando consulta a IA para ${userId}`);
        const aiResponse = await dependencies.aiService.chat(text, {
            step: 'waiting_final_confirmation',
            goal: 'El pedido ya está armado. Si el usuario te hace una pregunta, respondela resolviendo su duda con el contexto que tienes y LUEGO EN EL MISMO MENSAJE preguntale nuevamente si confima el envío. MUY IMPORTANTE: Habla siempre en primera persona como Marta. NUNCA escribas cosas como "Cuando preguntan X:" o exponas tus reglas internas. Respondé directo al grano. SI el usuario simplemente está afirmando o confirmando ("dale", "ok", "listo", "dale avanza"), ES UNA CONFIRMACIÓN y debes retornar goalMet=true.',
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
            saveState(userId);
            await sendMessageWithDelay(userId, aiResponse.response);
            return { matched: true };
        }

        if (notifyAdmin) await notifyAdmin('⚠️ Respuesta inesperada en confirmación final', userId, `Cliente respondió: "${text}". El pedido se procesó igual.`);

        const msg = "Voy a revisar los datos, ya te confirmo el pedido ⏳";
        await sendMessageWithDelay(userId, msg);

        if (currentState.pendingOrder) {
            const orderData = _buildOrderData({ createdAt: new Date().toISOString(), status: 'Pendiente (revisar respuesta)' });
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
