import { _getAdminSuggestions } from './messages';
import { UserState, SharedState } from '../../types/state';
import logger from '../../utils/logger';
import { logStepTransition, markExit } from '../../services/funnelLogger';

/**
 * _cleanPhone
 * Extracts the raw phone number from a WhatsApp userId (e.g. "5491155551234@c.us" → "5491155551234").
 */
function _cleanPhone(userId: string): string {
    return userId.split('@')[0].replace(/\D/g, '');
}

/**
 * _setStep
 * Helper to update the conversation step with timestamp tracking.
 * Resets staleAlerted and reengagementSent flags when step changes.
 */
function _setStep(state: any, newStep: string) {
    const prevStep = state.step;
    if (prevStep !== newStep) {
        // Log funnel transition
        if (!state.funnelLog) state.funnelLog = [];
        if (state.step && state.stepEnteredAt) {
            state.funnelLog.push({ step: state.step, enteredAt: state.stepEnteredAt, exitedAt: Date.now() });
        }
        state.staleAlerted = false;
        state.reengagementSent = false;
        state.secondFollowUpSent = false;
        state.cartRecovered = false;
        // Si re-entramos a la selección de método de pago, hay que volver a mostrar
        // el mensaje explicativo de la seña $10k si el cliente vuelve a pedir COD.
        if (newStep === 'waiting_payment_method') {
            state.cashRetryShown = false;
        }

        // A/B conversion tracking: mark follow-up as converted when user advances
        if (state.followUpData && !state.followUpData.converted) {
            state.followUpData.converted = true;
        }

        // Fire-and-forget: persistir transición en FunnelEvent para analítica
        const ctx = state._ctx;
        if (ctx?.sellerId && ctx?.phone) {
            logStepTransition(ctx.sellerId, ctx.phone, prevStep || null, newStep).catch(() => {});
        }
    }
    state.step = newStep;
    state.stepEnteredAt = Date.now();
}

/**
 * _maybeUpsell
 * Sends the 120-day upsell message if the user has a weight goal > 10kg.
 */
async function _maybeUpsell(currentState: UserState, sendMessageWithDelay: Function, userId: string, saveStateFn?: Function) {
    // Aquí validamos que currentState es tipado (e.g alertaría si pones currentState.peso instead of weightGoal)
    if (currentState.weightGoal && Number(currentState.weightGoal) > 10) {
        const upsell = "Personalmente yo te recomendaría el de 120 días debido al peso que esperas perder 👌";
        currentState.history.push({ role: 'bot', content: upsell, timestamp: Date.now() });
        if (saveStateFn) saveStateFn(userId);
        await sendMessageWithDelay(userId, upsell);
    }
}

/**
 * _detectPostdatado
 * Detects if text contains a postdating request (future delivery date).
 * Returns a CLEAN date string (e.g. "1 de julio", "principio de mes") or null.
 * Filters out "mañana/ya/ahora" which mean the user wants it SOONER (not postdatado).
 */
