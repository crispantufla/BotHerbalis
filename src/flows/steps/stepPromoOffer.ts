/**
 * stepPromoOffer.ts — el guion para quien contesta la promo.
 *
 * El bot le escribió primero (ver services/promo/promoDispatcher.ts) con el
 * tratamiento de 60 días a precio promo. Acá se lee la respuesta:
 *
 *   - "no me escribas más / basta / spam"  → se despide, lo anota como opted_out
 *     y pausa el chat en silencio (sin alerta: no hay nada que atender).
 *   - "no gracias / no me interesa / ahora no" → cierre cordial, pausa en silencio.
 *   - nombra una presentación (cápsulas / gotas / semillas, o 1/2/3) → arma el
 *     carrito del plan de 60 al precio promo y pasa DIRECTO al menú de pago; de
 *     ahí en más sigue el flujo normal (retiro / domicilio, datos, confirmación).
 *   - "PROMO / sí / quiero / dale" sin presentación → pregunta cuál de las tres.
 *   - una pregunta u objeción → la IA responde con el contexto de la promo y
 *     vuelve a cerrar con la elección de presentación.
 *
 * No se pregunta por kilos: la promo es el plan de 60 días para todos. Si el
 * cliente quiere más (120 días), la IA puede ofrecerlo a precio de lista.
 */

import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert } from '../utils/flowHelpers';
import { _isNegative } from '../utils/validation';
import { buildCartFromSelection } from '../utils/cartHelpers';
import { _formatMessage } from '../utils/messages';
import { buildPaymentMessage, getFlowTemplate } from '../../utils/messageTemplates';
import { isMpEnabled } from '../utils/paymentOptions';
import { _getPromoPrice60 } from '../utils/pricing';
import { pauseUser } from '../../services/pauseService';
import { markPromoReply } from '../../services/promo/promoDispatcher';
import logger from '../../utils/logger';

const PRODUCT_NAMES: Record<string, string> = {
    capsulas: 'Cápsulas de nuez de la india',
    gotas: 'Gotas de nuez de la india',
    semillas: 'Semillas de nuez de la india',
};

// Sobre normalizedText (sin tildes, minúsculas).
const OPT_OUT_RE = /\b(no (me|nos) (escrib|mand|molest)\w*|no quiero (recibir|que me escriban|mas mensajes)|dej(a|en|ame) de (escribir|mandar|molestar)|borr(a|en|ame)( mi)? (numero|contacto)|sac(a|en|ame) (de la lista|mi numero)|basta de mensajes|stop|baja|spam|denunci\w*)\b/;
const DECLINE_RE = /\b(no (me )?interesa|no gracias|no por ahora|ahora no|no quiero|ya no|no puedo|otro momento|mas adelante|en otro momento|no estoy interesad[oa]|paso|dejalo|ya compre en otro lado|ya lo consegui)\b/;
const INTEREST_RE = /\bpromo\b|\b(si|sip|dale|ok|oka|bueno|quiero|me interesa|como hago|lo quiero|info|informacion|precio|cuanto|aprovech\w*|lo tomo|va|listo|genial|perfecto|buenisimo)\b/;

function _detectProduct(normalizedText: string, knowledge: any): string | null {
    const t = normalizedText.trim();
    const num = t.match(/^(?:opcion\s+|la\s+|el\s+|opc\s*)?([123])\s*[.)\-:]?\s*$/) || t.match(/^([123])[️⃣]+/) || t.match(/\bopcion\s*([123])\b/);
    if (num) {
        if (num[1] === '1') return PRODUCT_NAMES.capsulas;
        if (num[1] === '2') return PRODUCT_NAMES.gotas;
        return PRODUCT_NAMES.semillas;
    }
    const isMatch = (keywords: string[] | undefined, fallback: RegExp) =>
        (Array.isArray(keywords) && keywords.some((k) => new RegExp(`\\b${k}\\b`, 'i').test(t))) || fallback.test(t);
    const caps = isMatch(knowledge?.flow?.preference_capsulas?.match, /\b(capsul\w*|pastill\w*)\b/);
    const gotas = isMatch(knowledge?.flow?.preference_gotas?.match, /\bgot\w*\b/);
    const sem = isMatch(knowledge?.flow?.preference_semillas?.match, /\b(semill\w*|cemill\w*|natural(es)?)\b/);
    const n = (caps ? 1 : 0) + (gotas ? 1 : 0) + (sem ? 1 : 0);
    if (n !== 1) return null; // ninguno o varios: lo resuelve la IA
    return caps ? PRODUCT_NAMES.capsulas : gotas ? PRODUCT_NAMES.gotas : PRODUCT_NAMES.semillas;
}

const DEFAULT_PRODUCT_ASK =
    '¡Buenísimo! 🎉 La promo es el tratamiento completo de *60 días* a *${{PROMO_60}}*, en la presentación que prefieras:\n\n' +
    '1️⃣ *Cápsulas* — 1 al día, 30 min antes del almuerzo o la cena.\n' +
    '2️⃣ *Gotas* — 10 gotas al día, 30 min antes del almuerzo o la cena.\n\n' +
    'Las dos son 100% naturales y funcionan igual 🌿 ¿Con cuál arrancamos?';
