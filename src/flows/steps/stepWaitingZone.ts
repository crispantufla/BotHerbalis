import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert, _isInfoQuestion, _detectPostdatado } from '../utils/flowHelpers';
import {
    classifyZoneText, parseDistanceAnswer, findZoneInHistory, getZoneConfig, isFarPlace,
    ZoneClassification,
} from '../utils/deliveryZone';
import { getFlowTemplate } from '../../utils/messageTemplates';
import { _formatMessage, _isDuplicate } from '../utils/messages';
import { isMpEnabled } from '../utils/paymentOptions';
import logger from '../../utils/logger';

// waiting_zone (sep-2026): entre elegir el plan y hablar de pago, el bot pregunta
// la LOCALIDAD y decide solo cómo le llega el pedido:
//   - Rosario y hasta 60 km → reparto propio, sin costo, paga al recibir → pide
//     nombre + calle y pasa a waiting_data (el bot cierra solo, como el retiro viejo).
//   - Fuera de zona → Correo Argentino prepago, a domicilio o sucursal → pasa a
//     waiting_payment_method, que ya tiene el submenú de tarjeta/transferencia.
// El cliente NUNCA tiene que decir si está "dentro de la zona de influencia":
// nombra su localidad y la clasificación es nuestra (flows/utils/deliveryZone).

// El cliente quiere venir a buscarlo. No hay local: si es de la zona se lo
// llevamos; si no, va por Correo. No pausa (antes de sep-2026 pausaba, y con la
// publicidad apuntada a Rosario eso frenaba justo al lead típico).
const PICKUP_INTENT = /\b(voy\s+(?:yo|al?\s+local|a\s+(?:buscar|retirar))|paso\s+(?:a\s+)?(?:buscar|retirar)|retir(?:ar|o)\s+(?:yo|en\s+persona|directamente|all[áa]|ah[íi])|ir\s+al?\s+local|ir\s+a\s+buscar|busco\s+yo|tienen\s+local|d[óo]nde\s+(?:est[áa]n|queda\s+el\s+local))\b/i;

// Envío nombrado junto con la localidad ("Córdoba, a domicilio"): se guarda como
// pista para no re-preguntarlo cuando la zona resulte 'out'.
const RETIRO_HINT = /\b(retiro|retir(?:ar|o)\s+en\s+sucursal|en\s+sucursal|a\s+sucursal|sucursal)\b/i;
const DOMICILIO_HINT = /\b(domicilio|a\s+(?:mi\s+)?casa|en\s+mi\s+casa|que\s+lo\s+manden|me\s+lo\s+mand[aá]n)\b/i;

function _tplOr(key: string, knowledge: any, mpOff: boolean, fallback: string): string {
    return getFlowTemplate(key, knowledge, mpOff) || fallback;
}

/**
 * Aplica el veredicto de zona: setea el estado, manda el mensaje de la rama y
 * transiciona. Exportada porque también la usa el atajo de _startZoneStep
 * (cliente que ya dijo de dónde es).
 */