function _detectPostdatado(normalizedText: string): string | null {
    // "mañana", "ya", "ahora" = wants SOONER, NOT a postdatado request
    // But "ahora no puedo" / "no puedo ahora" / "no puedo comprar ahora" means LATER, not sooner
    const hasNegatedAhora = /\b(ahora\s+no|no\s+puedo\s+ahora|ahora\s+no\s+puedo)\b/i.test(normalizedText);
    const hasNegationBeforeKeyword = /\bno\s+(?:puedo|quiero|tengo|me|voy\s+a)\b/i.test(normalizedText);
    const wantsSooner = !hasNegatedAhora && !hasNegationBeforeKeyword && /\b(mañana|ya mismo|ya|ahora|urgente|inmediato|cuanto antes|lo antes posible)\b/i.test(normalizedText);
    if (wantsSooner && !/\b(pasado mañana|cobro|principio|fin de mes|semana\s+que\s+viene|mes\s+que\s+viene|pr[oó]ximo\s+mes|\d{1,2}\s+(?:de\s+)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre))\b/i.test(normalizedText)) {
        return null;
    }

    // Must have delivery/payment action context. Incluye keywords de "juntar"
    // y "conseguir" plata/efectivo — son objeciones económicas claras donde el
    // cliente quiere postponer el pago hasta tener el dinero.
    const hasActionContext = /\b(recibir|recibirlo|llega|llegue|enviar|enviame|envialo|enviamela|enviamelo|mandalo|mandame|mandamela|mandamelo|entregar|cobro|depositan|sueldo|pago|puedo|pueden|venir|mandar|comprar|no tengo|para el|a partir|no puedo ahora|no puedo comprar|juntar|junte|junto|consigo|consiga|conseguir|ahorre|ahorrar|cuente con|me alcance|me alcance la plata|mucho inter[eé]s|cuotas|me comunico|aviso cuando|cuando tenga)\b/i.test(normalizedText);
    if (!hasActionContext) return null;

    // FECHAS CERCANAS = NO postdatar (regla del dueño, caso 1131381951): el envío
    // tarda *7 a 10 días hábiles*, así que un día de la semana ("el lunes", "el
    // martes") o "la semana que viene" caen SIEMPRE dentro de ese plazo — si lo
    // pide hoy llega justo para esa fecha. No los tratamos como postdatado (se
    // cierra hoy y se le aclara la demora). Solo se postdata lo MÁS lejano que el
    // plazo: mes que viene, fin de mes, "cuando cobre", una fecha DD de un mes, etc.
    // (El reframe de "el lunes / no estoy en casa" lo hace la IA vía la regla del
    // prompt CORE; acá solo evitamos capturar una fecha cercana como postdatado.)

    // Extract clean date portion (most specific patterns first)
    const patterns: RegExp[] = [
        /\d{1,2}\s+(?:de\s+)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i,
        /(?:principio|fin|final|fines|mediados)\s+de\s+mes/i,
        /cuando\s+(?:cobre|cobr[eo]|me\s+deposit[ae]n|me\s+pagu?en|tenga\s+(?:la\s+)?plata|tenga\s+(?:el\s+)?(?:dinero|efectivo)|junte\s+(?:la\s+)?plata|junte\s+(?:el\s+)?efectivo|consiga\s+(?:la\s+)?plata|me\s+alcance)/i,
        /(?:cobro|depositan|pagan)\s+(?:el\s+\d{1,2}|a\s+principio|la\s+quincena)/i,
        /(?:apenas|en\s+cuanto|cuando)\s+(?:cuente\s+con|tenga|junte|consiga|cobre)/i,
        /(?:el|del|para\s+el|despu[eé]s\s+del|a\s+partir\s+del)\s+\d{1,2}(?=[\s,.]|$)/i,
        /(?:la\s+)?(?:quincena|mes\s+que\s+viene|pr[oó]ximo\s+mes)/i,
        // Vaguidad económica como "cuando tenga plata" sin fecha específica:
        // marcamos como postdatado "indefinido" para que el flow ofrezca
        // postdatar el envío (preguntar la fecha cómoda). PROHIBIDO ofrecer
        // "congelar el precio" — esa modalidad de urgencia fue eliminada.
        /cuando\s+(?:la\s+)?(?:plata|efectivo|dinero)/i,
    ];

    for (const pattern of patterns) {
        const match = normalizedText.match(pattern);
        if (match) {
            return match[0].trim();
        }
    }

    return null;
}

/**
 * _pauseAndAlert
 * Pauses the user and sends an alert to the admin dashboard.
 * The bot will not respond to this user until an admin unpauses them.
 * At night (outside 9-21h Argentina), sends a polite "fuera de horario" message.
 */
