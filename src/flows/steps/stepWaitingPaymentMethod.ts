import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert, _detectPostdatado, _isInfoQuestion, _pushHistory } from '../utils/flowHelpers';
import { parseShippingChoice } from '../utils/extractedData';
import { getFlowTemplate } from '../../utils/messageTemplates';
import { calculateTotal } from '../utils/cartHelpers';
import { _formatMessage, _isDuplicate } from '../utils/messages';
import { isMpEnabled, prepayMeans, prepayMenu, cardUnavailableMessage } from '../utils/paymentOptions';
import logger from '../../utils/logger';

// Modelo por zona (sep-2026): a este step llega el cliente FUERA de la zona de
// reparto propio (o un estado viejo sin zona, que se reencauza a waiting_zone).
// Todo va por Correo Argentino y SIEMPRE prepago; lo que elige es:
//   1️⃣ Envío a domicilio  → tarjeta de crédito (link) o transferencia
//   2️⃣ Retiro en sucursal → mismo prepago; el Correo asigna la sucursal por CP
// Fuera de Rosario y 60 km ya no existe pago al recibir: quien lo pide recibe
// prepay_objection y, si insiste, prepay_refusal_close + asesor (ver
// _handlePrepayObjection). Dentro de zona no se pasa por acá: waiting_zone
// manda directo a waiting_data con reparto propio.
//
// Cliente quiere ir al local físico (que no tenemos). Hasta sep-2026 esto —y la
// sola mención de "soy de Rosario"— pausaba al cliente; ahora contesta y sigue.
const PICKUP_INTENT_PAY = /\b(voy\s+(?:yo|al?\s+local|a\s+(?:buscar|retirar))|paso\s+(?:a\s+)?(?:buscar|retirar)|ir\s+al?\s+local|ir\s+a\s+buscar|busco\s+yo)\b/i;

// Shipping choice keywords. "contrarreembolso" ya NO es sinónimo de retiro: es
// un pedido de pago al recibir, que fuera de zona se responde como objeción.
const RETIRO_KEYWORDS = /\b(retiro|retir(?:ar|o)\s+en\s+sucursal|en\s+sucursal|a\s+sucursal|en\s+la\s+sucursal|sucursal\s+(?:de\s+)?correo|sucursal)\b/i;
// Respuestas cortas a "¿lo querés en tu casa o en sucursal?" (zone_out no numera).
const HOME_SHORT = /^\s*(?:en\s+|a\s+)?(?:mi\s+|la\s+)?(?:casa|domicilio)\s*[.!]?\s*$/i;
const COD_REQUEST = /\bcontra.?re?embolso\b/i;
const DOMICILIO_KEYWORDS = /\b(domicilio|a\s+(?:mi\s+)?casa|a\s+mi\s+domicilio|env[ií]o\s+a\s+(?:mi\s+)?domicilio|env[ií]o\s+a\s+casa|envialo|envíalo|mandalo|que\s+lo\s+manden|me\s+lo\s+mand[aá]n|me\s+lo\s+mandan|a\s+mi\s+direcci[óo]n|en\s+mi\s+casa|directo\s+a\s+casa)\b/i;

// "No puedo/tengo efectivo" — el cliente NIEGA poder pagar en efectivo → necesita
// PREPAGO (domicilio con tarjeta/transferencia), NO retiro en sucursal (que es
// justamente pagar en efectivo al retirar). Caso real 1131381951: dijo "no puedo
// efectivo" y el bot la mandó a retiro — lo opuesto a lo que pedía.
const NO_CASH = /\bno\s+(?:puedo|tengo|manejo|uso|cuento\s+con|dispongo\s+de|me\s+queda)\s+(?:el\s+|en\s+)?efectivo\b|\bsin\s+efectivo\b|\befectivo\s+no\s+(?:puedo|tengo|manejo|me\s+queda|dispongo)\b/i;

// Payment method matchers (submenú tras elegir domicilio + atajos).
// Rapipago/PagoFácil se siguen detectando como keyword (el cliente puede nombrarlas)
// y se canalizan por el link de tarjeta de crédito, pero el bot ya NO las ofrece.
const MP_KEYWORDS = /\b(mercadopago|mercado.?pago|\bmp\b|online|digital|qr|tarjeta|d[ée]bito|cr[ée]dito|pago online|pago digital|pago ahora|por mp|con mp|por mercadopago|aplicaci[óo]n|rapipago|pago\s*f[áa]cil|pagof[áa]cil)\b/i;
const TRANSFER_KEYWORDS = /\b(transfer[ei]ncia|transf\b|transferir|alias|dep[óo]sito|deposito|banco|bancaria|cbu|cvu|por transferencia)\b/i;

// Verbos de decisión que convierten una frase con opción de envío en ELECCIÓN
// aunque _isInfoQuestion la lea como pregunta. Caso real 5492215731759 (21-jul):
// "Me conviene ir a la sucursal del correo y abonar ahí" — "me conviene" es
// arranque interrogativo válido ("¿me conviene X?"), así que _isInfoQuestion lo
// marcaba como pregunta, TODOS los paths determinísticos quedaban gateados y el
// mensaje caía al AI fallback: la IA "avanzaba" en el texto (pedía el nombre)
// pero el step no transicionaba, y los datos que la clienta mandó después se
// perdieron en este step. Sobre normalizedText (sin tildes).
const DECISIVE_CHOICE = /\b(me conviene|prefiero|preferiria|elijo|me quedo con|voy con|me viene mejor|me queda (mas\s+)?(comodo|cerca|facil)|quiero(?!\s+(saber|preguntar|consultar|entender)))\b/i;

// Bloqueadores del override: aunque haya verbo de decisión, si la frase arranca
// con interrogativo ("Cuánto tarda si elijo retiro"), compara con "cuál", o tiene
// un " o " suelto entre alternativas ("me conviene retiro o envío"), ES pregunta.
const DECISIVE_BLOCKERS = /^\s*(cuanto|cuantos|cuantas|como|cuando|donde|que|cual|cuales|por\s+que|sale|cuesta|tarda|tardan|demora)\b|\bcual(es)?\b|\s+o\s+/i;

// Option-number picker para mensajes cortos ("1", "la 1", "opcion 2", "uno"/"dos").
const OPTION_PICKER = /(^|\s)(?:opci[óo]n\s+|la\s+|el\s+|n[uú]mero\s+|\#)?(\d)\s*[\.\)]?\s*$/i;
const STANDALONE_NUM_WORD = /^\s*(?:la\s+|el\s+|opci[óo]n\s+)?(uno|dos|primer[oa]|segund[oa])\s*[\.\)]?\s*$/i;

