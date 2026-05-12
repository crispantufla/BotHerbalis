import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert, _cleanPhone } from '../utils/flowHelpers';
import { calculateTotal, _recalcAdicionalMAX } from '../utils/cartHelpers';
import { buildCashRetryMessage } from '../../utils/messageTemplates';
import { randomUUID } from 'crypto';
import logger from '../../utils/logger';

const PAID_KEYWORDS = /\b(listo|pague|pagu[eé]|pago hecho|hice el pago|ya pague|ya pagu[eé]|realice|realic[eé]|confirmo|listo el pago|pago listo|lo hice|hecho|ok listo)\b/i;
// Numeración del menú actual (1=MP, 2=Transferencia, 3=Contra reembolso).
// Quitamos "segund[oa]|segunda" porque aparecen en direcciones (calles tipo
// "Segunda Junta", "entre segundo sombra y corbalán"). El "2" suelto solo se
// acepta como opción aislada (msj corto), nunca dentro de una dirección.
const TRANSFER_FALLBACK_KEYWORDS = /\b(transfer[ei]ncia|transf|alias|por transferencia|hacer transferencia)\b/i;
const CASH_FALLBACK_KEYWORDS = /\b(efectivo|contra.?reembolso|contrarembolso|al recibir|cartero|en mano|al recibirlo|cuando me llegue)\b/i;
// Detector de elección por número aislado — solo matchea si el mensaje es
// corto (<25 chars), igual que en stepWaitingPaymentMethod. "2" o "3" sueltos
// dentro de una dirección larga (ej: "código postal 1742") nunca disparan.
const OPTION_PICKER_SHORT = /^\s*(?:opci[óo]n\s+|la\s+|el\s+)?(\d)\s*[\.\)]?\s*$/i;
function _detectShortOption(text: string): '1' | '2' | '3' | null {
    const trimmed = (text || '').trim();
    if (trimmed.length > 25) return null;
    const m = trimmed.match(OPTION_PICKER_SHORT);
    if (m && (m[1] === '1' || m[1] === '2' || m[1] === '3')) return m[1] as '1' | '2' | '3';
    return null;
}