async function _pauseAndAlert(userId: string, currentState: UserState, dependencies: any, userMessage: string, reason: string) {
    const { notifyAdmin, saveState, sendMessageWithDelay, sharedState } = dependencies;
    const { isBusinessHours } = require('../../services/timeUtils');
    const duringBusinessHours = isBusinessHours();

    // Pause the user — use pauseService for DB persistence + debounce
    if (sharedState && sharedState.pausedUsers) {
        const { pauseUser } = require('../../services/pauseService');
        await pauseUser(userId, reason, { sharedState });
        await saveState(userId);
    }

    // Registrar el motivo de la pausa de forma PERMANENTE en el historial (role
    // 'system'): queda auditable para siempre y visible en el timeline del
    // dashboard, aunque después se despause (unpauseUser borra pausedAt/pauseReason
    // del User). NO se le envía nada al cliente — logAndEmit solo persiste + emite
    // al panel. (Antes el motivo se perdía al despausar; ver caso 5493405456106.)
    const _logAndEmit = dependencies.logAndEmit || (sharedState && sharedState.logAndEmit);
    if (typeof _logAndEmit === 'function') {
        try { _logAndEmit(userId, 'system', `⏸️ Bot pausado — ${reason}`, currentState.step); }
        catch (e) { /* best effort, no romper el flujo de pausa */ }
    }

    // Fire-and-forget: cerrar el FunnelEvent abierto como 'paused' para que la
    // analítica detecte "aquí el bot se rindió". Si el usuario sigue la charla
    // y avanza, el próximo _setStep abre uno nuevo.
    const ctx = (currentState as any)._ctx;
    if (ctx?.sellerId && ctx?.phone) {
        markExit(ctx.sellerId, ctx.phone, 'paused').catch(() => {});
    }

    // NIGHT MODE: Send polite night message
    if (!duringBusinessHours) {
        const nightMsg = "Necesito consultar esto con mi compañero, pero entenderás que por la hora me es imposible. Apenas pueda te respondo, ¡quedate tranquilo/a! 😊🌙";
        currentState.history.push({ role: 'bot', content: nightMsg, timestamp: Date.now() });
        await sendMessageWithDelay(userId, nightMsg);
    }

    // P2 #8: Generate contextual suggestions for admin
    const suggestions = _getAdminSuggestions(currentState.step, userMessage);
    const suggestionsText = suggestions.length > 0
        ? `\n\n💡 *Sugerencias:*\n${suggestions.map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}`
        : '';

    const nightLabel = !duringBusinessHours ? ' (FUERA DE HORARIO)' : '';

    // Alert admin with suggestions
    if (notifyAdmin) {
        await notifyAdmin(
            `🚨 BOT PAUSADO${nightLabel} — Necesita intervención`,
            userId,
            `Razón: ${reason}\nÚltimo mensaje: "${userMessage}"\nPaso: ${currentState.step}${suggestionsText}`
        );
    }

    // Emit alert to dashboard — scoped to this seller + admin room
    if (sharedState && sharedState.io) {
        const payload = {
            userId,
            reason,
            lastMessage: userMessage,
            step: currentState.step,
            nightMode: !duringBusinessHours,
            timestamp: new Date()
        };
        const sellerId = (sharedState as any).sellerId;
        if (sellerId) {
            sharedState.io.to(sellerId).emit('bot_paused', payload);
            sharedState.io.to('admin').emit('bot_paused', { ...payload, sellerId });
        } else {
            sharedState.io.emit('bot_paused', payload);
        }
    }

    logger.info(`⏸️ [BOT] User ${userId} paused. Reason: ${reason}${nightLabel}`);
}

/**
 * _extractSilentVariables
 * Preemptively catches out-of-band age or weight updates to prevent
 * AI confusion if the user provides these at the wrong step.
 */
function _extractSilentVariables(normalizedText: string, currentState: any): { ageUpdated?: number, weightUpdated?: number, isSolelyCorrection: boolean } {
    let result: { ageUpdated?: number, weightUpdated?: number, isSolelyCorrection: boolean } = { isSolelyCorrection: false };

    // Catch "tengo X años", "mi edad es X"
    // IMPORTANT: "tengo X" MUST be followed by "años/añitos" — otherwise "tengo 2 hijos" or
    // "tengo 120 dias" would falsely extract an age. "mi edad es X" is explicit enough to not need it.
    // NOTE: normalizedText is NFD-stripped, so ñ→n: años→anos, añitos→anitos
    const ageMatch = normalizedText.match(/\b(?:tengo\s+(\d{1,3})\s+(?:a[nñ]os|a[nñ]itos)|mi edad\s+(?:es\s+(?:de\s+)?)?(\d{1,3}))\b/i);
    if (ageMatch) {
        const ageStr = ageMatch[1] || ageMatch[2];
        if (ageStr) result.ageUpdated = parseInt(ageStr, 10);
    }

    // Catch "peso X", "X kilos", "quiero bajar X"
    const weightGoalMatchDirect = normalizedText.match(/\b(bajar|adelgazar|perder|quiero bajar|quisiera bajar|necesito bajar)\s+(\d{1,3})\s*(kilos|kg|kgs)?\b/i);
    const weightGoalMatchIndirect = !weightGoalMatchDirect && /\b(bajar|adelgazar|perder)\b/i.test(normalizedText)
        ? normalizedText.match(/\b(\d{1,3})\s*(kilos|kg|kgs)\b/i)
        : null;
    const weightGoalMatch = weightGoalMatchDirect || weightGoalMatchIndirect;
    const currentWeightMatch = normalizedText.match(/\b(peso|estoy pesando)\s+(\d{2,3})\s*(kilos|kg|kgs)?\b/i);

    if (weightGoalMatch) {
        // Direct regex captures number in group 2; indirect regex captures in group 1
        const numStr = weightGoalMatchDirect ? weightGoalMatch[2] : weightGoalMatch[1];
        if (numStr) {
            result.weightUpdated = parseInt(numStr, 10);
            currentState.weightGoal = result.weightUpdated;
        }
    } else if (currentWeightMatch && currentWeightMatch[2]) {
        // This is their CURRENT body weight — never set it as a goal
        result.weightUpdated = parseInt(currentWeightMatch[2], 10);
        currentState.currentWeight = result.weightUpdated;
    }

    // Determine if the message was ONLY this correction (short message)
    if (result.ageUpdated || result.weightUpdated) {
        const wordCount = normalizedText.trim().split(/\s+/).length;
        if (wordCount <= 6) {
            result.isSolelyCorrection = true;
        }
    }

    return result;
}