// Malentendido "pago al recibir" con medio prepago (caso real 5492954235122,
// 2026-05-31): "Envío a domicilio pago con mercado pago al recibir". La clienta
// cree que le paga al cartero con MP/transferencia — eso NO existe. Con esos
// medios el pago es ANTES (online); pagar al recibir en efectivo es SOLO retiro
// en sucursal. Si NO mencionó retiro/sucursal, hay que aclararlo antes de avanzar.
const PAY_ON_DELIVERY = /\b(al recibir|al recibirlo|al recibirla|cuando (?:lo |la |me )?reciba|cuando (?:me )?lleg(?:ue|a)|cuando me lo traigan|cuando me lo entreguen|contra ?entrega|al cartero|al recibir el (?:paquete|producto|pedido))\b/i;

// Malentendido "lo pago en mi domicilio" / "pago en casa" (caso real 5492915126300,
// 2026-06-30). La clienta NO está eligiendo "envío a domicilio": quiere PAGAR AL
// RECIBIR EN SU CASA (contrarreembolso a domicilio), modalidad eliminada en mayo
// 2026. El bot vio "domicilio" y la mandó al submenú prepago; ella eligió
// transferencia creyendo que pagaba al llegar el paquete → venta fantasma y un
// asesor tuvo que corregir a mano. El marcador que lo distingue de "envío a
// domicilio" es el VERBO DE PAGO (pago/abono/...) pegado a "en/a (mi) casa/domicilio".
// Sobre normalizedText (sin tildes). El gap acotado .{0,15} cubre "lo pago en mi
// domicilio", "pago a domicilio", "abono en casa", "pago el pedido en mi domicilio".
const PAY_AT_HOME = /\b(?:lo\s+|la\s+|me\s+)?(?:pagar[ií]a|pagarl[oa]|pagar|pago|abonar[ií]a|abonarl[oa]|abonar|abono|cancelo)\b.{0,15}?\b(?:en|a)\s+(?:mi\s+|el\s+|la\s+|su\s+|tu\s+)?(?:domicilio|casa)\b/i;

// Despedida suave / dilación / "lo veo después" (reportes 2026-05-29 5493751416938
// + 5491150190999 + 5492604649413). El cliente no elige opción de envío, dice
// algo tipo "voy a ver", "gracias", "me comunico", "ahora estoy averiguando".
// En estos casos pausamos para que el admin retome — no insistimos con el menú.
const SOFT_BAILOUT = /\b(gracias|voy a (ver|hacer|pensar|fijarme)|despu[eé]s te (escribo|aviso|hablo|digo|comunico)|me comunico|me fijo|lo pienso|lo veo|lo miro|estoy averiguando|solo (estoy )?averiguando|m[aá]s adelante|en un rato|en otro momento|cuando pueda|capaz despu[eé]s)\b/i;

// Desconfianza del PAGO ANTICIPADO (transferencia/pago online). Caso 5492262484928
// (26-jun): "Soy de pcia Bs As..no me gustan transferencias..he tenido problema".
// El bot insistió con *tarjeta de crédito* (que TAMBIÉN es pago por adelantado) y
// la vendedora a mano (Marta) tuvo que corregirlo: "podés pagar cuando recibís /
// retiro en sucursal y pagás al retirar". Cuando el cliente desconfía de pagar por
// adelantado, lo lógico es ofrecerle la opción SIN anticipo: retiro en sucursal,
// efectivo al retirar. Sobre normalizedText (sin tildes).
// OJO: nada de `\b` final tras "transferenci" — "transferencia(s)" sigue con
// caracteres de palabra y el borde fallaría (no matchearía el plural).
const DISTRUST_PREPAY = /no me gust\w*\s+(las?\s+)?transferenci|no me gusta\s+transferir|no (quiero|me animo a)\s+transferir|\bno confi[oa]\b|\bdesconfi[oa]\b|\bno me f[ií][oa]\b|\bme da (miedo|cosa|desconfianza)\b|\btengo miedo\b|\bmala experiencia\b|no me gusta\s+pagar\s+(por\s+)?(adelantad|anticipad|antes|online)|\bmiedo a (la\s+)?estafa\b|\bque sea (una\s+)?estafa\b/i;

// ── Negación dirigida a un medio de pago ─────────────────────────────────────
// "no me gusta la transferencia" / "no quiero pagar con tarjeta": el keyword-match
// pelado elegía la opción NEGADA y mandaba el alias/link — lo contrario de lo
// pedido (DISTRUST_PREPAY no actúa dentro del submenú por su gate de
// paymentSubChoiceAsked). Conservador a propósito, mismo criterio que
// DISTRUST_PREPAY: el negador tiene que estar en la MISMA cláusula que el
// keyword (sin puntuación en el medio), así "no hay problema, transferencia"
// sigue eligiendo transferencia; y las muletillas benignas ("no hay problema",
// "no pasa nada", "no importa") se descartan antes de evaluar. Al no elegir la
// opción negada, el mensaje cae a la rama DISTRUST_PREPAY/IA que sabe manejar
// la objeción. Sobre normalizedText (sin tildes).
const BENIGN_NEGATION = /\bno\s+(?:hay|tengo)\s+(?:ning[uú]n\s+|ninguna\s+)?(?:problema|drama|tema|inconveniente)s?\b|\bno\s+pasa\s+nada\b|\bno\s+importa\b|\bno\s+te\s+preocupes\b/gi;
function _negatesOption(normalizedText: string, optionKeywords: RegExp): boolean {
    const cleaned = normalizedText.replace(BENIGN_NEGATION, ' ');
    const kw = `(?:${optionKeywords.source})`;
    const negBefore = new RegExp(`\\b(?:no|tampoco|nunca|ni)\\b[^.,;:!?¿¡]{0,30}?${kw}`, 'i');
    const negAfter = new RegExp(`${kw}[^.,;:!?¿¡]{0,30}?\\b(?:no|tampoco|nunca|ni)\\b`, 'i');
    return negBefore.test(cleaned) || negAfter.test(cleaned);
}

function _detectOptionNumber(text: string): '1' | '2' | null {
    const trimmed = text.trim();
    if (trimmed.length <= 25) {
        const m = trimmed.match(OPTION_PICKER);
        if (m) {
            const n = m[2];
            if (n === '1' || n === '2') return n;
        }
        const w = trimmed.match(STANDALONE_NUM_WORD);
        if (w) {
            const word = w[1].toLowerCase();
            if (/uno|primer/.test(word)) return '1';
            if (/dos|segund/.test(word)) return '2';
        }
    }
    return null;
}

