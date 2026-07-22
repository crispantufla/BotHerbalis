import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert, _cleanPhone } from '../utils/flowHelpers';
import { calculateTotal } from '../utils/cartHelpers';
import { getFlowTemplate } from '../../utils/messageTemplates';
import { _formatMessage } from '../utils/messages';
import { randomUUID } from 'crypto';
import logger from '../../utils/logger';

// Exportada: globalFaq la usa para NO tragarse un aviso de pago que venga con
// una pregunta pegada ("Ya pagué ¿me confirmás?") — debe ver exactamente los
// mismos claims que este step.
export const PAID_KEYWORDS = /\b(listo|pague|pagu[eé]|pago hecho|hice el pago|ya pague|ya pagu[eé]|realice|realic[eé]|confirmo|listo el pago|pago listo|lo hice|hecho|ok listo)\b/i;
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

    // ── ENTRY: Sin link todavía — generar y mandar directo ────────────────────
    // Rev. 2026-05-27: ya no pedimos email antes del link (era fricción innecesaria).
    // El email se sigue capturando silenciosamente si el cliente lo deja caer en el
    // mensaje de datos de envío (ver stepWaitingData._DATA_EMAIL_RE). Sin email
    // MP igual genera el link — payer.email es opcional en la API de preferences.
    if (!currentState.mpPaymentLinkUrl) {
        await _generateAndSendLink(userId, currentState, knowledge, dependencies);
        return { matched: true };
    }

    // ── Cliente dice que pagó ──────────────────────────────────────────────────
    const normalizedForPaid = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (PAID_KEYWORDS.test(text) || PAID_KEYWORDS.test(normalizedForPaid)) {
        const verified = await _verifyPayment(currentState);

        if (verified === 'approved') {
            // Marcamos senaPaid=true APENAS verificamos approved (sin importar
            // si hay dirección o no). Antes solo se seteaba en el branch
            // !hasAddress; si llegaba el address junto con el pago, el flag
            // quedaba en false y la orden no reflejaba que la seña fue cobrada.
            if (currentState.senaAmount && currentState.senaAmount > 0) {
                currentState.senaPaid = true;
            }
            const addr = currentState.partialAddress || {};
            const hasAddress = !!(addr.nombre && addr.calle && addr.ciudad);

            if (hasAddress) {
                await _finalizeOrderAndNotifyAdmin(userId, currentState, dependencies);
            } else {
                // Tomamos la copia de pedido de datos del knowledge — el panel Guiones
                // muestra la entry `flow.closing` y los vendedores la editan ahí. Si
                // por alguna razón no existe (mock parcial), usamos fallback fijo.
                // Modelo nuevo (may-2026): seña $10k eliminada — sólo la mantenemos
                // como compat para Orders pre-may-2026 con senaAmount>0. En ese caso
                // el prefijo dice "seña confirmada" para no confundir al cliente.
                const closingTpl = getFlowTemplate('closing', knowledge);
                const dataMsg = closingTpl
                    ? _formatMessage(closingTpl, currentState)
                    : '¡Perfecto! 🎉 Ahora necesito los datos de envío:\n\nNombre completo:\nCalle y número:\nLocalidad:\nCódigo postal:\nEmail (opcional, para el comprobante de MP):';
                const isSenaFlow = !!(currentState.senaAmount && currentState.senaAmount > 0);
                const prefix = isSenaFlow
                    ? '¡Perfecto, la seña fue confirmada! 🎉\n\n'
                    : '¡Perfecto, el pago fue confirmado! 🎉\n\n';
                const msg = prefix + dataMsg;
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
            // Acá NO ofrecemos cambiar a COD: si la tarjeta falla, pueden reintentar
            // con otra forma dentro del mismo link MP (tarjeta de crédito, débito,
            // saldo MP, etc.). Si quieren cambiar a COD o transferencia, lo deben
            // pedir explícitamente y el handler de arriba (CASH_FALLBACK_KEYWORDS /
            // TRANSFER_FALLBACK_KEYWORDS) los enruta correctamente.
            // Modelo nuevo (may-2026): el retry siempre usa el template payment_mp_retry
            // (sin diferenciar seña). Las plantillas _sena fueron eliminadas en V5/V6.
            // Si state.senaAmount > 0 (Order legacy), el mensaje neutro sirve igual:
            // el cliente reintenta el link y la cobranza del saldo legacy se coordina
            // por admin via _pauseAndAlert (no por el bot).
            const tpl = getFlowTemplate('payment_mp_retry', knowledge);
            const msg = tpl
                ? _formatMessage(tpl, currentState)
                : '⚠️ Hubo un problema con el pago — probá de nuevo con tu tarjeta de crédito, o decime si preferís transferencia o retiro en sucursal.';
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
        const transferTpl = getFlowTemplate('payment_transfer_alias', knowledge) ||
            `¡Perfecto! Para transferir usá el alias *{{ALIAS}}* a nombre de *{{TITULAR}}* 🏦\n\nMonto: ${'$'}{{TOTAL}}\n\nUna vez que realices la transferencia, escribime *"listo"* y coordinamos el envío 😊`;
        const msg = _formatMessage(transferTpl, currentState);
        currentState.paymentMethod = 'transferencia';
        currentState.mpPaymentLinkId = null;
        currentState.mpPaymentLinkUrl = null;

        // Avanzar al step correcto. Antes quedaba en waiting_mp_payment y, si admin
        // despausaba al cliente, el siguiente mensaje volvía a generar link MP.
        _setStep(currentState, FlowStep.WAITING_TRANSFER_CONFIRMATION);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente cambió de MP a transferencia. Alias enviado, esperando confirmación.');
        return { matched: true };
    }

    // ── Cliente quiere contra reembolso / retiro en sucursal ──────────────────
    // Modelo nuevo (may-2026): contrarrembolso = retiro en sucursal, paga total
    // al retirar (sin anticipo). Limpiamos el link MP y mandamos directo al
    // payment_retiro_confirm + pausa para coordinación admin.
    if (shortOption === '3' || CASH_FALLBACK_KEYWORDS.test(normalizedText)) {
        currentState.paymentMethod = 'contrarembolso';
        currentState.mpPaymentLinkId = null;
        currentState.mpPaymentLinkUrl = null;
        currentState.senaAmount = 0;
        currentState.senaPaid = false;
        currentState.shippingChoice = 'retiro';

        // Salir de waiting_mp_payment (igual que el branch de transferencia): si
        // nos quedamos acá, el scheduler lo sigue tratando como "MP pendiente" y,
        // si una pausa se pierde en un restart, le dispara los nudges de "pago con
        // tarjeta pendiente" días después — aunque ya pasó a contrarembolso/retiro.
        // mpReminderStage=99 es el sentinel para apagar los recordatorios de MP.
        (currentState as any).mpReminderStage = 99;
        _setStep(currentState, FlowStep.WAITING_TRANSFER_CONFIRMATION);

        const tpl = getFlowTemplate('payment_retiro_confirm', knowledge) ||
            `¡Perfecto! Lo dejamos para retiro en sucursal 📦\n\nVas a pagar el total *${'$'}{{TOTAL}}* en efectivo cuando lo retirés.\n\nUn asesor te contacta enseguida para coordinar la sucursal más cercana 😊`;
        const msg = _formatMessage(tpl, currentState);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, msg);

        const addr: any = currentState.partialAddress || {};
        const addrSummary = [addr.calle, addr.ciudad, addr.cp].filter(Boolean).join(', ') || 'sin dirección';
        await _pauseAndAlert(
            userId, currentState, dependencies, text,
            `Cliente cambió de MP a RETIRO EN SUCURSAL. Coordinar sucursal de Correo Argentino más cercana a: ${addrSummary}. Paga el total $${currentState.totalPrice || '?'} en efectivo al retirar.`
        );
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
        goal: `El cliente tiene un enlace de pago de MercadoPago y debe completarlo. Enlace ya enviado: ${currentState.mpPaymentLinkUrl}\n\nSi tiene dudas, explicale que el link es para pagar con tarjeta de crédito (es online y 100% protegido).\n\nALTERNATIVAS si quiere cambiar de método (modelo nuevo may-2026):\n- Transferencia (envío a domicilio prepago): alias *HERBALIS.TIENDA* a nombre de *BIO ORIGEN S.A.S.*\n- Retiro en sucursal (contrarrembolso): paga el TOTAL en efectivo al retirar en una sucursal de Correo Argentino. Sin anticipo previo.\n- NUNCA menciones anticipo de $10.000 (modalidad eliminada).\n\n🔴 OBJECIÓN ECONÓMICA / POSTERGAR PAGO (CRÍTICO):\nSi el cliente dice cosas como "veo después de juntar el efectivo", "cuando cobre", "cuando tenga plata", "cuando consiga el dinero", "es mucho interés", "ahora no puedo", "apenas tenga me comunico", "me alcance la plata", NO INTERPRETES eso como confirmación. Es una OBJECIÓN ECONÓMICA y debés ofrecer POSTDATADO:\n  → "¡Tranqui! ¿A partir de qué día te queda cómodo recibirlo? Te lo agendamos y lo despacho recién ese día." (PROHIBIDO mencionar "congelar precio")\n  → Si dice SÍ → goalMet=false, extractedData="POSTDATADO: [fecha o 'indefinido']", quedate en este step esperando el aviso.\n  → Si dice NO → goalMet=false, dejá el chat abierto sin presión.\n\nNUNCA reenvíes el link a menos que lo pida. NUNCA respondas con "Excelente decisión!" o frases de cierre cuando el cliente claramente está posponiendo. Esperá que confirme el pago con "listo" o "ya pagué".`,
        history: currentState.history,
        summary: currentState.summary,
        knowledge,
        userState: currentState
    });

    if (aiRes.response) {
        currentState.history.push({ role: 'bot', content: aiRes.response, timestamp: Date.now() });
        await sendMessageWithDelay(userId, aiRes.response);
        saveState(userId);

        // Manejo de flags semánticos del AI (modelo viejo no los procesaba).
        const ed = String(aiRes.extractedData || '');
        if (ed.includes('POSTPONE_INDEFINITE')) {
            // El cliente avisó explícitamente que va a cobrar/avisar — apagamos
            // los recordatorios automáticos del scheduler (Stage 4+ no dispara).
            (currentState as any).mpReminderStage = 99;
            (currentState as any).mpPostponedAt = Date.now();
            saveState(userId);
            logger.info(`[MP_PAYMENT] User ${userId} marked POSTPONE_INDEFINITE — disabling nudges.`);
        }
        if (ed.includes('NEED_ADMIN')) {
            await _pauseAndAlert(userId, currentState, dependencies, text, 'IA detectó confusión / venta fantasma en waiting_mp_payment. El cliente cree que hay pedido cargado y no lo hay, o está esperando algo sin acción posible del bot. Revisar y aclarar manualmente.');
        }

        return { matched: true };
    }

    await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente en waiting_mp_payment — sin respuesta del bot.');
    return { matched: true };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Cuántos intentos hacemos al MP API antes de pausar. Cubre blips transitorios