/**
 * _detectProductPlanChange
 * Detects if the user's message contains intent to change product or plan.
 * Extracted from stepWaitingData, stepWaitingFinalConfirmation, stepWaitingPlanChoice
 * to eliminate duplication.
 * Also detects multi-unit intent ("3 cajas", "2 unidades", "180 días").
 */
function _detectProductPlanChange(normalizedText: string): { productChange: RegExpMatchArray | null; planChange: RegExpMatchArray | boolean | null } {
    const productChange = normalizedText.match(/\b(mejor|quiero|prefiero|cambio|cambia|dame|paso a|en vez|consulto|consulta|posible|puedo|puede|podria|quisiera|seria|serian|cuanto|cuánto|precio|info|cual)\b.*\b(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas|natural|infusion)\b/i)
        || normalizedText.match(/\b(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas)\b.*\b(mejor|quiero|prefiero|cambio|en vez|posible|puede ser|seria|cuanto|cuánto)\b/i)
        || normalizedText.match(/\b(si|es)\s+(posible|mejor)\s+\w*\s*(capsula|capsulas|pastilla|pastillas|semilla|semillas|gota|gotas)\b/i);

    // Multi-unit detection: "3 cajas", "dos unidades", "180 días", etc.
    const multiUnitMatch = /\b(\d+)\s*(cajas?|unidades?|cajitas?|frascos?)\b/i.test(normalizedText)
        || /\b(180|240|300|360)\s*d[ií]as?\b/i.test(normalizedText)
        || /\b(dos|tres|cuatro|cinco|seis)\s*(cajas?|unidades?|cajitas?|frascos?)\b/i.test(normalizedText);

    const planChange = normalizedText.match(/\b(mejor|quiero|quisiera|prefiero|cambio|cambia|dame|paso a|en vez|voy a querer|me quedo con|tomaria|tomare|en realidad|posible|puedo|puede|seria)\b.*\b(60|120|sesenta|ciento veinte)\b/i)
        || normalizedText.match(/\b(60|120|sesenta|ciento veinte)\b.*\b(mejor|quiero|quisiera|prefiero|cambio|en vez|posible|puede ser)\b/i)
        || (/\b(de|el|plan)\s+d?e?\s*(60|120)\b/i.test(normalizedText) && /\b(dia|dias|d\u00edas)\b/i.test(normalizedText))
        || /\bplan\s+d\s+(60|120)\b/i.test(normalizedText)
        || multiUnitMatch;

    return { productChange, planChange: planChange || null };
}

/**
 * _resolveNewProductPlan
 * Given normalizedText and current state, resolves the new product and plan names.
 * Multi-unit requests ("3 cajas", "180 días") take priority over 60/120 detection.
 */