// ── Prefill de datos de retiro desde el historial reciente ───────────────────
// Mensajes del usuario enviados DESPUÉS de entrar a este step: si una mala
// clasificación mandó la elección al AI fallback, la IA suele pedir los datos
// ("¿tu nombre completo?") sin que el step avance, y el cliente los manda
// mientras el step sigue acá. Cuando el path de retiro por fin matchea, esos
// datos ya están en el historial — los parseamos para no re-pedirlos de cero
// (caso real 5492215731759: nombre y CP dados 2 veces y re-pedidos igual).
async function _prefillRetiroFromHistory(
    userId: string, currentText: string, currentState: UserState, dependencies: any
): Promise<void> {
    const { aiService } = dependencies;
    const addr: any = currentState.partialAddress;
    if (addr.nombre && addr.ciudad && addr.cp) return;

    // Sin stepEnteredAt (estados legacy) la ventana sería TODA la conversación
    // (pesos, alturas, montos → falsos positivos). Mejor no prefillear.
    if (!currentState.stepEnteredAt) return;
    const since = currentState.stepEnteredAt;
    const recent = (currentState.history || [])
        .filter((h: any) => h.role === 'user' && (h.timestamp || 0) >= since && h.content && h.content !== currentText)
        .map((h: any) => h.content)
        .slice(-6);
    if (recent.length === 0) return;

    const block = recent.join('\n');
    // Solo gastar el parse si el bloque tiene pinta de datos (números o ≥2 palabras).
    if (!/\d/.test(block) && block.trim().split(/\s+/).length < 2) return;

    try {
        const parsed = await (dependencies.mockAiService || aiService).parseAddress(block);
        if (parsed && !parsed._error) {
            if (parsed.nombre && !addr.nombre) {
                addr.nombre = parsed.nombre;
                if (!currentState.userName) currentState.userName = parsed.nombre;
            }
            if (parsed.ciudad && !addr.ciudad) addr.ciudad = parsed.ciudad;
            if (parsed.provincia && !addr.provincia) addr.provincia = parsed.provincia;
            if (parsed.cp && !addr.cp) addr.cp = parsed.cp;
        }
    } catch (e: any) {
        logger.warn(`[PAYMENT_METHOD] prefill retiro: parseAddress falló para ${userId}: ${e.message}`);
    }
    // Fallback CP: en retiro no hay calle, así que un número de 4 dígitos suelto
    // es el código postal (mismo criterio que _handleRetiroData).
    if (!addr.cp) {
        const cpMatch = block.match(/\b(\d{4})\b/);
        if (cpMatch) addr.cp = cpMatch[1];
    }
    if (addr.nombre || addr.ciudad || addr.cp) {
        logger.info(`[PAYMENT_METHOD] ${userId} → prefill retiro desde historial: nombre=${addr.nombre || '-'} ciudad=${addr.ciudad || '-'} cp=${addr.cp || '-'}`);
    }
}

// Cierre por TRANSFERENCIA: alias + titular + monto, y pasamos a esperar el
// aviso de pago. Son los mismos 8 renglones en los 4 caminos que terminan en
// transferencia (submenú, atajo directo, "no puedo efectivo" y —con MP
// apagado— cualquier elección de domicilio), así que viven en un solo lugar.
export async function _sendTransferAliasAndAdvance(
    userId: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any,
    prefix: string = ''
): Promise<void> {
    const { sendMessageWithDelay, saveState } = dependencies;
    currentState.paymentMethod = 'transferencia';
    currentState.senaAmount = null;
    currentState.senaPaid = false;
    const tpl = getFlowTemplate('payment_transfer_alias', knowledge) ||
        `¡Perfecto! Para transferir usá el alias *{{ALIAS}}* a nombre de *{{TITULAR}}* 🏦\n\nMonto: ${'$'}{{TOTAL}}\n\nUna vez que realices la transferencia, escribime *"listo"* y coordinamos el envío 😊`;
    const msg = prefix + _formatMessage(tpl, currentState);
    _setStep(currentState, FlowStep.WAITING_TRANSFER_CONFIRMATION);
    saveState(userId);
    await sendMessageWithDelay(userId, msg);
}

// Cliente FUERA de zona que pide pagar al recibir / contrarreembolso / desconfía
// del prepago. 1ª vez: prepay_objection (el argumento del dueño en voz de Elena:
// 13 años de contrarreembolso, el Correo lo volvió lento y caro, hoy prepago y 4
// días). 2ª vez: prepay_refusal_close (texto del dueño, tal cual) + pausa + aviso
// al admin. Sin auto-recovery: si insiste, decide un humano.
async function _handlePrepayObjection(
    userId: string,
    text: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any,
    reason: string
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, saveState } = dependencies;
    const mpOn = isMpEnabled(dependencies.config);
    const n = (currentState.prepayObjections || 0) + 1;
    currentState.prepayObjections = n;
    currentState.paymentSubChoiceAsked = false;
    if (n === 1) {
        const tpl = getFlowTemplate('prepay_objection', knowledge, !mpOn) ||
            `Te entiendo 😊 Durante 13 años mandamos todo por contrarreembolso, pero el Correo Argentino lo volvió lento y muy caro para el cliente. Por eso, fuera de Rosario y alrededores hoy trabajamos solo con pago anticipado: apenas se acredita, sale y te llega en *4 días hábiles* 🚚\n\n¿Avanzamos con ${prepayMeans(mpOn)}?`;
        saveState(userId);
        await sendMessageWithDelay(userId, _formatMessage(tpl, currentState));
        logger.info(`[PAYMENT_METHOD] ${userId} → objeción al prepago (${reason}), 1ª vez: argumento enviado.`);
        return { matched: true };
    }
    const tpl = getFlowTemplate('prepay_refusal_close', knowledge) ||
        'Desde hace 13 años realizamos envíos por contrarreembolso. En los últimos tiempos el Correo Argentino ha tomado medidas que claramente atentan contra este servicio, haciéndolo lento y muy caro para el cliente.\n\nLamentamos si no te resulta cómodo realizar el pago anticipado para que el envío llegue a tu domicilio en 4 días.\n\nQuedamos a tu disposición.\n\nAtentamente,\nHerbalis';
    saveState(userId);
    await sendMessageWithDelay(userId, _formatMessage(tpl, currentState));
    await _pauseAndAlert(userId, currentState, dependencies, text, `Cliente fuera de zona insiste con contrarreembolso / no quiere prepagar (${reason}). Se le mandó el mensaje de cierre del guion. Retomar a mano si vale la pena.`);
    logger.info(`[PAYMENT_METHOD] ${userId} → objeción al prepago (${reason}), 2ª vez: cierre enviado y pausado.`);
    return { matched: true };
}