const DEFAULT_PRODUCT_CONFIRM = '¡Genial! 🎁 Te armo el plan de *60 días* de *{{PRODUCT_SHORT}}* a *${{TOTAL}}* (precio promo).';
// Las semillas no entran en la promo: van a su precio de lista (que es más bajo).
const DEFAULT_PRODUCT_CONFIRM_SEMILLAS = '¡Dale! Las *semillas* no entran en la promo, pero van a su precio normal, que es menor: plan de *60 días* a *${{TOTAL}}*, con envío gratis igual 🌿';
const DEFAULT_DECLINED = 'Todo bien, ¡gracias por responderme! 😊 Si más adelante querés retomarlo, escribime por acá nomás.';
const DEFAULT_OPTED_OUT = 'Listo, no te escribo más. ¡Que estés muy bien! 🙏';

function _tpl(key: string, knowledge: any, fallback: string): string {
    return getFlowTemplate(key, knowledge) || fallback;
}

function _render(text: string, state: UserState): string {
    const price = _getPromoPrice60(state.selectedProduct || 'Cápsulas') || '';
    const short = (state.selectedProduct || '').split(' de ')[0] || 'Cápsulas';
    return _formatMessage(text.replace(/\{\{PROMO_60\}\}/g, price).replace(/\{\{PRODUCT_SHORT\}\}/g, short), state);
}

async function _quietPause(userId: string, reason: string, dependencies: any): Promise<void> {
    // Pausa SIN alerta al admin: una promo rechazada no necesita atención humana.
    if (dependencies.sharedState?.pausedUsers) {
        await pauseUser(userId, reason, { sharedState: dependencies.sharedState });
    }
    const logAndEmit = dependencies.logAndEmit || dependencies.sharedState?.logAndEmit;
    if (typeof logAndEmit === 'function') {
        try { logAndEmit(userId, 'system', `⏸️ Bot pausado — ${reason}`, 'promo_offer'); } catch { /* best effort */ }
    }
}

async function _chooseProduct(userId: string, product: string, currentState: UserState, knowledge: any, dependencies: any): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, saveState } = dependencies;
    const instanceId = dependencies.sellerId || dependencies.sharedState?.sellerId || 'default';

    // Plan 60 al precio promo (buildCartFromSelection lee state.promo.active).
    buildCartFromSelection(product, '60', currentState);
    if (currentState.promo) currentState.promo.outcome = 'interested';
    markPromoReply(instanceId, userId, 'interested');
    _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
    saveState(userId);

    const isSemillas = /semilla/i.test(product);
    const confirm = isSemillas
        ? _render(_tpl('promo_product_confirm_semillas', knowledge, DEFAULT_PRODUCT_CONFIRM_SEMILLAS), currentState)
        : _render(_tpl('promo_product_confirm', knowledge, DEFAULT_PRODUCT_CONFIRM), currentState);
    await sendMessageWithDelay(userId, confirm);
    const paymentMsg = buildPaymentMessage(currentState, knowledge, !isMpEnabled(dependencies.config));
    await sendMessageWithDelay(userId, paymentMsg);
    logger.info(`[PROMO-OFFER] ${userId} eligió ${product} → plan 60 a $${currentState.totalPrice} (promo), menú de pago enviado.`);
    return { matched: true };
}