function _resolveNewProductPlan(normalizedText: string, currentProduct: string | null | undefined, currentPlan: string | null | undefined): { newProduct: string; newPlan: string } {
    let newProduct = currentProduct || "Nuez de la India";
    if (/capsula|pastilla/i.test(normalizedText)) newProduct = "Cápsulas de nuez de la india";
    else if (/semilla|natural|infusion/i.test(normalizedText)) newProduct = "Semillas de nuez de la india";
    else if (/gota/i.test(normalizedText)) newProduct = "Gotas de nuez de la india";

    const WORD_TO_NUM: Record<string, number> = { dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };

    // Multi-unit takes priority over plain 60/120 detection
    const multiNumericMatch = normalizedText.match(/\b(\d+)\s*(cajas?|unidades?|cajitas?|frascos?)\b/i);
    const multiWordMatch = normalizedText.match(/\b(dos|tres|cuatro|cinco|seis)\s*(cajas?|unidades?|cajitas?|frascos?)\b/i);
    const multiDaysMatch = normalizedText.match(/\b(180|240|300|360)\s*d[ií]as?\b/i);

    let newPlan = currentPlan || "60";
    if (multiNumericMatch) {
        const units = parseInt(multiNumericMatch[1], 10);
        if (units >= 2 && units <= 10) newPlan = (units * 60).toString();
    } else if (multiWordMatch) {
        const units = WORD_TO_NUM[multiWordMatch[1].toLowerCase()];
        if (units && units >= 2) newPlan = (units * 60).toString();
    } else if (multiDaysMatch) {
        const days = parseInt(multiDaysMatch[1], 10);
        if (days % 60 === 0) newPlan = days.toString();
    } else if (/\b(120|ciento veinte)\b/i.test(normalizedText)) {
        newPlan = "120";
    } else if (/\b(60|sesenta)\b/i.test(normalizedText)) {
        newPlan = "60";
    }

    return { newProduct, newPlan };
}

/**
 * _pushHistory
 * Agrega una entrada al history con cap defensivo. Antes este cap solo
 * estaba en salesFlow.ts:270, así que crons (re-engagement, MP follow-up,
 * abandoned cart) podían empujar entradas indefinidamente a usuarios que
 * nunca volvían a entrar al flujo. Centralizar aquí evita drift.
 */
/**
 * Asigna producto + plan + cart + total en el state según el producto que
 * eligió el cliente y los kilos a bajar. Plan por tier (V5 rev. 2026-05-26):
 *   - tier 1 (≤10 kg) → 60d
 *   - tier 2 (10-20 kg) → 120d
 *   - tier 3 (>20 kg) → 120d
 * Si no hay weightGoal todavía (caso edge: cliente mencionó producto antes
 * de kilos y la lógica del weight step no extrajo nada), default a 120d.
 */
function _assignProductAndPlanByTier(state: any, productFullName: string): void {
    const { _getPrice } = require('./pricing');
    const { calculateTotal } = require('./cartHelpers');
    const w = typeof state.weightGoal === 'number' ? state.weightGoal : parseInt(String(state.weightGoal || 0), 10) || 0;
    // Si el cliente eligió plan explícito (vio ambos en prices_both y dijo 60/120),
    // se respeta; si no, lo define el tier. Habilita el upsell al 120 aunque
    // recomendemos 60 (rev 2026-05-30).
    const override = state._planChoice;
    const plan = (override === '60' || override === '120') ? override : (w > 0 && w <= 10 ? '60' : '120');
    state.selectedProduct = productFullName;
    state.selectedPlan = plan;
    state.cart = [{ product: productFullName, plan, price: _getPrice(productFullName, plan) }];
    calculateTotal(state);
}

/**
 * _isGhostClose
 * Detecta una "venta fantasma": la IA dio por cerrado/confirmado el pedido en su
 * texto, pero el flujo NO generó la orden (sin pendingOrder) y el step no es uno
 * de cierre real. Eso deja al cliente creyendo que compró cuando el sistema no
 * tiene nada (caso 5493442465660). Las confirmaciones LEGÍTIMAS no matchean: se
 * emiten con pendingOrder seteado, en steps de cierre (excluidos), o fuera del
 * flujo (al aprobar la orden ya creada).
 */
