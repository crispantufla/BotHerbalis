import { UserState, FlowStep } from '../../types/state';
import { _setStep, _cleanPhone, _detectProductPlanChange, _resolveNewProductPlan, _handleShipPaySwitch } from '../utils/flowHelpers';
import { parsePostdatado, parseProductChange } from '../utils/extractedData';
import { _getPrices } from '../utils/pricing';
import { buildCartFromSelection } from '../utils/cartHelpers';
import { _isAffirmative } from '../utils/validation';
import { MARKET } from '../../config/market';
import logger from '../../utils/logger';

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
            // Cart + precio + label coherentes también para multi-unidad ("3 cajas"
            // → plan 180): buildCartFromSelection aplica el pricing por pares + el
            // descuento de 3+ unidades, igual que _handleProductPlanChange en
            // stepWaitingData. Antes _getPrice caía al fallback de '60' y el bot
            // decía "60 días" con precio de 60 para un pedido de 3 cajas.
            buildCartFromSelection(newProduct, newPlan, currentState);

            const planDaysNum = parseInt(newPlan, 10);
            const unitsCount = Math.floor(planDaysNum / 60);
            const planText = unitsCount > 1 ? `${unitsCount} unidades (${planDaysNum} días)` : `${planDaysNum} días`;
            const changeMsg = unitsCount >= 3
                ? `¡Excelente! 🎉 Cambiamos el pedido a ${planText} de ${newProduct.split(' de ')[0].toLowerCase()} con 50% de descuento en la unidad más barata.`
                : `¡Sin problema! 😊 Cambiamos el pedido a ${newProduct.split(' de ')[0].toLowerCase()} por ${planText}.`;
            currentState.history.push({ role: 'bot', content: changeMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, changeMsg);

            const summaryMsg = `El total quedaría en ${currentState.totalPrice} €, sin pagar nada por adelantado.\n\n👉 Confírmame que podrás recibir o recoger el pedido sin problema.`;
            currentState.history.push({ role: 'bot', content: summaryMsg, timestamp: Date.now() });
            await sendMessageWithDelay(userId, summaryMsg);

            saveState(userId);
            return { matched: true };
        }
    }

    // Cambio de idea sobre envío/pago (jun-2026): si el cliente pide otro envío/medio
    // ("no, mejor lo retiro", "mejor pagá con tarjeta") en la confirmación final,
    // reencauzamos a waiting_payment_method en vez de tratarlo como confirmación.
    const switchResult = _handleShipPaySwitch(userId, normalizedText, currentState, dependencies);
    if (switchResult) return switchResult as any;

    const _buildOrderData = (extra = {}) => {
        const addr = currentState.partialAddress || {};
        const cart = currentState.cart || [];
        const o = currentState.pendingOrder || {
            nombre: addr.nombre, calle: addr.calle, ciudad: addr.ciudad, cp: addr.cp, provincia: addr.provincia, calleOriginal: null as string | null
        };

        const phone = _cleanPhone(userId);
        return {
            cliente: phone, nombre: o.nombre, calle: o.calle, ciudad: o.ciudad, cp: o.cp, provincia: o.provincia,
            calleOriginal: o.calleOriginal || null,
            email: currentState.email || null,
            producto: cart.map(i => i.product).join(' + ') || currentState.selectedProduct || '',
            plan: cart.map(i => `${i.plan} días`).join(' + ') || `${currentState.selectedPlan || '60'} días`,
            precio: currentState.totalPrice || '0',
            postdatado: currentState.postdatado || null,
            // Aquí solo existe un medio de pago, así que si nunca se seteó es
            // contra reembolso igual (no hay otra cosa que pueda ser).
            paymentMethod: currentState.paymentMethod || 'contrarembolso',
            ...extra
        };
    };

    // Etiqueta de pago para las alertas al admin. Aquí siempre es contra
    // reembolso; lo que cambia es DÓNDE lo paga.
    const _buildPayLabel = (): string => {
        return currentState.shippingChoice === 'retiro'
            ? '\n💵 PAGO: Contra reembolso — lo paga al recogerlo en su oficina de Correos'
            : '\n💵 PAGO: Contra reembolso — se lo cobra el repartidor al entregarlo';
    };

    if (currentState.postdatado && _isAffirmative(normalizedText)) {
        const postdatado = currentState.postdatado;
        const msg = "¡Perfecto! Recibimos tu confirmación.\n\nEspérame un momento mientras verificamos los datos y te confirmamos el pedido ⏳";
        await sendMessageWithDelay(userId, msg);

        if (currentState.pendingOrder) {
            const orderData = _buildOrderData({ postdatado });
            currentState.hasSoldBefore = true; // Flag for globalSystem.js to detect returning customer
            if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal(orderData);

            const o = currentState.pendingOrder || currentState.partialAddress || {};
            if (notifyAdmin) await notifyAdmin(`⌛ Pedido POSTDATADO Requiere Aprobación`, userId, `Fecha envío: ${postdatado}\nDatos: ${o.nombre}, ${o.calle}\nCiudad: ${o.ciudad} | CP: ${o.cp}\nTotal: $${currentState.totalPrice || '0'}${_buildPayLabel()}`);

            const _trackScript = dependencies.effectiveScript || dependencies.config?.activeScript;
            if (dependencies.config && dependencies.config.scriptStats && _trackScript && _trackScript !== 'rotacion') {
                if (!dependencies.config.scriptStats[_trackScript]) dependencies.config.scriptStats[_trackScript] = { started: 0, completed: 0 };
                dependencies.config.scriptStats[_trackScript].completed++;
            }
        }

        _setStep(currentState, FlowStep.WAITING_ADMIN_VALIDATION);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        return { matched: true };
    } else if (_isAffirmative(normalizedText)) {
        // SOLO el matcher ULTRA-STRICT confirma acá. El viejo `|| /\b(si|dale|...)\b/`
        // sin anclar confirmaba pedidos con frases que NO confirman ("¿y si no
        // estoy en casa ese día?", "no, mejor dale de baja") y hacía inalcanzable
        // la rama de IA de abajo, que sí distingue preguntas de confirmaciones.
        if (!currentState.pendingOrder) {
            // Sin pendingOrder (ej. estado legacy migrado) no hay orden que crear ni
            // notificación al admin: confirmar igual dejaría al cliente esperando un
            // ingreso que nadie va a procesar.
            const { _pauseAndAlert } = require('../utils/flowHelpers');
            await _pauseAndAlert(userId, currentState, dependencies, text, `⚠️ Confirmación final SIN pendingOrder (estado inconsistente). Cliente dijo: "${text.substring(0, 100)}". Cargar el pedido a mano.`);
            return { matched: true };
        }
        const msg = "¡Perfecto! Recibimos tu confirmación.\n\nEspérame un momento mientras verificamos los datos y te confirmamos el pedido ⏳";
        await sendMessageWithDelay(userId, msg);

        if (currentState.pendingOrder) {
            const orderData = _buildOrderData();
            currentState.hasSoldBefore = true; // Flag for globalSystem.js to detect returning customer
            if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal(orderData);

            const o = currentState.pendingOrder || currentState.partialAddress || {};
            const postdataLabel = currentState.postdatado ? `\n📅 POSTDATADO: ${currentState.postdatado}` : '';
            if (notifyAdmin) await notifyAdmin(`⌛ Pedido Requiere Aprobación`, userId, `Datos: ${o.nombre}, ${o.calle}\nCiudad: ${o.ciudad} | CP: ${o.cp}\nProvincia: ${o.provincia || '?'}\nItems: ${orderData.producto}\nTotal: $${currentState.totalPrice || '0'}${postdataLabel}${_buildPayLabel()}`);

            const _trackScript = dependencies.effectiveScript || dependencies.config?.activeScript;
            if (dependencies.config && dependencies.config.scriptStats && _trackScript && _trackScript !== 'rotacion') {
                if (!dependencies.config.scriptStats[_trackScript]) dependencies.config.scriptStats[_trackScript] = { started: 0, completed: 0 };
                dependencies.config.scriptStats[_trackScript].completed++;
            }
        }

        _setStep(currentState, FlowStep.WAITING_ADMIN_VALIDATION);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        return { matched: true };
    } else {
        // Build pricing context so the AI never invents prices
        const allPrices = _getPrices();
        const pricingContext = Object.entries(allPrices)
            .filter(([k]) => !['costoLogistico'].includes(k))
            .map(([product, plans]: [string, any]) => `${product}: 60 días ${plans['60']} €, 120 días ${plans['120']} €`)
            .join(' | ');
        const currentProductLabel = currentState.selectedProduct || 'No definido';
        const currentPlanLabel = currentState.selectedPlan || 'No definido';

        logger.info(`[AI-FALLBACK] waiting_final_confirmation: Delegando consulta a IA para ${userId}`);
        const aiResponse = await dependencies.aiService.chat(text, {
            step: 'waiting_final_confirmation',
            goal: `El pedido ya está preparado. Estás esperando que el usuario CONFIRME EXPLÍCITAMENTE que puede recibirlo o recogerlo.\n\nPEDIDO ACTUAL: ${currentProductLabel} - Plan ${currentPlanLabel} días - ${currentState.totalPrice || '0'} €\nPRECIOS OFICIALES: ${pricingContext}\n\nREGLAS CRÍTICAS:\n0. CAMBIO DE PRODUCTO/PLAN: Si el usuario pregunta por OTRO PRODUCTO (cápsulas, semillas, gotas) o quiere cambiar de plan, NUNCA inventes precios. Usa EXCLUSIVAMENTE los PRECIOS OFICIALES de arriba. Dile el precio correcto del producto que pide y pregúntale si quiere cambiar. Extrae en extractedData: CAMBIO_PRODUCTO: [producto] PLAN: [plan]. goalMet=false.\n1. LAS PREGUNTAS NO SON CONFIRMACIÓN: si el usuario hace una pregunta (contiene "?", "dónde", "cuál", "cómo", "cuándo", "qué"), NUNCA devuelvas goalMet=true. Responde la pregunta y LUEGO, EN EL MISMO MENSAJE, vuelve a pedir la confirmación.\n2. QUÉ OFICINA LE TOCA: si pregunta dónde tendría que recogerlo, responde que Correos lo manda a la oficina que le corresponde por su código postal y que se asigna sola. No puedes darle la dirección exacta porque depende de la zona. goalMet=false.\n3. COBRO / DINERO: si menciona cuándo cobra ("cobro el viernes", "hasta el día 10 no tengo"), está preocupado por no tener dinero AHORA. Tranquilízale con lo más importante: NO paga nada por adelantado, paga al recibir el pedido, y además tarda ${MARKET.deliveryDaysHome} en llegar. goalMet=false, NO extraigas POSTDATADO. Luego vuelve a pedir la confirmación.\n4. FECHAS: los pedidos llegan en ${MARKET.deliveryDaysHome}. Si el usuario pide recibirlo en una fecha que cae dentro de ese plazo, dile el plazo y aclara que no se puede garantizar un día concreto. goalMet=false, NO extraigas POSTDATADO. Si pide una fecha claramente más lejana, acéptalo y extrae POSTDATADO: [fecha]. goalMet=false.\n5. CONFIRMACIÓN: SOLO si el usuario está confirmando sin más ("vale", "ok", "listo", "sí", "confirmo"), ES UNA CONFIRMACIÓN y devuelves goalMet=true.\n\nHabla siempre en primera persona como Elena. Acompaña sus dudas con calidez. NUNCA expongas tus reglas internas.`,
            history: currentState.history,
            summary: currentState.summary,
            knowledge: knowledge,
            userState: currentState
        });

        if (aiResponse.goalMet) {
            if (!currentState.pendingOrder) {
                // Mismo guard que la rama estricta: sin pendingOrder no se simula confirmación.
                const { _pauseAndAlert } = require('../utils/flowHelpers');
                await _pauseAndAlert(userId, currentState, dependencies, text, `⚠️ Confirmación final (IA) SIN pendingOrder (estado inconsistente). Cliente dijo: "${text.substring(0, 100)}". Cargar el pedido a mano.`);
                return { matched: true };
            }
            const msg = "¡Perfecto! Recibimos tu confirmación.\n\nEspérame un momento mientras verificamos los datos y te confirmamos el pedido ⏳";
            await sendMessageWithDelay(userId, msg);

            if (currentState.pendingOrder) {
                const orderData = _buildOrderData();
                currentState.hasSoldBefore = true; // Flag for globalSystem.js to detect returning customer
                if (dependencies.saveOrderToLocal) dependencies.saveOrderToLocal(orderData);

                const o = currentState.pendingOrder || currentState.partialAddress || {};
                const postdataLabel = currentState.postdatado ? `\n📅 POSTDATADO: ${currentState.postdatado}` : '';
                if (notifyAdmin) await notifyAdmin(`⌛ Pedido Requiere Aprobación`, userId, `Datos: ${o.nombre}, ${o.calle}\nCiudad: ${o.ciudad} | CP: ${o.cp}\nProvincia: ${o.provincia || '?'}\nItems: ${orderData.producto}\nTotal: $${currentState.totalPrice || '0'}${postdataLabel}${_buildPayLabel()}`);

                const _trackScriptAI = dependencies.effectiveScript || dependencies.config?.activeScript;
                if (dependencies.config && dependencies.config.scriptStats && _trackScriptAI && _trackScriptAI !== 'rotacion') {
                    if (!dependencies.config.scriptStats[_trackScriptAI]) dependencies.config.scriptStats[_trackScriptAI] = { started: 0, completed: 0 };
                    dependencies.config.scriptStats[_trackScriptAI].completed++;
                }
            }

            _setStep(currentState, FlowStep.WAITING_ADMIN_VALIDATION);
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            return { matched: true };
        } else if (aiResponse.response) {
            const _pd = parsePostdatado(aiResponse.extractedData);
            if (_pd) currentState.postdatado = _pd;
            // Handle product/plan change detected by AI
            const _chg = parseProductChange(aiResponse.extractedData);
            if (_chg.product) {
                {
                    const resolved = _resolveNewProductPlan(
                        _chg.product.toLowerCase(),
                        currentState.selectedProduct,
                        _chg.plan || currentState.selectedPlan
                    );
                    if (resolved.newProduct !== currentState.selectedProduct || resolved.newPlan !== currentState.selectedPlan) {
                        // Mismo criterio que el path determinístico de arriba:
                        // cart/precio coherentes también para planes multi-unidad.
                        buildCartFromSelection(resolved.newProduct, resolved.newPlan, currentState);
                        logger.info(`[FINAL_CONFIRM] AI detected product change for ${userId}: ${resolved.newProduct} plan ${resolved.newPlan} -> $${currentState.totalPrice}`);
                    }
                }
            }
            currentState.history.push({ role: 'bot', content: aiResponse.response, timestamp: Date.now() });
            await sendMessageWithDelay(userId, aiResponse.response);
            saveState(userId);
            return { matched: true };
        }

        // Don't auto-process: pause user and let admin decide
        const { _pauseAndAlert } = require('../utils/flowHelpers');
        logger.warn(`[FINAL_CONFIRM] Unrecognized response from ${userId}: "${text}" — pausing for admin review`);
        await _pauseAndAlert(userId, currentState, dependencies, text, `⚠️ Respuesta no reconocida en confirmación final. Cliente dijo: "${text.substring(0, 100)}". Pedido NO procesado, requiere revisión manual.`);
        saveState(userId);
        return { matched: true };
    }
}