// (5xx, network glitches, rate limits cortos). El backoff entre intentos lo
// blockea a este worker en particular, no a otros clientes — cada usuario tiene
// su propia cola de procesamiento en BullMQ.
const MP_LINK_MAX_ATTEMPTS = 2;
const MP_LINK_RETRY_DELAY_MS = 3000;

async function _generateAndSendLink(
    userId: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<void> {
    const { sendMessageWithDelay, saveState } = dependencies;

    // GUARD DE COHERENCIA (caso 1131381951): nunca generar un link de pago si el
    // producto elegido no está claro en el estado. Si selectedProduct quedó null
    // y el cart vacío, calculateTotal/_getPrice defaultean silenciosamente a
    // Semillas (pricing.ts) → el link sale con producto/precio EQUIVOCADO (la
    // huella exacta del bug: "Semillas $36.900" cuando eligió Cápsulas). Mejor
    // pausar y que un humano lo revise que cobrarle al cliente algo que no pidió.
    const hasProduct = !!currentState.selectedProduct
        || (Array.isArray(currentState.cart) && currentState.cart.length > 0);
    if (!hasProduct) {
        logger.error(`[MP_PAYMENT] ${userId} sin selectedProduct/cart al generar link — abortando para no cobrar el producto equivocado.`);
        await _pauseAndAlert(
            userId, currentState, dependencies, '',
            '⚠️ COHERENCIA: se iba a generar un link de pago SIN producto elegido en el estado (riesgo de cobrar producto/precio equivocado, ej. default a Semillas). NO se envió link — revisá la elección del cliente y cargá el pedido a mano.'
        );
        return;
    }

    const mpToken = process.env.MP_ACCESS_TOKEN;
    if (!mpToken) {
        logger.warn('[MP_PAYMENT] MP_ACCESS_TOKEN no configurado — fallback a contra reembolso');
        currentState.paymentMethod = 'contrarembolso';
        calculateTotal(currentState);
        const msg = _getClosingMsg(knowledge);
        _setStep(currentState, FlowStep.WAITING_DATA);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return;
    }

    // Loop de reintentos: si MP falla por un blip transitorio, esperamos 3s y
    // probamos una vez más antes de rendirnos y pausar al cliente.
    let lastError: any = null;
    for (let attempt = 1; attempt <= MP_LINK_MAX_ATTEMPTS; attempt++) {
        try {
            await _tryCreateAndSendMpLink(userId, currentState, knowledge, dependencies);
            return; // éxito
        } catch (e: any) {
            lastError = e;
            logger.error(`[MP_PAYMENT] Error generando link (intento ${attempt}/${MP_LINK_MAX_ATTEMPTS}) para ${userId}: ${e.message}`);
            if (attempt < MP_LINK_MAX_ATTEMPTS) {
                await new Promise(r => setTimeout(r, MP_LINK_RETRY_DELAY_MS));
            }
        }
    }

    // Todos los intentos fallaron — pausamos al cliente con el error específico
    // para que el admin pueda diagnosticar (token vencido, monto inválido, MP 5xx, etc.).
    currentState.mpPaymentLinkId = null;
    currentState.mpPaymentLinkUrl = null;
    const errMsg = (lastError?.message || 'desconocido').slice(0, 200);
    const failedTpl = getFlowTemplate('payment_mp_failed', knowledge) ||
        `Tuve un problema técnico generando el link de pago 😕\n\nEn un momento te contacta un asesor para resolverlo. Disculpá la molestia 🙏`;
    const msg = _formatMessage(failedTpl, currentState);
    currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, msg);
    await _pauseAndAlert(
        userId, currentState, dependencies, '',
        `FALLO AL GENERAR ENLACE DE MP (${MP_LINK_MAX_ATTEMPTS} intentos). Error: ${errMsg}`
    );
}