export async function _resolveZone(
    userId: string,
    verdict: { zone: 'in' | 'out'; localidad: string | null },
    currentState: UserState,
    knowledge: any,
    dependencies: any,
    prefix: string = ''
): Promise<void> {
    const { sendMessageWithDelay, saveState } = dependencies;
    const mpOff = !isMpEnabled(dependencies.config);
    if (!currentState.partialAddress) currentState.partialAddress = {} as any;
    const addr: any = currentState.partialAddress;
    if (verdict.localidad) addr.ciudad = verdict.localidad;
    currentState.zoneQuestion = null;
    const hint = currentState.shippingHint || null;
    currentState.shippingHint = null;

    if (verdict.zone === 'in') {
        currentState.deliveryZone = 'in';
        currentState.shippingChoice = 'reparto';
        currentState.paymentMethod = 'contrarembolso';
        currentState.senaAmount = 0;
        currentState.senaPaid = false;
        currentState.paymentSubChoiceAsked = false;
        // Un estado que venía de retiro tenía la calle fijada en 'A sucursal'.
        if (addr.calle === 'A sucursal') addr.calle = undefined;
        const tpl = _tplOr('zone_in', knowledge, mpOff,
            'Dale, a *{{LOCALIDAD}}* llegamos con reparto propio 🚚\n\nTe lo llevamos a tu casa sin costo y lo pagás al recibirlo: efectivo, tarjeta o transferencia. Antes te escribimos para acordar día y horario.\n\nPasame tu *nombre completo* y *calle y número* 🙌');
        const msg = prefix + _formatMessage(tpl, currentState);
        _setStep(currentState, FlowStep.WAITING_DATA);
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[ZONE] ${userId} → DENTRO de zona (${addr.ciudad || '?'}) → reparto propio, pidiendo nombre + calle.`);
        return;
    }

    currentState.deliveryZone = 'out';
    // Todo lo que venga de la zona no aplica afuera.
    if (currentState.shippingChoice === 'reparto') currentState.shippingChoice = null;
    if (currentState.paymentMethod === 'contrarembolso') currentState.paymentMethod = null;
    currentState.senaAmount = null;
    currentState.senaPaid = false;

    if (hint) {
        // Ya dijo domicilio o sucursal: no lo hacemos elegir de nuevo, vamos al
        // medio de pago. Con MP apagado no hay submenú: alias directo.
        currentState.shippingChoice = hint;
        if (hint === 'retiro') addr.calle = 'A sucursal';
        else if (addr.calle === 'A sucursal') addr.calle = undefined;
        _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
        if (mpOff) {
            const { _sendTransferAliasAndAdvance } = require('./stepWaitingPaymentMethod');
            const intro = hint === 'retiro'
                ? 'Hasta ahí no llega nuestro reparto: va por *Correo Argentino* a la sucursal más cercana a tu código postal, sin costo, y al estar pago llega en *4 días hábiles* 📦\n\n'
                : 'Hasta ahí no llega nuestro reparto: va por *Correo Argentino* a tu domicilio, sin costo, y al estar pago llega en *4 días hábiles* 📦\n\n';
            await _sendTransferAliasAndAdvance(userId, currentState, knowledge, dependencies, prefix + intro);
            logger.info(`[ZONE] ${userId} → FUERA de zona con pista ${hint} + MP apagado → alias directo.`);
            return;
        }
        currentState.paymentSubChoiceAsked = true;
        const key = hint === 'retiro' ? 'payment_sucursal_choice' : 'payment_domicilio_choice';
        const tpl = _tplOr(key, knowledge, mpOff,
            '¿Cómo querés abonar?\n\n1️⃣ *Tarjeta de crédito*\n2️⃣ *Transferencia bancaria*');
        const msg = prefix + _formatMessage(tpl, currentState);
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[ZONE] ${userId} → FUERA de zona (${addr.ciudad || '?'}) con pista ${hint} → submenú prepago.`);
        return;
    }

    currentState.shippingChoice = null;
    currentState.paymentSubChoiceAsked = false;
    if (addr.calle === 'A sucursal') addr.calle = undefined;
    const tpl = _tplOr('zone_out', knowledge, mpOff,
        'Hasta ahí no llega nuestro reparto, así que va por *Correo Argentino* sin costo y llega en *4 días hábiles* 📦\n\nPodés recibirlo *en tu domicilio* o *retirarlo en la sucursal* más cercana. Como va prepago, lo abonás ahora.\n\n¿Lo querés en tu casa o en sucursal?');
    const msg = prefix + _formatMessage(tpl, currentState);
    _setStep(currentState, FlowStep.WAITING_PAYMENT_METHOD);
    saveState(userId);
    await sendMessageWithDelay(userId, msg);
    logger.info(`[ZONE] ${userId} → FUERA de zona (${addr.ciudad || '?'}) → Correo prepago, eligiendo domicilio/sucursal.`);
}

/**
 * Entrada al paso de zona desde la elección de plan (reemplaza al viejo
 * "mandar payment_menu + setStep(waiting_payment_method)"). Si el cliente ya
 * dijo de dónde es (en este mensaje o antes), no se le pregunta: se resuelve
 * directo. `text` es el mensaje actual, de donde también salen las pistas de
 * envío ("120, a domicilio").
 */