export async function handleWaitingPaymentMethod(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

    // Interruptor de Mercado Pago (jul-2026, cuenta bloqueada). Con MP apagado el
    // step ofrece SOLO retiro en sucursal (efectivo al retirar) y domicilio por
    // transferencia: no hay submenú de medios, no se genera link, y si el cliente
    // pide tarjeta se lo decimos de frente. Ver flows/utils/paymentOptions.
    const mpOn = isMpEnabled(dependencies.config);

    // El cliente PREGUNTA algo (cuánto tarda, cómo se paga, dónde retira…) en vez
    // de elegir. No te apures a matchear "tarjeta"/"retiro"/"domicilio" y disparar
    // el link o el submenú: si es pregunta, dejamos que el fallback de IA RESPONDA
    // primero (reaclarando aunque ya lo hayamos dicho) y re-pregunte la opción.
    // Caso real 1131381951 (2026-06-19): "Con tarjeta cuanto tardan" → el bot vio
    // "tarjeta" y mandó el link en vez de decir "7 a 10 días". (El submenú de
    // domicilio tiene su propio manejo de preguntas más abajo, así que no lo
    // tocamos acá.)
    // Excepción: elección DECISIVA aunque parezca pregunta (ver DECISIVE_CHOICE
    // arriba). Sin "?", con verbo de decisión, sin bloqueadores interrogativos, y
    // con UNA sola opción de envío nombrada (o un número de opción, ej: "me
    // conviene la 1"), es una elección — no la gateamos como pregunta.
    const _retiroKw = RETIRO_KEYWORDS.test(text);
    const _domicilioKw = DOMICILIO_KEYWORDS.test(text);
    const decisiveShippingChoice = !/[?¿]/.test(text)
        && DECISIVE_CHOICE.test(normalizedText)
        && !DECISIVE_BLOCKERS.test(normalizedText)
        && ((_retiroKw !== _domicilioKw) || _detectOptionNumber(text) !== null);
    const infoQuestion = !currentState.paymentSubChoiceAsked && !decisiveShippingChoice && _isInfoQuestion(text);

    // ── Estado sin zona resuelta ───────────────────────────────────────────────
    // Conversaciones abiertas antes de sep-2026, o reencauzadas acá por un cambio
    // de idea, pueden llegar sin saber de dónde es el cliente. Primero la zona:
    // _startZoneStep la resuelve sola si ya la dijo, o la pregunta.
    const alreadyPaidMp = currentState.paymentMethod === 'mercadopago' && (currentState as any).mpStatus === 'approved';
    if (!alreadyPaidMp && !currentState.deliveryZone) {
        const { _startZoneStep } = require('./stepWaitingZone');
        logger.info(`[PAYMENT_METHOD] ${userId} sin zona resuelta — paso a waiting_zone.`);
        await _startZoneStep(userId, text, currentState, knowledge, dependencies);
        return { matched: true };
    }

    // ── Cliente quiere ir al local físico ──────────────────────────────────────
    if (!alreadyPaidMp && PICKUP_INTENT_PAY.test(text)) {
        const reply = `No tenemos local para retirar 🙈 Desde tu zona va por *Correo Argentino* sin costo: a tu domicilio o a la sucursal más cercana a tu código postal, prepago con ${prepayMeans(mpOn)}, y llega en *4 días hábiles* 📦\n\n¿Lo querés en tu casa o en sucursal?`;
        currentState.shippingChoice = null;
        currentState.paymentSubChoiceAsked = false;
        saveState(userId);
        await sendMessageWithDelay(userId, reply);
        return { matched: true };
    }

    // ── Pide pagar al recibir / contrarreembolso ───────────────────────────────
    // Fuera de la zona de reparto no existe (ni a domicilio ni en sucursal): el
    // pedido va prepago. Un "pago al recibir" con un medio prepago nombrado ("con
    // tarjeta al recibir") es el mismo malentendido. Ver _handlePrepayObjection.
    // "lo pago en mi domicilio con tarjeta" nombra un medio prepago: entendió el
    // modelo, sigue por el camino normal (mismo criterio que antes de sep-2026).
    const namesPrepay = MP_KEYWORDS.test(text) || TRANSFER_KEYWORDS.test(normalizedText);
    if (!alreadyPaidMp
        && (PAY_ON_DELIVERY.test(normalizedText) || COD_REQUEST.test(normalizedText) || (PAY_AT_HOME.test(normalizedText) && !namesPrepay))
        && !NO_CASH.test(normalizedText)) {
        logger.info(`[PAYMENT_METHOD] ${userId} → pide pago al recibir fuera de zona ("${text.slice(0, 50)}").`);
        return await _handlePrepayObjection(userId, text, currentState, knowledge, dependencies, 'pago al recibir');
    }

    // Guard defensivo: recalcular totalPrice si está corrupto.
    const hasValidTotal = currentState.totalPrice
        && parseFloat(String(currentState.totalPrice).replace(/\./g, '').replace(',', '.')) > 0;
    if (!hasValidTotal && currentState.cart && currentState.cart.length > 0) {
        logger.warn(`[PAYMENT_METHOD] totalPrice corrupto/vacío para ${userId} — recalculando desde cart`);
        calculateTotal(currentState);
    }

    // Capturar postdatado si el cliente mencionó una fecha futura junto a la
    // elección de envío (reporte 2026-05-28: "A domicilio ya estaré avisándole
    // después del 10 recién" → el bot ignoraba el "después del 10"). Lo
    // guardamos en state.postdatado para que aparezca en order_confirmation_*.
    if (!currentState.postdatado) {
        const detectedPostdate = _detectPostdatado(normalizedText);
        if (detectedPostdate) {
            currentState.postdatado = detectedPostdate;
            logger.info(`[PAYMENT_METHOD] Postdatado capturado para ${userId}: "${detectedPostdate}"`);
            saveState(userId);
        }
    }

    const optionNum = _detectOptionNumber(text);

    // Negación dirigida a un medio de pago (ver _negatesOption arriba): la usan
    // el submenú MP/Transferencia y el atajo de medio directo para NO elegir la
    // opción que el cliente está rechazando.
    const mpNegated = _negatesOption(normalizedText, MP_KEYWORDS);
    const transferNegated = _negatesOption(normalizedText, TRANSFER_KEYWORDS);

    // ── Soft bailout / dilación (rev. 2026-05-30 reportes horacio) ─────────────
    // Cliente dice "gracias, voy a ver", "lo pienso", "me comunico", "ahora
    // averiguando", etc. SIN elegir opción de envío clara → no insistir, pausar.
    // Excepción: si TAMBIÉN matchea RETIRO/DOMICILIO/MP/Transfer, dejamos que
    // el flow procese la elección normalmente.
    const hasShippingChoice = !!optionNum
        || RETIRO_KEYWORDS.test(text)
        || DOMICILIO_KEYWORDS.test(text)
        || MP_KEYWORDS.test(text)
        || TRANSFER_KEYWORDS.test(normalizedText);
    if (!hasShippingChoice && SOFT_BAILOUT.test(normalizedText)) {
        const ackMsg = currentState.postdatado
            ? `¡Dale, te lo dejo anotado para *${currentState.postdatado}* 📅\n\nCuando estés lista, escribime y lo despachamos 😊`
            : `¡Dale, sin problema! Cuando estés lista, escribime y avanzamos 😊`;
        saveState(userId);
        await sendMessageWithDelay(userId, ackMsg);
        await _pauseAndAlert(
            userId, currentState, dependencies, text,
            `Cliente posterga decisión en waiting_payment_method (${currentState.postdatado ? 'postdatado ' + currentState.postdatado : 'sin fecha'}). Mensaje: "${text}". Pausado para que el admin retome cuando reescriba.`
        );
        logger.info(`[PAYMENT_METHOD] ${userId} → soft bailout detectado, pausado.`);
        return { matched: true };
    }

    // ── Desconfía del pago anticipado ──────────────────────────────────────────
    // (ver DISTRUST_PREPAY arriba). NO gateado por infoQuestion a propósito: el
    // mensaje suele venir como un comentario que _isInfoQuestion marca como
    // pregunta. Fuera de zona no hay alternativa sin prepago: va el argumento del
    // dueño (tarjeta protegida, 13 años) y, si insiste, el cierre + asesor. Si en
    // el mismo mensaje ELIGE un medio ("no me gusta transferir, mejor tarjeta"),
    // gana la elección.
    if (!alreadyPaidMp && !optionNum
        && !(MP_KEYWORDS.test(text) && !mpNegated)
        && !(TRANSFER_KEYWORDS.test(normalizedText) && !transferNegated)
        && !RETIRO_KEYWORDS.test(text) && !DOMICILIO_KEYWORDS.test(text)
        && DISTRUST_PREPAY.test(normalizedText)) {
        logger.info(`[PAYMENT_METHOD] ${userId} → desconfía del pago anticipado ("${text.slice(0, 50)}").`);
        return await _handlePrepayObjection(userId, text, currentState, knowledge, dependencies, 'desconfía del prepago');
    }

    // ── Ambigüedad de envío: nombró LAS DOS opciones sin decidir ───────────────
    // Caso 5493815010702 (error grave 25-jun): la clienta respondió "Sucursal o
    // abonar envío a domicilio" y el bot ASUMIÓ domicilio y la mandó a transferir.
    // Si menciona retiro/sucursal Y domicilio en el mismo mensaje (típico con un
    // "o" en el medio) y NO mandó un número, NO asumimos ninguna: la hacemos elegir.
    // Solo en la PRIMERA elección (sin shippingChoice todavía, no en el submenú).
    if (!infoQuestion && !optionNum && !currentState.shippingChoice
        && RETIRO_KEYWORDS.test(text) && DOMICILIO_KEYWORDS.test(text)) {
        const msg = `Son dos opciones 😊 Las dos van por Correo Argentino, prepago con ${prepayMeans(mpOn)}, y llegan en *4 días hábiles*:\n\n1️⃣ *A tu domicilio*\n2️⃣ *Retiro en la sucursal* más cercana a tu código postal\n\n¿Con cuál vas?`;
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[PAYMENT_METHOD] ${userId} → nombró AMBAS opciones (retiro + domicilio) sin decidir — re-pregunto en vez de asumir.`);
        return { matched: true };
    }

    // ── Sub-menú: el cliente ya eligió domicilio, ahora elige MP o Transferencia
    if (currentState.paymentSubChoiceAsked) {
        // Reset si el cliente cambió de idea y ahora prefiere retiro (reporte
        // 2026-05-29 5493435080705: el cliente clarificó "sería en sucursal" en
        // el submenú y el bot insistía con MP/Transfer). Reseteamos el flag y
        // dejamos que el path RETIRO de más abajo procese.
        const switchToRetiro = RETIRO_KEYWORDS.test(text) && currentState.shippingChoice !== 'retiro' && !DOMICILIO_KEYWORDS.test(text);
        const switchToDomicilio = (DOMICILIO_KEYWORDS.test(text) || HOME_SHORT.test(normalizedText)) && currentState.shippingChoice === 'retiro' && !RETIRO_KEYWORDS.test(text);
        if ((switchToRetiro || switchToDomicilio) && !MP_KEYWORDS.test(text) && !TRANSFER_KEYWORDS.test(normalizedText)) {
            // Cambió de domicilio a sucursal (o al revés) desde el submenú: el
            // prepago es el mismo, solo cambia dónde lo recibe. Re-ofrecemos el medio.
            currentState.shippingChoice = switchToRetiro ? 'retiro' : 'domicilio';
            if (!currentState.partialAddress) currentState.partialAddress = {};
            currentState.partialAddress.calle = switchToRetiro ? 'A sucursal' : undefined;
            logger.info(`[PAYMENT_METHOD] ${userId} cambió a ${currentState.shippingChoice} desde el submenú — re-ofrecido el medio.`);
            if (!mpOn) {
                await _sendTransferAliasAndAdvance(userId, currentState, knowledge, dependencies,
                    switchToRetiro ? 'Dale, lo dejamos para *retiro en sucursal* 📦\n\n' : 'Dale, a tu domicilio entonces 🏠\n\n');
                return { matched: true };
            }
            const key = switchToRetiro ? 'payment_sucursal_choice' : 'payment_domicilio_choice';
            const tpl = getFlowTemplate(key, knowledge) || `¿Cómo querés abonar?\n${prepayMenu(mpOn)}`;
            saveState(userId);
            await sendMessageWithDelay(userId, _formatMessage(tpl, currentState));
            return { matched: true };
        } else {
        const choseMp = (optionNum === '1') || (MP_KEYWORDS.test(text) && !mpNegated);
        const choseTransfer = (optionNum === '2') || (TRANSFER_KEYWORDS.test(normalizedText) && !transferNegated);

        // MP apagado + el cliente eligió tarjeta: solo puede pasar en conversaciones
        // que ya tenían el submenú servido cuando se apagó el interruptor. Se lo
        // decimos de frente y volvemos a la elección de ENVÍO (con MP off no hay
        // submenú al que volver: domicilio implica transferencia).
        if (!mpOn && choseMp && !choseTransfer) {
            currentState.paymentSubChoiceAsked = false;
            currentState.shippingChoice = null;
            const msg = cardUnavailableMessage(currentState.totalPrice);
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
            logger.info(`[PAYMENT_METHOD] ${userId} → pidió tarjeta en el submenú con MP APAGADO — avisado y re-preguntando envío.`);
            return { matched: true };
        }

        if (choseMp && !choseTransfer) {
            currentState.paymentMethod = 'mercadopago';
            currentState.senaAmount = null;
            currentState.senaPaid = false;
            _setStep(currentState, FlowStep.WAITING_MP_PAYMENT);
            // Ack corto antes de que el step de MP genere el link, sobre todo
            // cuando el cliente pidió por tarjeta de crédito explícito: deja
            // claro que el cobro va a salir vía MP sin que se sienta abrupto.
            const ackMsg = 'Ok, te paso el link de pago 👇';
            saveState(userId);
            await sendMessageWithDelay(userId, ackMsg);
            logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO + MP`);
            return { matched: false, staleReprocess: true } as any;
        }
        if (choseTransfer && !choseMp) {
            await _sendTransferAliasAndAdvance(userId, currentState, knowledge, dependencies);
            logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO + Transferencia`);
            return { matched: true };
        }

        // ── Ambigüedad: NO re-mandamos el mismo submenú a ciegas (causaba bucle
        // ignorando al cliente — caso 5491156581277). Interpretamos su mensaje.

        // (a) Quiere pagar en efectivo / al contado / en el domicilio / al recibir.
        // COD a domicilio NO existe → aclaramos y ofrecemos retiro en sucursal.
        const wantsCashAtHome = /\b(contado|al contado|efectivo|en\s+(el|mi)\s+(domicilio|casa)|en\s+casa|al\s+recibir|contra\s?entrega|cuando\s+(lo|me)\s+(reciba|llegue|entreguen|traigan))\b/i.test(normalizedText)
            && !NO_CASH.test(normalizedText)
            && !MP_KEYWORDS.test(text) && !TRANSFER_KEYWORDS.test(normalizedText);
        if (wantsCashAtHome) {
            logger.info(`[PAYMENT_METHOD] ${userId} → submenú: pidió pagar en efectivo / al recibir fuera de zona.`);
            return await _handlePrepayObjection(userId, text, currentState, knowledge, dependencies, 'efectivo/al recibir en el submenú');
        }

        // (b) Pregunta el precio → se lo damos y re-ofrecemos el medio de pago.
        const asksPrice = /\b(precio|cu[aá]nto|sale|vale|cuesta|valor|no\s+me\s+pasaste|no\s+me\s+pasaron|no\s+me\s+dijiste|cuanto\s+es|cuanto\s+sale)\b/i.test(normalizedText);
        if (asksPrice) {
            const prod = currentState.selectedProduct ? currentState.selectedProduct.split(' de ')[0] : 'el tratamiento';
            const planTxt = currentState.selectedPlan ? ` ${currentState.selectedPlan} días` : '';
            const msg = `El total es *$${currentState.totalPrice || '?'}* (${prod}${planTxt}) con *envío gratis* 📦\n\nAl ir prepago, apenas se acredita el pago el pedido sale y *llega en 4 días hábiles* 🚚\n\n¿Cómo querés abonar?\n${prepayMenu(mpOn)}`;
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
            logger.info(`[PAYMENT_METHOD] ${userId} → submenú: preguntó precio. Respondido + re-ofrecido medio de pago.`);
            return { matched: true };
        }

        // (c) Otra duda → IA para responderla (con anti-duplicado). No repetimos.
        const aiSub = await aiService.chat(text, {
            step: 'waiting_payment_method',
            goal: `El cliente (FUERA de la zona de reparto propio) eligió ${currentState.shippingChoice === 'retiro' ? 'RETIRO EN SUCURSAL de Correo Argentino (la asigna el Correo por el código postal)' : 'ENVÍO A DOMICILIO por Correo Argentino'} y debe elegir cómo abonar (es PREPAGO, antes del envío): ${mpOn
                ? '1) *Tarjeta de crédito* (link de pago protegido) o 2) *Transferencia* al alias *HERBALIS.TIENDA* (BIO ORIGEN S.A.S.). No ofrezcas débito, Pago Fácil ni Rapipago.'
                : '*transferencia bancaria* al alias *HERBALIS.TIENDA* a nombre de *BIO ORIGEN S.A.S.*. 🛑 EL PAGO CON TARJETA ESTÁ FUERA DE SERVICIO: NO lo ofrezcas ni menciones "tarjeta", "link de pago", "Mercado Pago", débito, Pago Fácil ni Rapipago; si lo pide, decile con naturalidad que no está disponible y ofrecele la transferencia.'} Fuera de Rosario y 60 km NO existe pago al recibir ni contrarreembolso (ni a domicilio ni en sucursal): si lo pide, explicá que el Correo volvió ese servicio lento y caro y por eso hoy va prepago. VENTAJA (usala para cerrar): al estar pago, el pedido sale enseguida y llega en *4 días hábiles*. Total del pedido: $${currentState.totalPrice || '?'}. Respondé su duda puntual con calidez y cerrá preguntando ${mpOn ? 'con cuál de los 2 medios quiere abonar' : 'si le pasás el alias'}. NUNCA menciones cuotas ni anticipo.`,
            history: currentState.history,
            summary: currentState.summary,
            knowledge,
            userState: currentState
        });
        if (aiSub.response && !_isDuplicate(aiSub.response, currentState.history)) {
            saveState(userId);
            await sendMessageWithDelay(userId, aiSub.response);
            return { matched: true };
        }

        // (d) Último recurso: re-ofrecer el submenú SOLO si no sería un duplicado.
        // Si lo sería, derivamos a humano en vez de entrar en bucle.
        const tpl = getFlowTemplate('payment_domicilio_choice', knowledge, !mpOn) ||
            `¿Cómo querés abonar?\n\n${prepayMenu(mpOn)}`;
        const msg = _formatMessage(tpl, currentState);
        if (_isDuplicate(msg, currentState.history)) {
            await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente en submenú de pago (domicilio) sin elegir MP/transferencia tras varios intentos. Evito bucle — derivar a humano.');
            return { matched: true };
        }
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
        }
    }

    // ── "No puedo efectivo" ────────────────────────────────────────────────────
    // Fuera de zona nada se paga en efectivo: todo va prepago. Se lo aclaramos y
    // seguimos con la elección de envío. Si ya eligió, cae al submenú/atajos.
    if (!infoQuestion && NO_CASH.test(normalizedText) && !currentState.shippingChoice
        && !RETIRO_KEYWORDS.test(text) && !DOMICILIO_KEYWORDS.test(text)) {
        const msg = `¡Tranqui! No hace falta efectivo: el pedido se abona antes con *${prepayMeans(mpOn)}* y, al estar pago, sale enseguida — *te llega en 4 días hábiles* 🚚\n\n¿Lo querés en tu casa o en sucursal?`;
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[PAYMENT_METHOD] ${userId} → negó efectivo, aclarado prepago, re-pregunto envío.`);
        return { matched: true };
    }

    // ── Elección: Retiro en sucursal (prepago) ─────────────────────────────────
    // Desde sep-2026 el retiro ya no es contrarreembolso: se abona antes, igual
    // que el domicilio, y el Correo asigna la sucursal por el CP, que se pide con
    // los datos después del pago (payment_mp_link_sucursal / closing_sucursal).
    if (!infoQuestion && (optionNum === '2' || RETIRO_KEYWORDS.test(text))) {
        currentState.shippingChoice = 'retiro';
        currentState.senaAmount = null;
        currentState.senaPaid = false;
        if (!currentState.partialAddress) currentState.partialAddress = {};
        currentState.partialAddress.calle = 'A sucursal';
        // Datos que haya dejado en este step (nombre, localidad, CP) se guardan
        // para no re-pedirlos después del pago.
        await _prefillRetiroFromHistory(userId, text, currentState, dependencies);
        const postdatePrefix = currentState.postdatado ? `¡Dale, anotado para ${currentState.postdatado} 📅!\n\n` : '';
        const intro = 'Dale, lo dejamos para *retiro en sucursal* 📦 El Correo te lo manda a la más cercana a tu código postal, y al estar pago *llega en 4 días hábiles*.\n\n';
        const asksCard = MP_KEYWORDS.test(text) && !mpNegated;
        const asksTransfer = TRANSFER_KEYWORDS.test(normalizedText) && !transferNegated;
        if (asksCard && !asksTransfer && !mpOn) {
            saveState(userId);
            await sendMessageWithDelay(userId, cardUnavailableMessage(currentState.totalPrice));
            logger.info(`[PAYMENT_METHOD] ${userId} → SUCURSAL + pidió tarjeta con MP APAGADO — avisado.`);
            return { matched: true };
        }
        if (asksCard && !asksTransfer) {
            currentState.paymentMethod = 'mercadopago';
            _setStep(currentState, FlowStep.WAITING_MP_PAYMENT);
            saveState(userId);
            await sendMessageWithDelay(userId, postdatePrefix + 'Dale, retiro en sucursal 📦 Te paso el link de pago 👇');
            logger.info(`[PAYMENT_METHOD] ${userId} → SUCURSAL + MP (atajo)`);
            return { matched: false, staleReprocess: true } as any;
        }
        if (!mpOn || asksTransfer) {
            await _sendTransferAliasAndAdvance(userId, currentState, knowledge, dependencies, postdatePrefix + intro);
            logger.info(`[PAYMENT_METHOD] ${userId} → SUCURSAL + Transferencia${mpOn ? ' (atajo)' : ' (MP apagado, sin submenú)'}`);
            return { matched: true };
        }
        currentState.paymentSubChoiceAsked = true;
        const tpl = getFlowTemplate('payment_sucursal_choice', knowledge) || (intro + `¿Cómo querés abonar?\n${prepayMenu(mpOn)}`);
        saveState(userId);
        await sendMessageWithDelay(userId, postdatePrefix + _formatMessage(tpl, currentState));
        logger.info(`[PAYMENT_METHOD] ${userId} → SUCURSAL — submenú prepago presentado`);
        return { matched: true };
    }

    // ── Elección: Envío a domicilio (prepago) → sub-menú MP/Transfer ───────────
    if (!infoQuestion && (optionNum === '1' || DOMICILIO_KEYWORDS.test(text) || HOME_SHORT.test(normalizedText))) {
        currentState.shippingChoice = 'domicilio';
        if (currentState.partialAddress?.calle === 'A sucursal') currentState.partialAddress.calle = undefined;
        // Acuse de postdatado si el cliente lo mencionó junto con el envío
        // (ej: "A domicilio ya estaré avisándole después del 10 recién").
        const postdatePrefix = currentState.postdatado
            ? `¡Dale, anotado para ${currentState.postdatado} 📅!\n\n`
            : '';
        // MP apagado: domicilio implica transferencia, no hay medio que elegir.
        // Le pasamos el alias directo — un submenú de una sola opción solo suma
        // un mensaje de ida y vuelta.
        if (!mpOn) {
            await _sendTransferAliasAndAdvance(
                userId, currentState, knowledge, dependencies,
                postdatePrefix + 'Perfecto, lo mandamos a tu domicilio 🏠 Al estar pago sale enseguida y *llega en 4 días hábiles* 🚚\n\n'
            );
            logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO + Transferencia (MP apagado, sin submenú)`);
            return { matched: true };
        }
        currentState.paymentSubChoiceAsked = true;
        const tpl = getFlowTemplate('payment_domicilio_choice', knowledge) ||
            `Perfecto, lo mandamos a tu domicilio 🏠\n\n¿Cómo querés abonar?\n\n1️⃣ *Tarjeta de crédito*\n2️⃣ *Transferencia bancaria*`;
        const msg = postdatePrefix + _formatMessage(tpl, currentState);
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO — submenú prepago presentado (postdatado: ${currentState.postdatado || 'no'})`);
        return { matched: true };
    }

    // ── Atajo: cliente menciona medio de pago directo sin elegir envío ─────────
    // Asumimos DOMICILIO (es la única opción que admite estos medios). Si quería
    // retiro debería decirlo explícitamente; el modelo nuevo no usa anticipo.
    // Un medio NEGADO ("no quiero pagar con tarjeta") no cuenta como elección:
    // cae al AI fallback, que sabe manejar la objeción.
    if (!infoQuestion && ((MP_KEYWORDS.test(text) && !mpNegated) || (TRANSFER_KEYWORDS.test(normalizedText) && !transferNegated))) {
        // MP apagado y pidió tarjeta (sin nombrar transferencia): se lo decimos y
        // le ofrecemos las dos vivas. NO fijamos shippingChoice — todavía no eligió
        // envío, y con la tarjeta descartada puede preferir el retiro.
        if (!mpOn && MP_KEYWORDS.test(text) && !mpNegated
            && !(TRANSFER_KEYWORDS.test(normalizedText) && !transferNegated)) {
            const msg = cardUnavailableMessage(currentState.totalPrice);
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
            logger.info(`[PAYMENT_METHOD] ${userId} → pidió tarjeta con MP APAGADO — avisado, ofrecidas transferencia y retiro.`);
            return { matched: true };
        }
        // Envío ya elegido (o pista de waiting_zone) se respeta; si no, domicilio.
        if (!currentState.shippingChoice) currentState.shippingChoice = 'domicilio';
        if (MP_KEYWORDS.test(text) && !mpNegated) {
            currentState.paymentMethod = 'mercadopago';
            currentState.senaAmount = null;
            currentState.senaPaid = false;
            _setStep(currentState, FlowStep.WAITING_MP_PAYMENT);
            // Ack corto antes de que el step MP genere el link — cubre el caso
            // "tarjeta de crédito" donde el cliente espera respuesta inmediata.
            const ackMsg = 'Ok, te paso el link de pago 👇';
            saveState(userId);
            await sendMessageWithDelay(userId, ackMsg);
            logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO + MP (atajo)`);
            return { matched: false, staleReprocess: true } as any;
        }
        await _sendTransferAliasAndAdvance(userId, currentState, knowledge, dependencies);
        logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO + Transferencia (atajo)`);
        return { matched: true };
    }

    // ── AI fallback ───────────────────────────────────────────────────────────
    const aiRes = await aiService.chat(text, {
        step: 'waiting_payment_method',
        goal: `El cliente está FUERA de la zona de reparto propio (Rosario y 60 km): su pedido va por *Correo Argentino*, SIN costo y SIEMPRE PREPAGO, y llega en *4 días hábiles* desde que se acredita el pago. Tiene que elegir DÓNDE recibirlo y CÓMO abonar:\n\n1️⃣ *Envío a domicilio*\n2️⃣ *Retiro en sucursal* de Correo Argentino (la asigna el Correo por el código postal, se retira con DNI)\n\nMedios (los dos envíos igual): ${mpOn
            ? `*tarjeta de crédito* (link de pago protegido) o *transferencia bancaria* al alias *HERBALIS.TIENDA* (BIO ORIGEN S.A.S.). No ofrezcas débito, Pago Fácil ni Rapipago.`
            : `*transferencia bancaria* al alias *HERBALIS.TIENDA* a nombre de *BIO ORIGEN S.A.S.*.\n\n🛑 EL PAGO CON TARJETA ESTÁ FUERA DE SERVICIO EN ESTOS DÍAS: NO lo ofrezcas ni lo menciones ("tarjeta", "link de pago", "Mercado Pago", débito, Pago Fácil, Rapipago). Si lo pide, decile con naturalidad que justo no está disponible y ofrecele la transferencia. No inventes motivos ni prometas cuándo vuelve.`}\n\nPROHIBICIONES ESTRICTAS:\n- NO ofrecer pago al recibir, contrarreembolso ni efectivo al cartero o en la sucursal: fuera de Rosario y alrededores NO existe. Si lo pide, explicá con calidez que hace 13 años enviábamos contrarreembolso pero el Correo Argentino tomó medidas que lo volvieron lento y muy caro para el cliente, por eso hoy va prepago y llega en 4 días; después ofrecé ${prepayMeans(mpOn)}.\n- NO mencionar anticipo de $10.000 ni adicional de $6.000 (no existen)\n- NO mencionar cuotas\n- NO inventar aliases distintos al oficial\n- NO hablar de reparto propio ni de "te lo llevamos nosotros": eso es solo para Rosario y 60 km, y este cliente no está ahí.\n\nSi el cliente responde con afirmativa genérica ("dale", "sí") sin aclarar, pedile que elija domicilio o sucursal. NUNCA avances sin que confirme cuál de las 2.\n\nSi DESCONFÍA de pagar por adelantado ("no me gustan las transferencias", "me da miedo pagar antes"): ${mpOn ? 'ofrecé la tarjeta de crédito: el link es protegido y si hay un problema con el envío le devuelven la plata' : 'recordale los 13 años y los 70.000 clientes'}. No prometas pago al recibir.\n\nSi el cliente PREGUNTA algo (cuánto tarda, cómo se paga, dónde retira, etc.) en vez de elegir: RESPONDÉ su pregunta reaclarando la info aunque YA se la hayas dicho antes (los clientes repreguntan y no se acuerdan), y RECIÉN DESPUÉS re-preguntá si prefiere domicilio o sucursal. NUNCA mandes el link de pago ni avances mientras el cliente siga preguntando.

TAG DE ELECCIÓN (para el sistema): si con este mensaje el cliente ELIGE claramente dónde recibirlo — aunque lo diga como comentario (ej: "me conviene ir a la sucursal del correo" = retiro) — incluí en extractedData exactamente "ENVIO: retiro" o "ENVIO: domicilio" (sin tilde), y tu respuesta debe avanzar acorde: confirmá dónde lo recibe y ${mpOn ? 'ofrecé 1️⃣ Tarjeta de crédito / 2️⃣ Transferencia bancaria' : 'pasale el alias *HERBALIS.TIENDA* (BIO ORIGEN S.A.S.) para que transfiera el total'}. Emití el tag SOLO cuando tu propia respuesta esté avanzando con esa opción — si el cliente solo pregunta, compara o duda, respondé la duda, re-preguntá cuál prefiere y NO emitas el tag.`,
        history: currentState.history,
        summary: currentState.summary,
        knowledge,
        userState: currentState
    });

    if (aiRes.response) {
        // Sincronizar la máquina de estados con lo que la IA concluyó (tag
        // "ENVIO: retiro|domicilio" — ver goal). Sin esto, si la clasificación
        // desvió una elección real al fallback, la IA avanzaba en el TEXTO
        // ("dale, retiro — ¿tu nombre completo?") pero el step seguía acá: los
        // datos que el cliente mandaba después caían en waiting_payment_method
        // y se perdían (caso real 5492215731759, 21-jul — venta trabada).
        const aiShipping = !alreadyPaidMp ? parseShippingChoice(aiRes.extractedData) : null;
        // Retiro + "transferencia" en el mismo mensaje = combo especial (alias +
        // verificación de comprobante por un asesor) — NO lo auto-seteamos como
        // contrarembolso acá; el path determinístico del combo lo maneja cuando
        // el cliente lo diga sin forma de pregunta.
        if (aiShipping === 'retiro' || aiShipping === 'domicilio') {
            // Fuera de zona las dos van prepago: solo cambia dónde lo recibe. La
            // IA ya ofreció el medio (así se lo pide el goal): habilitamos el submenú.
            currentState.shippingChoice = aiShipping;
            if (!currentState.partialAddress) currentState.partialAddress = {};
            currentState.partialAddress.calle = aiShipping === 'retiro' ? 'A sucursal' : undefined;
            currentState.senaAmount = null;
            currentState.senaPaid = false;
            if (aiShipping === 'retiro') await _prefillRetiroFromHistory(userId, text, currentState, dependencies);
            if (mpOn) {
                currentState.paymentSubChoiceAsked = true;
                logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO vía tag de IA (ENVIO: domicilio) — submenú habilitado.`);
            } else {
                // Sin tarjeta el submenú no existe: domicilio = transferencia. La IA
                // ya le pasó el alias (así se lo pide el goal), así que sincronizamos
                // el step para que su "listo" lo tome waiting_transfer_confirmation
                // y no vuelva a caer acá.
                currentState.paymentMethod = 'transferencia';
                currentState.senaAmount = null;
                currentState.senaPaid = false;
                _setStep(currentState, FlowStep.WAITING_TRANSFER_CONFIRMATION);
                logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO vía tag de IA con MP apagado — step sincronizado a waiting_transfer_confirmation.`);
            }
        }
        // saveState ANTES del send (delay humanizado 4-8s): si el proceso se cae
        // en el medio, la transición ya quedó persistida — igual que los paths
        // determinísticos del step.
        saveState(userId);
        await sendMessageWithDelay(userId, aiRes.response);
        return { matched: true };
    }

    await _pauseAndAlert(userId, currentState, dependencies, text, 'No se pudo determinar la elección de envío del cliente.');
    return { matched: true };
}