/**
 * Una única tentativa de crear y enviar el link MP. Lanza si MP API o el
 * upsert en DB falla — el caller decide si reintentar.
 */
async function _tryCreateAndSendMpLink(
    userId: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<void> {
    const { sendMessageWithDelay, saveState } = dependencies;
    const instanceId = dependencies.sellerId || 'default';

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
        // recalcular antes de fallar.
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
    const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const preference = new Preference(mpClient);
    const itemTitle = isSena ? 'Seña Herbalis (pago al recibir)' : 'Pago Herbalis';
    const body: any = {
        items: [{ title: itemTitle, quantity: 1, unit_price: amount, currency_id: 'ARS' }],
        back_urls: { success: 'https://herbalis.com.ar', failure: 'https://herbalis.com.ar', pending: 'https://herbalis.com.ar' },
        auto_return: 'approved',
        external_reference: externalRef,
    };
    if (webhookUrl) body.notification_url = webhookUrl;
    // Pre-llenar email del pagador si lo capturamos. MP usa esto para mandar
    // el comprobante automático + pre-llenar el formulario de checkout.
    if (currentState.email) {
        body.payer = { email: currentState.email };
    }

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

    // El _formatMessage usa cart para PRODUCT, pero también permitimos override con
    // el productName ya computado (multi-item ya viene unificado en cart map).
    //
    // Modelo nuevo (may-2026): siempre se usa payment_mp_link. Las plantillas _sena
    // fueron eliminadas de V5/V6. Si state.senaAmount > 0 (Order legacy), el bot
    // genera el link por ese monto igual (variable amount arriba), pero el mensaje
    // ya no menciona "seña/saldo al cartero" — el admin coordina por separado.
    const linkTpl = getFlowTemplate('payment_mp_link', knowledge) ||
        `💳 *Pago con tarjeta de crédito*\n\nPedido: *{{PRODUCT}}* — Plan {{PLAN}} días\nTotal: *${'$'}{{TOTAL}}*\n\n{{LINK}}\n\nEscribime *"listo"* cuando termines.`;
    // Inyectamos productName en state efímero para que {{PRODUCT}} muestre el cart concatenado.
    const stateForFmt = { ...currentState, selectedProduct: productName };
    const msg = _formatMessage(linkTpl, stateForFmt);
    currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
    await sendMessageWithDelay(userId, msg);
    logger.info(`[MP_PAYMENT] Link ${isSena ? 'SEÑA' : ''} creado para ${userId} — $${amount} ARS — ${link}`);
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
    // Retiro en sucursal (rev. 2026-05-30): la calle figura como "A sucursal" en
    // la venta; la calle real queda en calleOriginal para que el admin sepa la
    // zona y asigne la sucursal de Correo Argentino más cercana.
    const isPickupForFinalize = currentState.shippingChoice === 'retiro';
    currentState.pendingOrder = {
        nombre: addr.nombre,
        calle: isPickupForFinalize ? 'A sucursal' : addr.calle,
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
        email: currentState.email || null,
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
        status: 'Confirmado', // el bot cierra la venta solo: el pago MP ya está confirmado acá
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
    const emailLabel = currentState.email ? `\n📧 Email: ${currentState.email}` : '';
    if (notifyAdmin) {
        await notifyAdmin(
            `✅ VENTA CERRADA por el bot (pago confirmado)`,
            userId,
            `Datos: ${addr.nombre}, ${addr.calle}\nCiudad: ${addr.ciudad} | CP: ${addr.cp}\nProvincia: ${addr.provincia || '?'}${emailLabel}\nItems: ${orderData.producto}\nTotal: $${currentState.totalPrice || '0'}${postdataLabel}${payLabel}`
        );
    }

    const _trackScript = effectiveScript || config?.activeScript;
    if (config && config.scriptStats && _trackScript && _trackScript !== 'rotacion') {
        if (!config.scriptStats[_trackScript]) config.scriptStats[_trackScript] = { started: 0, completed: 0 };
        config.scriptStats[_trackScript].completed++;
    }

    _setStep(currentState, FlowStep.COMPLETED);
    const msg = isSenaFlow
        ? `¡Listo! La seña fue confirmada y tu pedido quedó cerrado ✅🎉\n\nEl cartero te cobra el saldo de *$${cashFmt}* en efectivo cuando reciba el paquete. Apenas lo despachemos te pasamos el código de seguimiento.\n\n¡Gracias por confiar en Herbalis! 🌱`
        : '¡Listo! Tu pago fue confirmado y tu pedido quedó cerrado ✅🎉\n\nApenas lo despachemos te pasamos el código de seguimiento.\n\n¡Gracias por confiar en Herbalis! 🌱';
    currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, msg);
}

function _getClosingMsg(knowledge: any): string {
    return knowledge?.flow?.closing?.response ||
        'Perfecto! Pasame los datos para armar la etiqueta de envío 👇\n\nNombre completo:\nCalle:\nNúmero:\nLocalidad:\nCódigo postal:\nEmail (opcional, para el comprobante de MP):';
}