const _GHOST_CLOSE_LANG = /(pedido confirmado|listo,?\s+todo|todo listo|ya est[aá] todo listo|ya est[aá] tu pedido|tu pedido qued[oó]|tu pedido est[aá] (confirmado|listo)|queda confirmado|pedido ingresado|ya qued[oó] (tu pedido|todo))/i;
const _GHOST_CLOSE_CLOSED_STEPS = ['waiting_admin_validation', 'waiting_admin_ok', 'completed', 'rejected_medical', 'rejected_abusive', 'rejected_geo'];
function _isGhostClose(botMsg: string | null | undefined, step: string, hasPendingOrder: boolean): boolean {
    if (!botMsg) return false;
    if (hasPendingOrder) return false;
    if (_GHOST_CLOSE_CLOSED_STEPS.includes(step)) return false;
    return _GHOST_CLOSE_LANG.test(botMsg);
}

function _pushHistory(state: any, entry: { role: 'user' | 'bot' | 'system'; content: string; timestamp?: number }) {
    if (!state.history) state.history = [];
    state.history.push({ ...entry, timestamp: entry.timestamp || Date.now() });
    if (state.history.length > 250) {
        state.history = state.history.slice(-150);
    }
}

/**
 * V7 (may-2026): si el JSON setea preference_X.nextStep = 'waiting_payment_method',
 * tras enviar el preference_X mandamos el payment_menu como segundo mensaje.
 * En V5/V6 (legacy) el nextStep era 'waiting_ok' y este helper no hace nada.
 * Centralizado acá porque lo usan tanto stepWaitingPreference como stepWaitingWeight
 * (el path suggestedProduct, cuando el cliente menciona el producto antes de los kilos).
 */
async function _maybeSendPaymentMenuV7(
    userId: string,
    nextStep: string | undefined,
    currentState: any,
    knowledge: any,
    dependencies: any
): Promise<void> {
    if (nextStep !== 'waiting_payment_method') return;
    const { buildPaymentMessage } = require('../../utils/messageTemplates');
    const { sendMessageWithDelay, saveState } = dependencies;
    const paymentMsg = buildPaymentMessage(currentState, knowledge);
    currentState.history.push({ role: 'bot', content: paymentMsg, timestamp: Date.now() });
    saveState(userId);
    await sendMessageWithDelay(userId, paymentMsg);
    logger.info(`[V7-AUTO-PAYMENT] User ${userId} → payment_menu enviado tras confirmar producto.`);
}

// ── Cambio de opinión de envío/pago en steps posteriores (jun-2026) ──────────
// Un cliente que YA pasó por waiting_payment_method puede cambiar de idea sobre el
// TIPO DE ENVÍO o el MEDIO DE PAGO en pasos donde antes no se detectaba
// (waiting_data, waiting_final_confirmation) → caía a IA/parser de dirección y se
// confundía (raíz común de varios bugs de may/jun-2026).
//
// Única fuente de verdad para APLICAR la elección de envío/pago = handleWaitingPaymentMethod.
// Acá SOLO detectamos el cambio EXPLÍCITO y reencauzamos al step de pago (vía
// staleReprocess), igual que ya hace stepWaitingTransferConfirmation. No armamos
// mensajes: el reproceso por payment_method re-deriva todo del texto original.
//
// Detección ESTRICTA a propósito: exige un MARCADOR de cambio ("mejor", "prefiero",
// "cambié", "en realidad"...) para NO dispararse con direcciones normales que
// mencionan "domicilio" o un número. Además solo cuenta si DIFIERE de lo ya elegido.
const _SHIPSWITCH_MARKER = /\b(mejor|prefiero|prefer[ií]a|en realidad|en vez|en lugar|cambi[ée]|cambiar|quiero cambiar|me conviene|recapacit|me arrepent)\b/i;
const _SHIPSWITCH_RETIRO = /\b(retiro|retir(?:ar|o)|en sucursal|a sucursal|sucursal del? correo|contra.?re?embolso)\b/i;
const _SHIPSWITCH_DOMICILIO = /\b(a domicilio|a mi casa|a mi domicilio|en mi casa|que me lo manden|env[íi]o a domicilio|a la direcci[óo]n)\b/i;
const _SHIPSWITCH_TARJETA = /\b(tarjeta|cr[ée]dito|mercado.?pago|link de pago|pago online)\b/i;
const _SHIPSWITCH_TRANSFER = /\b(transfer[ei]ncia|transferir|por transferencia|al alias)\b/i;