export async function _startZoneStep(
    userId: string,
    text: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any,
    prefix: string = ''
): Promise<void> {
    const { sendMessageWithDelay, saveState } = dependencies;
    const mpOff = !isMpEnabled(dependencies.config);

    if (text) {
        if (RETIRO_HINT.test(text)) currentState.shippingHint = 'retiro';
        else if (DOMICILIO_HINT.test(text)) currentState.shippingHint = 'domicilio';
    }

    // Zona ya resuelta en esta conversación (cliente que vuelve a comprar) o
    // localidad dicha con contexto ("soy de Funes") en cualquier mensaje previo.
    let known: { zone: 'in' | 'out'; localidad: string | null } | null = null;
    if ((currentState.deliveryZone === 'in' || currentState.deliveryZone === 'out') && currentState.partialAddress?.ciudad) {
        known = { zone: currentState.deliveryZone, localidad: currentState.partialAddress.ciudad };
    } else {
        const fromHistory = findZoneInHistory(currentState.history, knowledge);
        if (fromHistory) known = { zone: fromHistory.zone as 'in' | 'out', localidad: fromHistory.localidad };
    }
    if (known) {
        logger.info(`[ZONE] ${userId} ya había dicho su localidad (${known.localidad || '?'}, ${known.zone}) — salteo la pregunta.`);
        await _resolveZone(userId, known, currentState, knowledge, dependencies, prefix);
        return;
    }

    const tpl = _tplOr('payment_menu', knowledge, mpOff,
        '¡Genial! 🙌 Contame de qué localidad sos, así te digo cómo te llega 📦');
    const msg = prefix + _formatMessage(tpl, currentState);
    currentState.zoneQuestion = 'localidad';
    _setStep(currentState, FlowStep.WAITING_ZONE);
    saveState(userId);
    await sendMessageWithDelay(userId, msg);
    logger.info(`[ZONE] ${userId} → preguntando localidad.`);
}

async function _askKm(userId: string, currentState: UserState, knowledge: any, dependencies: any, candidate: string | null): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, saveState } = dependencies;
    if (!currentState.partialAddress) currentState.partialAddress = {} as any;
    if (candidate) (currentState.partialAddress as any).ciudad = candidate;
    currentState.zoneQuestion = 'km';
    const cfg = getZoneConfig(knowledge);
    const tpl = _tplOr('zone_km', knowledge, false, `¿Y eso queda cerca de ${cfg.centro}? ¿A cuántos km, más o menos? 🙂`);
    saveState(userId);
    await sendMessageWithDelay(userId, _formatMessage(tpl, currentState));
    logger.info(`[ZONE] ${userId} → localidad "${candidate || '?'}" desconocida, pregunto km.`);
    return { matched: true };
}