export async function handleWaitingMpPayment(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    // ── ENTRY: Sin link todavía — generar y enviar ─────────────────────────────
    if (!currentState.mpPaymentLinkUrl) {
        await _generateAndSendLink(userId, currentState, knowledge, dependencies);
        return { matched: true };
    }

    // ── Cliente dice que pagó ──────────────────────────────────────────────────
    const normalizedForPaid = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (PAID_KEYWORDS.test(text) || PAID_KEYWORDS.test(normalizedForPaid)) {
        const verified = await _verifyPayment(currentState);

        if (verified === 'approved') {
            const addr = currentState.partialAddress || {};
            const hasAddress = !!(addr.nombre && addr.calle && addr.ciudad);

            if (hasAddress) {
                await _finalizeOrderAndNotifyAdmin(userId, currentState, dependencies);
            } else {
                // Política mayo 2026: si es flujo seña, marcamos senaPaid acá también.
                if (currentState.senaAmount && currentState.senaAmount > 0) {
                    currentState.senaPaid = true;
                }
                const isSenaFlow = !!(currentState.senaAmount && currentState.senaAmount > 0);
                const msg = isSenaFlow
                    ? '¡Perfecto, la seña fue confirmada! 🎉\n\nAhora necesito los datos de envío para despachar 👇\n\nNombre completo:\nCalle:\nNúmero:\nLocalidad:\nCódigo postal:'
                    : '¡Perfecto, el pago fue confirmado! 🎉\n\nAhora necesito los datos de envío para despachar tu pedido 👇\n\nNombre completo:\nCalle:\nNúmero:\nLocalidad:\nCódigo postal:';
                _setStep(currentState, FlowStep.WAITING_DATA);
                currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                saveState(userId);
                await sendMessageWithDelay(userId, msg);
            }
            return { matched: true };

        } else if (verified === 'pending') {
            const msg = '⏳ Todavía no veo el pago confirmado en el sistema.\n\nEsperá unos minutos y escribime *"listo"* cuando esté acreditado. Los pagos con tarjeta de crédito pueden demorar hasta 5 minutos.';
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
            return { matched: true };

        } else {
            // rejected o error — re-presentar el flujo MP con un mensaje empático.
            // Política mayo 2026: NO ofrecemos COD espontáneamente como alternativa.
            // Si la tarjeta falla, pueden reintentar con otra forma de pago dentro
            // del mismo link MP (efectivo en Pago Fácil/Rapipago, etc.).
            const wasSena = !!(currentState.senaAmount && currentState.senaAmount > 0);
            const msg = wasSena
                ? '⚠️ Hubo un problema con el pago de la seña — pudo ser la tarjeta o un rechazo del banco.\n\nProbá de nuevo con otra forma:\n✅ Tarjeta (en cuotas)\n✅ Débito\n✅ Saldo Mercado Pago\n✅ Efectivo en Pago Fácil / Rapipago\n\nTe genero un nuevo link para volver a intentarlo, decime cuando esté listo 😊'
                : '⚠️ Hubo un problema con el pago de MercadoPago — pudo ser la tarjeta o un rechazo del banco.\n\nProbá de nuevo con otra forma:\n✅ Tarjeta (en cuotas)\n✅ Débito\n✅ Saldo Mercado Pago\n✅ Efectivo en Pago Fácil / Rapipago\n\nTe genero un nuevo link para volver a intentarlo, decime cuando esté listo 😊';
            // Mantenemos senaAmount si era flujo seña — para regenerar link por $10k.
            currentState.mpPaymentLinkId = null;
            currentState.mpPaymentLinkUrl = null;
            // Seguimos en WAITING_MP_PAYMENT — el próximo mensaje del cliente
            // generará un link nuevo automáticamente (entry sin link).
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
            return { matched: true };
        }
    }

    // ── Cliente pide transferencia ─────────────────────────────────────────────
    // Solo aceptamos cambio a transferencia si:
    //   - El mensaje es corto y dice "2" / "opción 2"
    //   - O matchea keywords explícitas de transferencia
    // Direcciones largas que contienen "segundo" o un "2" aislado NO disparan.
    const shortOption = _detectShortOption(text);
    if (shortOption === '2' || TRANSFER_FALLBACK_KEYWORDS.test(normalizedText)) {
        const msg = `¡Perfecto! Para transferir usá el alias *CHILE.TEXTO.CASINO*. Una vez que realicés la transferencia avisanos por acá y coordinamos el envío 😊`;
        currentState.paymentMethod = 'transferencia';
        currentState.mpPaymentLinkId = null;
        currentState.mpPaymentLinkUrl = null;

        // adicionalMAX ya estaba bonificado por MP — transferencia también lo bonifica
        // Avanzar al step correcto. Antes quedaba en waiting_mp_payment y, si admin
        // despausaba al cliente, el siguiente mensaje volvía a generar link MP.
        _setStep(currentState, FlowStep.WAITING_TRANSFER_CONFIRMATION);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente cambió de MP a transferencia. Alias enviado, esperando confirmación.');
        return { matched: true };
    }

    // ── Cliente quiere contra reembolso ────────────────────────────────────────
    // Política mayo 2026: COD requiere SEÑA de $10k por MP. Si el cliente ya tenía
    // un link de MP por el total y quiere cambiar a COD, regeneramos el link por
    // $10k de seña (el flujo seña no permite saltearse la seña).
    if (shortOption === '3' || CASH_FALLBACK_KEYWORDS.test(normalizedText)) {
        currentState.paymentMethod = 'contrarembolso';
        currentState.mpPaymentLinkId = null;
        currentState.mpPaymentLinkUrl = null;
        currentState.senaAmount = 10000;
        currentState.senaPaid = false;
        // Ya no aplica adicionalMAX (política mayo 2026 — eliminado el adicional).
        const explainMsg = buildCashRetryMessage(currentState);
        currentState.history.push({ role: 'bot', content: explainMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, explainMsg);
        // Generar el link de seña ($10k) y enviarlo.
        await _generateAndSendLink(userId, currentState, knowledge, dependencies);
        saveState(userId);
        return { matched: true };
    }

    // ── Cliente pide que le reenvíen el link ───────────────────────────────────
    if (/\b(link|enlace|reenv[ií]a|reenviar|de nuevo|el link|manda|m[áa]ndame)\b/i.test(text) && currentState.mpPaymentLinkUrl) {
        const msg = `Acá está tu enlace de pago:\n\n${currentState.mpPaymentLinkUrl}\n\nCuando completes el pago escribime *"listo"* 👍`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
    }

    // ── Captura de dirección en paralelo ───────────────────────────────────────
    // El cliente puede mandar los datos de envío junto con (o antes de) confirmar el pago.
    // Parseamos y guardamos en partialAddress para que, cuando el pago se confirme,
    // saltemos directo a WAITING_FINAL_CONFIRMATION sin volver a pedir datos.
    const looksLikeAddress = /\d/.test(text) && text.split(/\s+/).length >= 3;
    if (looksLikeAddress) {
        try {
            const parsed = await aiService.parseAddress(text);
            if (parsed && !parsed._error && (parsed.nombre || parsed.calle || parsed.ciudad || parsed.cp || parsed.provincia)) {
                if (!currentState.partialAddress) currentState.partialAddress = {} as any;
                const pa: any = currentState.partialAddress;
                if (parsed.nombre && !pa.nombre) { pa.nombre = parsed.nombre; if (!currentState.userName) currentState.userName = parsed.nombre; }
                if (parsed.calle && !pa.calle) pa.calle = parsed.calle;
                if (parsed.ciudad && !pa.ciudad) pa.ciudad = parsed.ciudad;
                if (parsed.cp && !pa.cp) pa.cp = parsed.cp;
                if (parsed.provincia && !pa.provincia) pa.provincia = parsed.provincia;

                // ¿El pago ya se confirmó (via webhook) mientras mandaban datos?
                const verified = await _verifyPayment(currentState);
                const hasAddress = !!(pa.nombre && pa.calle && pa.ciudad);

                if (verified === 'approved' && hasAddress) {
                    await _finalizeOrderAndNotifyAdmin(userId, currentState, dependencies);
                    return { matched: true };
                }

                // Pago todavía no confirmado: guardamos datos y seguimos esperando
                const missing: string[] = [];
                if (!pa.nombre) missing.push('Nombre completo');
                if (!pa.calle) missing.push('Calle y número');
                if (!pa.ciudad) missing.push('Localidad');
                if (!pa.cp) missing.push('Código postal');

                const ackMsg = missing.length > 0
                    ? `¡Gracias! Ya tengo tus datos. Me faltaría:\n\n${missing.map(m => `• ${m}`).join('\n')}\n\nY avisame cuando completes el pago 💳`
                    : `¡Perfecto! Ya tengo todos los datos de envío anotados 📦\n\nEn cuanto se acredite el pago armo el pedido. Avisame con *"listo"* cuando completes el pago 💳`;
                currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
                saveState(userId);
                await sendMessageWithDelay(userId, ackMsg);
                return { matched: true };
            }
        } catch (e: any) {
            logger.warn('[MP_PAYMENT] parseAddress falló, cayendo a AI fallback:', e.message);
        }
    }

    // ── AI fallback ────────────────────────────────────────────────────────────
    const aiRes = await aiService.chat(text, {
        step: 'waiting_mp_payment',
        goal: `El cliente tiene un enlace de pago de MercadoPago y debe completarlo. Enlace ya enviado: ${currentState.mpPaymentLinkUrl}\n\nSi tiene dudas, explicale cómo pagar (tarjeta, app MP, QR). Si quiere cambiar a transferencia, decile que el alias es CHILE.TEXTO.CASINO. Si quiere contra reembolso, aclará que se paga al cartero. NUNCA reenvíes el link a menos que lo pida. Esperá que confirme con "listo" o "ya pagué".`,
        history: currentState.history,
        summary: currentState.summary,
        knowledge,
        userState: currentState
    });

    if (aiRes.response) {
        currentState.history.push({ role: 'bot', content: aiRes.response, timestamp: Date.now() });
        await sendMessageWithDelay(userId, aiRes.response);
        saveState(userId);
        return { matched: true };
    }

    await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente en waiting_mp_payment — sin respuesta del bot.');
    return { matched: true };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function _generateAndSendLink(
    userId: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<void> {
    const { sendMessageWithDelay, saveState } = dependencies;
    const instanceId = dependencies.sellerId || 'default';

    const mpToken = process.env.MP_ACCESS_TOKEN;
    if (!mpToken) {
        logger.warn('[MP_PAYMENT] MP_ACCESS_TOKEN no configurado — fallback a contra reembolso');
        currentState.paymentMethod = 'contrarembolso';
        // adicionalMAX fue waiveado al elegir MP — restaurarlo ahora que volvemos a CR
        _recalcAdicionalMAX(currentState);
        calculateTotal(currentState);
        const msg = _getClosingMsg(knowledge);
        _setStep(currentState, FlowStep.WAITING_DATA);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return;
    }

    try {
        // Política mayo 2026: si state.senaAmount está seteado, el link es por la SEÑA
        // (típicamente $10.000 para COD) — no por el total. El saldo lo cobra el cartero.
        const isSena = !!(currentState.senaAmount && currentState.senaAmount > 0);
        let totalRaw = currentState.totalPrice;
        let amount: number;

        if (isSena) {
            amount = currentState.senaAmount as number;
        } else {
            amount = typeof totalRaw === 'string'
                ? parseFloat(totalRaw.replace(/\./g, '').replace(',', '.'))
                : Number(totalRaw || 0);

            // Última red: si totalPrice viene corrupto pero cart tiene items, intentar
            // recalcular antes de fallar. Esto rescató al cliente de un fallback ciego
            // a contra-reembolso/transferencia cuando había elegido MP.
            if ((!amount || amount <= 0) && currentState.cart && currentState.cart.length > 0) {
                logger.warn(`[MP_PAYMENT] totalPrice inválido (${totalRaw}) — recalculando desde cart antes de fallar`);
                const recalculated = calculateTotal(currentState);
                totalRaw = recalculated;
                amount = parseFloat(recalculated.replace(/\./g, '').replace(',', '.'));
            }
        }

        if (!amount || amount <= 0) throw new Error('Monto inválido');

        const { MercadoPagoConfig, Preference } = require('mercadopago');
        const externalRef = randomUUID();
        const webhookUrl = process.env.MP_WEBHOOK_URL;
        const mpClient = new MercadoPagoConfig({ accessToken: mpToken });
        const preference = new Preference(mpClient);
        const itemTitle = isSena ? 'Seña Herbalis (pago al recibir)' : 'Pago Herbalis';
        const body: any = {
            items: [{ title: itemTitle, quantity: 1, unit_price: amount, currency_id: 'ARS' }],
            back_urls: { success: 'https://herbalis.com.ar', failure: 'https://herbalis.com.ar', pending: 'https://herbalis.com.ar' },
            auto_return: 'approved',
            external_reference: externalRef,
        };
        if (webhookUrl) body.notification_url = webhookUrl;

        const response = await preference.create({ body });
        const link = response.init_point;

        // Persistir en DB
        const { prisma } = require('../../../db');
        const cleanPhone = _cleanPhone(userId);
        const record = await prisma.paymentLink.create({
            data: {
                preferenceId: response.id,
                externalRef,
                amount,
                link,
                userPhone: cleanPhone,
                source: isSena ? 'bot_flow_sena' : 'bot_flow',
                status: 'pending',
                instanceId,
            }
        });

        currentState.mpPaymentLinkId = record.id;
        currentState.mpPaymentLinkUrl = link;
        saveState(userId);

        const productName = currentState.cart?.map((i: any) => i.product).join(' + ')
            || currentState.selectedProduct?.split(' de ')[0]
            || 'Herbalis';

        const msg = isSena
            ? `💳 *Pago al recibir — link de seña*\n\n` +
                `Pedido: *${productName}* — Plan ${currentState.selectedPlan} días\n` +
                `Total del pedido: *$${currentState.totalPrice}*\n` +
                `Seña por Mercado Pago: *$${amount.toLocaleString('es-AR').replace(/,/g, '.')}*\n` +
                `Saldo al cartero (efectivo): *$${(parseInt(String(currentState.totalPrice).replace(/\./g, ''), 10) - amount).toLocaleString('es-AR').replace(/,/g, '.')}*\n\n` +
                `👇 Pagá la seña acá:\n${link}\n\n` +
                `Podés usar tarjeta (en cuotas), débito, saldo MP o efectivo en Pago Fácil / Rapipago.\n\n` +
                `✅ Cuando termines, escribime *"listo"* y verifico el pago.\n\n` +
                `Mientras tanto, pasame los datos de envío 👇\n\nNombre completo:\nCalle y número:\nLocalidad:\nCódigo postal:\nProvincia:`
            : `💳 *Pago online via MercadoPago*\n\n` +
                `Pedido: *${productName}* — Plan ${currentState.selectedPlan} días\n` +
                `Total: *$${currentState.totalPrice}*\n\n` +
                `👇 Hacé clic para pagar de forma segura:\n${link}\n\n` +
                `Podés pagar con tarjeta (en cuotas), débito, saldo MP o efectivo en Pago Fácil / Rapipago.\n\n` +
                `✅ Cuando termines el pago, escribime *"listo"* y verifico que ingresó.\n\n` +
                `Mientras tanto, pasame los datos de envío para tener todo listo 👇\n\nNombre completo:\nCalle y número:\nLocalidad:\nCódigo postal:\nProvincia:`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);
        logger.info(`[MP_PAYMENT] Link ${isSena ? 'SEÑA' : ''} creado para ${userId} — $${amount} ARS — ${link}`);

    } catch (e: any) {
        logger.error('[MP_PAYMENT] Error generando link:', e.message);
        // El cliente eligió MP — NO ofrecemos alternativas (CR tiene 9× más cancelación).
        // Pausamos y alertamos al admin para que genere el link manual desde el panel
        // y se lo mande al cliente. Mantenemos paymentMethod=mercadopago para que el
        // admin vea claro qué método quería el cliente.
        currentState.mpPaymentLinkId = null;
        currentState.mpPaymentLinkUrl = null;
        const msg = 'Permitime un momento, estoy generando tu enlace de pago de MercadoPago 🙂\n\nEn unos minutos te lo paso por acá. ¡Gracias por la paciencia!';
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        await _pauseAndAlert(userId, currentState, dependencies, '', 'FALLO AL GENERAR ENLACE DE MP');
    }
}

async function _verifyPayment(currentState: UserState): Promise<'approved' | 'pending' | 'rejected'> {
    if (!currentState.mpPaymentLinkId) return 'pending';

    try {
        const { prisma } = require('../../../db');
        const record = await prisma.paymentLink.findUnique({ where: { id: currentState.mpPaymentLinkId } });
        if (!record) return 'pending';

        // Webhook ya actualizó el estado
        if (record.status === 'approved') return 'approved';
        if (record.status === 'rejected' || record.status === 'expired') return 'rejected';

        // Consultar MP directamente
        const mpToken = process.env.MP_ACCESS_TOKEN;
        if (!mpToken) return 'pending';

        const { MercadoPagoConfig, Payment } = require('mercadopago');
        const mpClient = new MercadoPagoConfig({ accessToken: mpToken });
        const mpPayment = new Payment(mpClient);
        const result = await mpPayment.search({ options: { filters: { external_reference: record.externalRef } } });
        const results = result?.results || [];
        if (results.length === 0) return 'pending';

        const approved = results.find((p: any) => p.status === 'approved');
        if (approved) {
            await prisma.paymentLink.update({
                where: { id: record.id },
                data: { status: 'approved', paidAt: new Date(approved.date_approved || Date.now()) }
            });
            return 'approved';
        }

        const rejected = results.find((p: any) => p.status === 'rejected' || p.status === 'cancelled');
        if (rejected) {
            await prisma.paymentLink.update({ where: { id: record.id }, data: { status: 'rejected' } });
            return 'rejected';
        }

        return 'pending';
    } catch (e: any) {
        logger.error('[MP_PAYMENT] Error verificando pago:', e.message);
        return 'pending';
    }
}

async function _finalizeOrderAndNotifyAdmin(
    userId: string,
    currentState: UserState,
    dependencies: any
): Promise<void> {
    const { sendMessageWithDelay, saveState, notifyAdmin, saveOrderToLocal, config, effectiveScript } = dependencies;
    const addr: any = currentState.partialAddress || {};

    calculateTotal(currentState);
    currentState.pendingOrder = {
        nombre: addr.nombre,
        calle: addr.calle,
        ciudad: addr.ciudad,
        cp: addr.cp,
        provincia: addr.provincia,
        calleOriginal: addr.calleOriginal || addr.calle,
        cart: currentState.cart
    };

    // Política mayo 2026: si state.senaAmount está seteado, el pago confirmado
    // es una SEÑA de COD ($10k típico) — no el total. El método de pago final
    // sigue siendo 'contrarembolso' (el cartero cobra el saldo en efectivo).
    const isSenaFlow = !!(currentState.senaAmount && currentState.senaAmount > 0);
    if (isSenaFlow) {
        currentState.senaPaid = true;
        // paymentMethod ya estaba seteado a 'contrarembolso' en stepWaitingPaymentMethod
    }

    const cart = currentState.cart || [];
    const phone = userId.split('@')[0];
    const totalInt = parseInt(String(currentState.totalPrice || '0').replace(/\./g, ''), 10) || 0;
    const senaInt = currentState.senaAmount || 0;
    const cashRemainder = isSenaFlow ? Math.max(0, totalInt - senaInt) : 0;

    const orderData = {
        cliente: phone,
        nombre: addr.nombre,
        calle: addr.calle,
        ciudad: addr.ciudad,
        cp: addr.cp,
        provincia: addr.provincia,
        calleOriginal: addr.calleOriginal || null,
        producto: cart.map((i: any) => i.product).join(' + ') || currentState.selectedProduct || '',
        plan: cart.map((i: any) => `${i.plan} días`).join(' + ') || `${currentState.selectedPlan || '60'} días`,
        precio: currentState.totalPrice || '0',
        postdatado: currentState.postdatado || null,
        paymentMethod: isSenaFlow ? 'contrarembolso' : 'mercadopago',
        ...(isSenaFlow ? { senaAmount: senaInt, senaPaid: true, cashRemainder } : {})
    };
    currentState.hasSoldBefore = true;
    if (saveOrderToLocal) saveOrderToLocal(orderData);

    const postdataLabel = currentState.postdatado ? `\n📅 POSTDATADO: ${currentState.postdatado}` : '';
    const senaFmt = senaInt.toLocaleString('es-AR').replace(/,/g, '.');
    const cashFmt = cashRemainder.toLocaleString('es-AR').replace(/,/g, '.');
    const payLabel = isSenaFlow
        ? `\n💳 PAGO: Contra reembolso con SEÑA — $${senaFmt} pagados por MP, cartero cobra $${cashFmt} en efectivo`
        : '\n💳 PAGO: MercadoPago (ya abonado)';
    if (notifyAdmin) {
        await notifyAdmin(
            `⌛ Pedido Requiere Aprobación`,
            userId,
            `Datos: ${addr.nombre}, ${addr.calle}\nCiudad: ${addr.ciudad} | CP: ${addr.cp}\nProvincia: ${addr.provincia || '?'}\nItems: ${orderData.producto}\nTotal: $${currentState.totalPrice || '0'}${postdataLabel}${payLabel}`
        );
    }

    const _trackScript = effectiveScript || config?.activeScript;
    if (config && config.scriptStats && _trackScript && _trackScript !== 'rotacion') {
        if (!config.scriptStats[_trackScript]) config.scriptStats[_trackScript] = { started: 0, completed: 0 };
        config.scriptStats[_trackScript].completed++;
    }

    _setStep(currentState, FlowStep.WAITING_ADMIN_VALIDATION);
    const msg = isSenaFlow
        ? `¡Perfecto, la seña fue confirmada y ya tengo tus datos! 🎉\n\nDespachamos en breve. El cartero te va a cobrar el saldo de *$${cashFmt}* en efectivo cuando reciba el paquete.\n\nAguardame un instante que verificamos todo ⏳`
        : '¡Perfecto, el pago fue confirmado y ya tengo tus datos! 🎉\n\nAguardame un instante que verificamos todo y te confirmamos el ingreso ⏳';
    currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, msg);
}

function _getClosingMsg(knowledge: any): string {
    return knowledge?.flow?.closing?.response ||
        'Perfecto! Pasame los datos para armar la etiqueta de envío 👇\n\nNombre completo:\nCalle:\nNúmero:\nLocalidad:\nCódigo postal:';
}