function _detectShipPaySwitch(
    normalizedText: string,
    currentState: any
): { shipping?: 'retiro' | 'domicilio'; payment?: 'mercadopago' | 'transferencia' } | null {
    if (!_SHIPSWITCH_MARKER.test(normalizedText)) return null;
    let shipping: 'retiro' | 'domicilio' | undefined;
    let payment: 'mercadopago' | 'transferencia' | undefined;
    if (_SHIPSWITCH_RETIRO.test(normalizedText) && currentState.shippingChoice !== 'retiro') shipping = 'retiro';
    else if (_SHIPSWITCH_DOMICILIO.test(normalizedText) && currentState.shippingChoice !== 'domicilio') shipping = 'domicilio';
    if (_SHIPSWITCH_TRANSFER.test(normalizedText) && currentState.paymentMethod !== 'transferencia') payment = 'transferencia';
    else if (_SHIPSWITCH_TARJETA.test(normalizedText) && currentState.paymentMethod !== 'mercadopago') payment = 'mercadopago';
    if (!shipping && !payment) return null;
    return { shipping, payment };
}

/**
 * Si el cliente cambió de idea sobre envío/pago en un step posterior, resetea los
 * flags acoplados y reencauza a waiting_payment_method. Devuelve un resultado
 * staleReprocess listo para retornar, o null si no hubo cambio.
 */
function _handleShipPaySwitch(
    userId: string,
    normalizedText: string,
    currentState: any,
    dependencies: any
): { matched: boolean; staleReprocess?: boolean } | null {
    const sw = _detectShipPaySwitch(normalizedText, currentState);
    if (!sw) return null;
    if (sw.shipping) {
        currentState.shippingChoice = null;
        currentState.paymentMethod = null;
        currentState.paymentSubChoiceAsked = false;
        // Venía de retiro: la calle estaba pre-seteada a "A sucursal". La limpiamos
        // para que un cambio a domicilio vuelva a pedir la dirección real.
        if (currentState.partialAddress && currentState.partialAddress.calle === 'A sucursal') {
            currentState.partialAddress.calle = undefined;
        }
    } else if (sw.payment) {
        currentState.paymentMethod = null;
        currentState.paymentSubChoiceAsked = false;
    }
    _setStep(currentState, 'waiting_payment_method');
    if (dependencies && typeof dependencies.saveState === 'function') dependencies.saveState(userId);
    logger.info(`[SHIP-PAY-SWITCH] ${userId} cambió de idea (${JSON.stringify(sw)}) → reencauzado a waiting_payment_method.`);
    return { matched: false, staleReprocess: true };
}

// ── Detector de PREGUNTA / pedido de info ───────────────────────────────────
// Más robusto que "empieza con palabra interrogativa o termina en ?". Capta
// interrogativos en MEDIO de la frase. Caso real disparador (1131381951,
// 2026-06-19): "Con tarjeta cuanto tardan" — el bot NO lo leyó como pregunta
// (empieza con "con"), vio "tarjeta" y mandó el link de pago en vez de
// responder la demora. La regla del dueño: el bot no debe APURARSE a matchear
// keyword cuando el cliente está PREGUNTANDO — primero responde, después avanza.
// Se mantiene conservador (frases interrogativas, no palabras sueltas) para no
// marcar afirmaciones como "te paso la calle cuando llegue".
const _Q_STARTERS = /^\s*(como|cuanto|cuantos|cuantas|cuando|donde|que|cual|por que|sale|cuesta|tarda|tardan|demora|hay|tienen|tenes|puedo|se puede|funciona|sirve|me conviene)\b/i;
const _Q_ANYWHERE = /\bcuanto\s+(tarda|tardan|sale|cuesta|vale|es|cobran|demora|demoran|seria)\b|\bcomo\s+(funciona|se toma|tomo|pago|se paga|lo pago|abono|recibo|llega|hago)\b|\bcuando\s+(llega|lo mandan|sale|me llega|recibo|lo recibo|despachan)\b|\bque\s+(precio|costo|metodo|metodos|forma de pago|formas de pago)\b|\bdonde\s+(retiro|esta|queda|lo retiro)\b|\bhacen\s+envios?\b|\by\s+(las?\s+)?(semillas?|gotas?|c[aá]psulas?|pastillas?|infusion)\s*\??$/i;