export async function handleWaitingZone(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;
    const mpOff = !isMpEnabled(dependencies.config);
    const cfg = getZoneConfig(knowledge);

    if (!currentState.postdatado) {
        const pd = _detectPostdatado(normalizedText);
        if (pd) {
            currentState.postdatado = pd;
            logger.info(`[ZONE] Postdatado capturado para ${userId}: "${pd}"`);
        }
    }
    if (RETIRO_HINT.test(text)) currentState.shippingHint = 'retiro';
    else if (DOMICILIO_HINT.test(text)) currentState.shippingHint = 'domicilio';

    // ── Quiere venir a buscarlo ────────────────────────────────────────────────
    if (PICKUP_INTENT.test(text) && !classifyZoneText(text, knowledge).localidad) {
        const tpl = _tplOr('zone_no_local', knowledge, mpOff,
            `No tenemos local para retirar 🙈 Pero si sos de ${cfg.centro} o alrededores te lo llevamos nosotros a tu casa sin costo y lo pagás al recibir 🚚\n\n¿De qué localidad sos?`);
        currentState.zoneQuestion = 'localidad';
        saveState(userId);
        await sendMessageWithDelay(userId, _formatMessage(tpl, currentState));
        return { matched: true };
    }

    // ── Respuesta a "¿a cuántos km?" ───────────────────────────────────────────
    if (currentState.zoneQuestion === 'km') {
        const named = classifyZoneText(text, knowledge);
        if (named.zone === 'in' || named.zone === 'out') {
            await _resolveZone(userId, named as any, currentState, knowledge, dependencies);
            return { matched: true };
        }
        const dist = parseDistanceAnswer(text, cfg.radioKm);
        if (dist === 'in' || dist === 'out') {
            await _resolveZone(userId, { zone: dist, localidad: currentState.partialAddress?.ciudad || null }, currentState, knowledge, dependencies);
            return { matched: true };
        }
        // Ni km ni localidad: si es pregunta la responde la IA; si no, con la
        // duda a favor del cliente no adivinamos — lo tratamos como fuera de
        // zona solo si lo dice él. Re-preguntamos una vez.
    }

    // ── Localidad en el mensaje ────────────────────────────────────────────────
    const cls: ZoneClassification = classifyZoneText(text, knowledge);
    if (cls.zone === 'in' || cls.zone === 'out') {
        await _resolveZone(userId, cls as any, currentState, knowledge, dependencies);
        return { matched: true };
    }

    // ── No reconocimos nada ────────────────────────────────────────────────────
    // Pregunta del cliente → la IA responde y vuelve a pedir la localidad. Si en
    // la pregunta venía la localidad, la trae en el tag.
    if (_isInfoQuestion(text)) {
        const aiRes = await aiService.chat(text, {
            step: 'waiting_zone',
            goal: `Estás por decirle al cliente cómo le llega el pedido y para eso necesitás su LOCALIDAD (ciudad o pueblo). El cliente te preguntó algo en vez de contestar: respondé su pregunta con calidez y cerrá volviendo a preguntar de qué localidad es. Si pregunta cómo se paga o cómo llega, explicá las dos modalidades: en ${cfg.centro} y hasta ${cfg.radioKm} km lo llevamos nosotros a su casa sin costo y paga al recibir (efectivo, tarjeta o transferencia); al resto del país va por Correo Argentino sin costo, prepago (${mpOff ? 'transferencia' : 'tarjeta de crédito o transferencia'}), a domicilio o sucursal, en 4 días hábiles. NUNCA le pidas que diga si está "dentro de la zona": la localidad alcanza. Si en su mensaje dice de dónde es, incluí en extractedData exactamente "LOCALIDAD: <nombre>" (solo el nombre de la localidad). Si no la dice, extractedData=null. goalMet=false siempre (la zona la resuelve el sistema).`,
            history: currentState.history,
            summary: currentState.summary,
            knowledge,
            userState: currentState
        });
        const tag = String(aiRes.extractedData || '').match(/LOCALIDAD:\s*(.+)/i);
        if (tag) {
            const fromTag = classifyZoneText(tag[1], knowledge);
            if (fromTag.zone === 'in' || fromTag.zone === 'out') {
                // La IA ya contestó la duda; la resolución manda el mensaje de la rama.
                if (aiRes.response) { saveState(userId); await sendMessageWithDelay(userId, aiRes.response); }
                await _resolveZone(userId, fromTag as any, currentState, knowledge, dependencies);
                return { matched: true };
            }
        }
        if (aiRes.response && !_isDuplicate(aiRes.response, currentState.history)) {
            saveState(userId);
            await sendMessageWithDelay(userId, aiRes.response);
            return { matched: true };
        }
        await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente en waiting_zone con una pregunta que la IA no pudo responder. Revisar.');
        return { matched: true };
    }

    // Parser de direcciones: saca ciudad/provincia de texto libre ("Soy de Las
    // Parejas", "vivo en Bigand, Santa Fe"). Provincia lejana → fuera; ciudad
    // desconocida → preguntamos los km.
    let candidate: string | null = null;
    try {
        const parsed = await (dependencies.mockAiService || aiService).parseAddress(text);
        if (parsed && !parsed._error) {
            if (parsed.ciudad) {
                const byCity = classifyZoneText(parsed.ciudad, knowledge);
                if (byCity.zone === 'in' || byCity.zone === 'out') {
                    await _resolveZone(userId, byCity as any, currentState, knowledge, dependencies);
                    return { matched: true };
                }
                candidate = parsed.ciudad;
            }
            if (parsed.provincia && isFarPlace(parsed.provincia)) {
                await _resolveZone(userId, { zone: 'out', localidad: candidate || parsed.provincia }, currentState, knowledge, dependencies);
                return { matched: true };
            }
        }
    } catch (e: any) {
        logger.warn(`[ZONE] parseAddress falló para ${userId}: ${e.message}`);
    }
    if (candidate) return await _askKm(userId, currentState, knowledge, dependencies, candidate);

    // Nada reconocible. Re-preguntamos una vez; a la segunda derivamos.
    const reask = _tplOr('zone_reask', knowledge, false, 'Perdoná, no me quedó claro 🙈 ¿De qué localidad sos? (ciudad o pueblo)');
    if (_isDuplicate(reask, currentState.history)) {
        await _pauseAndAlert(userId, currentState, dependencies, text, `No pude reconocer la localidad del cliente en waiting_zone (dijo: "${text.slice(0, 80)}"). Resolver la zona a mano.`);
        return { matched: true };
    }
    currentState.zoneQuestion = 'localidad';
    saveState(userId);
    await sendMessageWithDelay(userId, reask);
    return { matched: true };
}