export async function handlePromoOffer(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;
    const instanceId = dependencies.sellerId || dependencies.sharedState?.sellerId || 'default';

    if (!currentState.promo) {
        // Estado promo sin la promo (restos de un envío que falló): vuelve al saludo.
        currentState.promo = null;
        _setStep(currentState, FlowStep.GREETING);
        saveState(userId);
        return { matched: false };
    }
    if (!currentState.promo.repliedAt) {
        currentState.promo.repliedAt = Date.now();
        markPromoReply(instanceId, userId, 'question');
    }

    // 1. "No me escribas más": se cumple en el acto y queda anotado para siempre.
    if (OPT_OUT_RE.test(normalizedText)) {
        currentState.promo.outcome = 'opted_out';
        currentState.promo.active = false;
        markPromoReply(instanceId, userId, 'opted_out');
        saveState(userId);
        await sendMessageWithDelay(userId, _render(_tpl('promo_opted_out', knowledge, DEFAULT_OPTED_OUT), currentState));
        await _quietPause(userId, '🔕 Promo — pidió no recibir más mensajes', dependencies);
        logger.info(`[PROMO-OFFER] ${userId} pidió no recibir más mensajes.`);
        return { matched: true };
    }

    const product = _detectProduct(normalizedText, knowledge);

    // 2. Rechazo cordial (sin producto nombrado ni pregunta).
    const asksSomething = /[?¿]/.test(text) || /\b(cuanto|como|que|donde|cuando|funciona|sirve|efecto|tarda|llega|envio)\b/.test(normalizedText);
    if (!product && !asksSomething && (DECLINE_RE.test(normalizedText) || (_isNegative(normalizedText) && !INTEREST_RE.test(normalizedText)))) {
        currentState.promo.outcome = 'declined';
        markPromoReply(instanceId, userId, 'declined');
        saveState(userId);
        await sendMessageWithDelay(userId, _render(_tpl('promo_declined', knowledge, DEFAULT_DECLINED), currentState));
        await _quietPause(userId, '🎁 Promo — no le interesó', dependencies);
        logger.info(`[PROMO-OFFER] ${userId} declinó la promo.`);
        return { matched: true };
    }

    // 3. Eligió presentación → carrito promo + menú de pago.
    if (product && !asksSomething) {
        return _chooseProduct(userId, product, currentState, knowledge, dependencies);
    }

    // 4. Interés sin presentación ("PROMO", "sí", "quiero") → preguntar cuál.
    if (!asksSomething && INTEREST_RE.test(normalizedText) && normalizedText.trim().length <= 60) {
        currentState.promo.outcome = 'interested';
        markPromoReply(instanceId, userId, 'interested');
        saveState(userId);
        await sendMessageWithDelay(userId, _render(_tpl('promo_product_ask', knowledge, DEFAULT_PRODUCT_ASK), currentState));
        logger.info(`[PROMO-OFFER] ${userId} respondió con interés — pregunto presentación.`);
        return { matched: true };
    }

    // 5. Pregunta u objeción → IA con el contexto de la promo.
    if (!aiService || typeof aiService.chat !== 'function') {
        await _pauseAndAlert(userId, currentState, dependencies, text, 'Respondió a la promo con una consulta y no hay IA disponible.');
        return { matched: true };
    }
    const price = currentState.promo.price60 || _getPromoPrice60('Cápsulas') || '?';
    const mpOn = isMpEnabled(dependencies.config);
    const goal =
        `El cliente recibió de nuestra parte un mensaje de PROMO (le escribimos nosotros primero, porque meses atrás consultó y no compró) y acaba de responder: "${text}". ` +
        `LA PROMO: tratamiento completo de *60 días* a *$${price}* en *Cápsulas* o *Gotas* solamente. Las Semillas NO entran en la promo: si las pide, van a su precio de lista normal (que es menor), aclarándoselo. Envío gratis a todo el país. ` +
        `Cómo se paga: *retiro en sucursal de Correo Argentino* pagando el total en efectivo al retirar (sin adelantar nada), o *envío a domicilio* prepago por ${mpOn ? 'tarjeta de crédito o transferencia' : 'transferencia'}. ` +
        `🛑 En esta conversación el precio del plan de 60 días es $${price}: NO cites el precio de lista del plan de 60. El plan de 120 días sigue a su precio de lista normal (solo si lo pide). ` +
        `Tu tarea: (1) respondé su consulta u objeción con calidez, honestidad y BREVEDAD, sin inventar nada; (2) cerrá con UNA sola pregunta: con qué presentación arranca, cápsulas o gotas. ` +
        `Si elige una presentación, devolvé en extractedData "PRODUCTO: Cápsulas" / "PRODUCTO: Gotas" / "PRODUCTO: Semillas" y goalMet=true. Si dice que no le interesa, despedite cordialmente sin insistir y devolvé extractedData "PROMO_DECLINED". 🛑 NO derives al médico salvo contraindicación real.`;

    try {
        const ai = await aiService.chat(text, {
            step: 'promo_offer',
            goal,
            history: currentState.history,
            summary: currentState.summary,
            knowledge,
            userState: currentState,
        });
        const extracted = String(ai?.extractedData || '');
        const prodTag = extracted.match(/PRODUCTO:\s*(c[aá]psulas|gotas|semillas)/i);
        if (prodTag) {
            const key = prodTag[1].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
            if (ai.response) await sendMessageWithDelay(userId, ai.response);
            return _chooseProduct(userId, PRODUCT_NAMES[key], currentState, knowledge, dependencies);
        }
        if (/PROMO_DECLINED/i.test(extracted)) {
            currentState.promo.outcome = 'declined';
            markPromoReply(instanceId, userId, 'declined');
            saveState(userId);
            await sendMessageWithDelay(userId, ai.response || _render(DEFAULT_DECLINED, currentState));
            await _quietPause(userId, '🎁 Promo — no le interesó', dependencies);
            return { matched: true };
        }
        if (ai?.response) {
            saveState(userId);
            await sendMessageWithDelay(userId, ai.response);
            return { matched: true };
        }
    } catch (e: any) {
        logger.warn(`[PROMO-OFFER] IA falló para ${userId}: ${e.message}`);
    }
    await _pauseAndAlert(userId, currentState, dependencies, text, 'Respondió a la promo y el bot no pudo contestarle.');
    return { matched: true };
}