function _isInfoQuestion(text: string): boolean {
    const raw = (text || '').trim();
    if (!raw) return false;
    if (raw.includes('?') || raw.includes('¿')) return true;
    const t = raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return _Q_STARTERS.test(t) || _Q_ANYWHERE.test(t);
}

/**
 * _closeSaleAndNotify — CIERRE DE VENTA POR EL BOT (jun-2026).
 *
 * El bot cierra la venta él mismo, sin gate de aprobación del admin. Se llama
 * cuando la venta ya está lista para cerrar: retiro/COD con todos los datos, o
 * MP con el pago confirmado. Hace TODO el cierre en un solo lugar:
 *   1. Guarda la orden como 'Confirmado' (entra directo a Ventas/Logística).
 *   2. Manda una alerta INFORMATIVA al admin ("✅ VENTA CERRADA"), ya no de aprobación.
 *   3. Envía el mensaje de confirmación (que ahora ES el cierre, sin "¿me confirmás?").
 *   4. Pasa a 'completed' (post-venta: salesFlow auto-pausa los mensajes siguientes).
 *
 * orderExtra permite inyectar campos específicos (ej: seña de MP) sobre el orderData
 * armado desde currentState.
 */
async function _closeSaleAndNotify(
    userId: string,
    currentState: any,
    knowledge: any,
    dependencies: any,
    orderExtra: Record<string, any> = {}
): Promise<void> {
    const { sendMessageWithDelay, saveState, notifyAdmin, saveOrderToLocal, config, effectiveScript } = dependencies;
    const { buildConfirmationMessage } = require('../../utils/messageTemplates');

    const addr = currentState.partialAddress || {};
    const o = currentState.pendingOrder || {
        nombre: addr.nombre, calle: addr.calle, ciudad: addr.ciudad, cp: addr.cp, provincia: addr.provincia, calleOriginal: null
    };
    const cart = currentState.cart || [];
    const phone = userId.split('@')[0];
    const orderData = {
        cliente: phone,
        nombre: o.nombre, calle: o.calle, ciudad: o.ciudad, cp: o.cp, provincia: o.provincia,
        calleOriginal: o.calleOriginal || null,
        email: currentState.email || null,
        producto: cart.map((i: any) => i.product).join(' + ') || currentState.selectedProduct || '',
        plan: cart.map((i: any) => `${i.plan} días`).join(' + ') || `${currentState.selectedPlan || '60'} días`,
        precio: currentState.totalPrice || '0',
        postdatado: currentState.postdatado || null,
        paymentMethod: currentState.paymentMethod || 'contrarembolso',
        status: 'Confirmado',
        ...orderExtra
    };

    currentState.hasSoldBefore = true;
    if (saveOrderToLocal) saveOrderToLocal(orderData);

    if (notifyAdmin) {
        const postdataLabel = currentState.postdatado ? `\n📅 POSTDATADO: ${currentState.postdatado}` : '';
        await notifyAdmin(
            '✅ VENTA CERRADA por el bot',
            userId,
            `Cliente: ${o.nombre || '?'}\nCiudad: ${o.ciudad || '?'} | CP: ${o.cp || '?'}\nItems: ${orderData.producto} (${orderData.plan})\nTotal: $${currentState.totalPrice || '0'}\nPago: ${orderData.paymentMethod}${postdataLabel}`
        );
    }

    const _track = effectiveScript || config?.activeScript;
    if (config && config.scriptStats && _track && _track !== 'rotacion') {
        if (!config.scriptStats[_track]) config.scriptStats[_track] = { started: 0, completed: 0 };
        config.scriptStats[_track].completed++;
    }

    const closeMsg = buildConfirmationMessage(currentState, knowledge);
    currentState.history.push({ role: 'bot', content: closeMsg, timestamp: Date.now() });
    _setStep(currentState, 'completed');
    saveState(userId);
    await sendMessageWithDelay(userId, closeMsg);
}

export {
    _cleanPhone,
    _isInfoQuestion,
    _closeSaleAndNotify,
    _setStep,
    _maybeUpsell,
    _detectPostdatado,
    _pauseAndAlert,
    _extractSilentVariables,
    _detectProductPlanChange,
    _resolveNewProductPlan,
    _assignProductAndPlanByTier,
    _pushHistory,
    _maybeSendPaymentMenuV7,
    _isGhostClose,
    _detectShipPaySwitch,
    _handleShipPaySwitch
};
