import { UserState, FlowStep } from '../../types/state';
import { _setStep, _pauseAndAlert, _detectPostdatado, _isInfoQuestion } from '../utils/flowHelpers';
import { parseShippingChoice } from '../utils/extractedData';
import { getFlowTemplate } from '../../utils/messageTemplates';
import { calculateTotal } from '../utils/cartHelpers';
import { _formatMessage, _isDuplicate } from '../utils/messages';
import { _handleRetiroData } from './stepWaitingData';
import logger from '../../utils/logger';

// Modelo nuevo de pago (may-2026): el menú pregunta primero TIPO DE ENVÍO.
//   1️⃣ Retiro en sucursal → contrarreembolso, paga total en efectivo al retirar
//   2️⃣ Envío a domicilio  → se abona previamente (MP o transferencia)
//
// Cliente quiere ir al local físico (que no tenemos) — distinto de "retiro en
// sucursal" del Correo. Pausamos para que el admin coordine.
const PICKUP_INTENT_PAY = /\b(voy\s+(?:yo|al?\s+local|a\s+(?:buscar|retirar))|paso\s+(?:a\s+)?(?:buscar|retirar)|ir\s+al?\s+local|ir\s+a\s+buscar|busco\s+yo)\b/i;
const ROSARIO_INTENT_PAY = /\b(soy\s+de\s+rosario|estoy\s+en\s+rosario|vivo\s+en\s+rosario|de\s+rosario(?:\s+(?:capital|provincia|centro))?)\b/i;

// Shipping choice keywords.
const RETIRO_KEYWORDS = /\b(retiro|retir(?:ar|o)\s+en\s+sucursal|en\s+sucursal|a\s+sucursal|en\s+la\s+sucursal|sucursal\s+(?:de\s+)?correo|sucursal|contra.?reembolso|contrarembolso)\b/i;
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
const PAY_ON_DELIVERY = /\b(al recibir|al recibirlo|al recibirla|cuando (?:lo |la |me )?reciba|cuando (?:me )?llegue|cuando me lo traigan|cuando me lo entreguen|contra ?entrega|al cartero|al recibir el (?:paquete|producto|pedido))\b/i;

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

export async function handleWaitingPaymentMethod(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    knowledge: any,
    dependencies: any
): Promise<{ matched: boolean }> {
    const { sendMessageWithDelay, aiService, saveState } = dependencies;

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

    // ── Cliente quiere ir al local físico ──────────────────────────────────────
    // Distinto de "retiro en sucursal" del Correo. Pausamos.
    const alreadyPaidMp = currentState.paymentMethod === 'mercadopago' && (currentState as any).mpStatus === 'approved';
    if (!alreadyPaidMp && (PICKUP_INTENT_PAY.test(text) || ROSARIO_INTENT_PAY.test(text))) {
        const reply = 'Te aviso: no tenemos local de venta al público — todos los pedidos van por Correo Argentino con envío gratis 📦\n\nUn asesor te va a contactar enseguida para coordinar la mejor opción (retiro en sucursal cerca tuyo o entrega a domicilio) 😊';
        currentState.history.push({ role: 'bot', content: reply, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, reply);
        await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente quiere retirar en persona / es de Rosario en waiting_payment_method. Admin coordinar logística.');
        return { matched: true };
    }

    // ── Malentendido: "pago al recibir" con MP/transferencia/domicilio ─────────
    // La clienta quiere pagar al cartero con un medio que es PREPAGO. Aclaramos
    // (con empatía — suele venir de miedo a estafa) y re-preguntamos, SIN avanzar
    // al link ni al submenú. Si mencionó retiro/sucursal, NO es malentendido
    // (ahí pagar al recibir en efectivo es correcto) → dejamos pasar.
    const alreadyPaidMpClar = currentState.paymentMethod === 'mercadopago' && (currentState as any).mpStatus === 'approved';
    if (!alreadyPaidMpClar
        && PAY_ON_DELIVERY.test(normalizedText)
        && !RETIRO_KEYWORDS.test(text)
        && (MP_KEYWORDS.test(text) || TRANSFER_KEYWORDS.test(normalizedText) || DOMICILIO_KEYWORDS.test(text))) {
        currentState.paymentSubChoiceAsked = false;
        currentState.shippingChoice = null;
        const msg = `¡Ojo, te aclaro así no hay malentendidos! 😊\n\nCon *tarjeta de crédito* o *transferencia* el pago es *antes* del envío (online) — al cartero no se le paga.\n\nPara *pagar al recibir, en efectivo*, la opción es *retiro en sucursal*: te llega a una sucursal de Correo Argentino cerca tuyo y pagás el total recién cuando lo retirás 💵\n\n¿Cómo preferís?\n1️⃣ *Retiro en sucursal* (pagás al retirar, en efectivo)\n2️⃣ *Envío a tu casa* (pagás ahora con tarjeta de crédito o transferencia)`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[PAYMENT_METHOD] ${userId} → malentendido "pago al recibir" con medio prepago/domicilio. Aclarado, re-preguntando.`);
        return { matched: true };
    }

    // ── Malentendido: "lo pago en mi domicilio" / "pago en casa" ───────────────
    // (ver PAY_AT_HOME arriba.) La clienta quiere PAGAR AL RECIBIR EN SU CASA, que
    // ya no existe. Se distingue de "envío a domicilio" por el verbo de pago pegado
    // a "casa/domicilio". Si NO nombró un medio prepago (tarjeta/transferencia) ni
    // retiro, aclaramos que pagar al recibir en efectivo es SOLO retiro en sucursal
    // y re-preguntamos — SIN tomarlo como elección de domicilio.
    if (!alreadyPaidMpClar
        && PAY_AT_HOME.test(normalizedText)
        && !RETIRO_KEYWORDS.test(text)
        && !MP_KEYWORDS.test(text)
        && !TRANSFER_KEYWORDS.test(normalizedText)) {
        currentState.paymentSubChoiceAsked = false;
        currentState.shippingChoice = null;
        const msg = `¡Ojo, te aclaro así no hay malentendidos! 😊\n\nPagar *al recibir, en efectivo* solo se puede con *retiro en sucursal*: el paquete llega a la sucursal de Correo Argentino más cercana a tu casa y pagás el total *$${currentState.totalPrice || '?'}* recién cuando lo retirás 💵 — al cartero, en la puerta de tu casa, no se le paga.\n\nSi preferís recibirlo *en tu domicilio*, el pago va *antes* del envío (tarjeta de crédito o transferencia).\n\n¿Cómo preferís?\n1️⃣ *Retiro en sucursal* (pagás al retirar, en efectivo)\n2️⃣ *Envío a tu casa* (pagás ahora con tarjeta de crédito o transferencia)`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[PAYMENT_METHOD] ${userId} → malentendido "pago al recibir en domicilio/casa". Aclarado COD = retiro en sucursal, re-preguntando.`);
        return { matched: true };
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
        currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, ackMsg);
        await _pauseAndAlert(
            userId, currentState, dependencies, text,
            `Cliente posterga decisión en waiting_payment_method (${currentState.postdatado ? 'postdatado ' + currentState.postdatado : 'sin fecha'}). Mensaje: "${text}". Pausado para que el admin retome cuando reescriba.`
        );
        logger.info(`[PAYMENT_METHOD] ${userId} → soft bailout detectado, pausado.`);
        return { matched: true };
    }

    // ── Desconfía del pago anticipado → liderar con RETIRO EN SUCURSAL ─────────
    // (ver DISTRUST_PREPAY arriba). NO gateado por infoQuestion a propósito: el
    // mensaje suele venir como un comentario que _isInfoQuestion marca como
    // pregunta, y antes caía al AI fallback (que ofrecía tarjeta = otro prepago).
    // Solo en la PRIMERA elección (no en el submenú) y si NO eligió ya tarjeta/MP
    // (gana su elección) ni sucursal (lo maneja el path de retiro más abajo).
    if (!alreadyPaidMp && !currentState.paymentSubChoiceAsked && !optionNum
        && !currentState.shippingChoice
        && !MP_KEYWORDS.test(text) && !RETIRO_KEYWORDS.test(text)
        && DISTRUST_PREPAY.test(normalizedText)) {
        const msg = `Te entiendo perfecto, las transferencias a veces son un lío 😊\n\nQuedate tranqui: *no hace falta que pagues nada por adelantado*. Con *retiro en sucursal* te lo enviamos a la sucursal de Correo Argentino más cercana a tu casa y *pagás el total ($${currentState.totalPrice || '?'}) en efectivo recién cuando lo retirás* 💵 — sin transferencias ni pagos online.\n\n¿Lo dejamos así, retiro en sucursal y pagás al retirar?`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[PAYMENT_METHOD] ${userId} → desconfía del pago anticipado → ofrecido RETIRO en sucursal (efectivo al retirar).`);
        return { matched: true };
    }

    // ── Ambigüedad de envío: nombró LAS DOS opciones sin decidir ───────────────
    // Caso 5493815010702 (error grave 25-jun): la clienta respondió "Sucursal o
    // abonar envío a domicilio" y el bot ASUMIÓ domicilio y la mandó a transferir.
    // Si menciona retiro/sucursal Y domicilio en el mismo mensaje (típico con un
    // "o" en el medio) y NO mandó un número, NO asumimos ninguna: la hacemos elegir.
    // Solo en la PRIMERA elección (sin shippingChoice todavía, no en el submenú).
    if (!infoQuestion && !optionNum && !currentState.shippingChoice
        && RETIRO_KEYWORDS.test(text) && DOMICILIO_KEYWORDS.test(text)) {
        const msg = `Son dos opciones distintas 😊 ¿Con cuál vas?\n\n1️⃣ *Retiro en sucursal* → no pagás nada ahora, abonás el total *en efectivo cuando lo retirás*.\n2️⃣ *Envío a domicilio* → lo pagás antes (tarjeta de crédito o transferencia) y llega más rápido, en *4 días hábiles* 🚚`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
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
        if (RETIRO_KEYWORDS.test(text)) {
            logger.info(`[PAYMENT_METHOD] ${userId} cambió de domicilio a RETIRO en submenú — reset y reprocesar.`);
            currentState.paymentSubChoiceAsked = false;
            currentState.shippingChoice = null;
            saveState(userId);
            // Caemos al path RETIRO normal sin return — el matchea por RETIRO_KEYWORDS abajo.
        } else {
        const choseMp = (optionNum === '1') || MP_KEYWORDS.test(text);
        const choseTransfer = (optionNum === '2') || TRANSFER_KEYWORDS.test(normalizedText);

        if (choseMp && !choseTransfer) {
            currentState.paymentMethod = 'mercadopago';
            currentState.senaAmount = null;
            currentState.senaPaid = false;
            _setStep(currentState, FlowStep.WAITING_MP_PAYMENT);
            // Ack corto antes de que el step de MP genere el link, sobre todo
            // cuando el cliente pidió por tarjeta de crédito explícito: deja
            // claro que el cobro va a salir vía MP sin que se sienta abrupto.
            const ackMsg = 'Ok, te paso el link de pago 👇';
            currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, ackMsg);
            logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO + MP`);
            return { matched: false, staleReprocess: true } as any;
        }
        if (choseTransfer && !choseMp) {
            currentState.paymentMethod = 'transferencia';
            currentState.senaAmount = null;
            currentState.senaPaid = false;
            const tpl = getFlowTemplate('payment_transfer_alias', knowledge) ||
                `¡Perfecto! Para transferir usá el alias *{{ALIAS}}* a nombre de *{{TITULAR}}* 🏦\n\nMonto: ${'$'}{{TOTAL}}\n\nUna vez que realices la transferencia, escribime *"listo"* y coordinamos el envío 😊`;
            const msg = _formatMessage(tpl, currentState);
            _setStep(currentState, FlowStep.WAITING_TRANSFER_CONFIRMATION);
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
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
            currentState.paymentSubChoiceAsked = false;
            currentState.shippingChoice = null;
            const msg = `¡Te aclaro! 😊 A *domicilio* el pago es *anticipado* (tarjeta de crédito o transferencia) — al cartero no se le paga.\n\nSi querés *pagar al recibir en efectivo*, lo mandamos a la *sucursal de Correo Argentino* más cercana a tu casa y pagás el total *$${currentState.totalPrice || '?'}* cuando lo retirás 💵\n\n¿Cómo preferís?\n1️⃣ *Retiro en sucursal* (pagás al retirar, en efectivo)\n2️⃣ *Envío a tu casa* (pagás ahora con tarjeta de crédito o transferencia)`;
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
            logger.info(`[PAYMENT_METHOD] ${userId} → submenú: pidió pagar en efectivo/domicilio. Aclarado COD = retiro en sucursal.`);
            return { matched: true };
        }

        // (b) Pregunta el precio → se lo damos y re-ofrecemos el medio de pago.
        const asksPrice = /\b(precio|cu[aá]nto|sale|vale|cuesta|valor|no\s+me\s+pasaste|no\s+me\s+pasaron|no\s+me\s+dijiste|cuanto\s+es|cuanto\s+sale)\b/i.test(normalizedText);
        if (asksPrice) {
            const prod = currentState.selectedProduct ? currentState.selectedProduct.split(' de ')[0] : 'el tratamiento';
            const planTxt = currentState.selectedPlan ? ` ${currentState.selectedPlan} días` : '';
            const msg = `El total es *$${currentState.totalPrice || '?'}* (${prod}${planTxt}) con *envío gratis* 📦\n\nAl ir prepago, apenas se acredita el pago el pedido sale y *llega en 4 días hábiles* 🚚\n\n¿Cómo querés abonar?\n1️⃣ *Tarjeta de crédito*\n2️⃣ *Transferencia bancaria*`;
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
            logger.info(`[PAYMENT_METHOD] ${userId} → submenú: preguntó precio. Respondido + re-ofrecido medio de pago.`);
            return { matched: true };
        }

        // (c) Otra duda → IA para responderla (con anti-duplicado). No repetimos.
        const aiSub = await aiService.chat(text, {
            step: 'waiting_payment_method',
            goal: `El cliente eligió ENVÍO A DOMICILIO y debe elegir cómo abonar (es PREPAGO, antes del envío): 1) *Tarjeta de crédito* (link de pago protegido) o 2) *Transferencia* al alias *HERBALIS.TIENDA* (BIO ORIGEN S.A.S.). De cara al cliente el medio online se llama "Tarjeta de crédito" (NUNCA "Mercado Pago", débito, Pago Fácil ni Rapipago). A domicilio NO se paga en efectivo al recibir; el pago en efectivo SOLO existe con *retiro en sucursal* (pagás al retirar). VENTAJA DEL PREPAGO (usala para cerrar): al estar pago, el pedido sale antes y llega más rápido, en *4 días hábiles* (el retiro en sucursal tarda 7 a 10). Total del pedido: $${currentState.totalPrice || '?'}. Respondé su duda puntual con calidez y cerrá preguntando con cuál de los 2 medios quiere abonar. NUNCA menciones cuotas ni anticipo.`,
            history: currentState.history,
            summary: currentState.summary,
            knowledge,
            userState: currentState
        });
        if (aiSub.response && !_isDuplicate(aiSub.response, currentState.history)) {
            currentState.history.push({ role: 'bot', content: aiSub.response, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, aiSub.response);
            return { matched: true };
        }

        // (d) Último recurso: re-ofrecer el submenú SOLO si no sería un duplicado.
        // Si lo sería, derivamos a humano en vez de entrar en bucle.
        const tpl = getFlowTemplate('payment_domicilio_choice', knowledge) ||
            `¿Cómo querés abonar?\n\n1️⃣ *Tarjeta de crédito*\n2️⃣ *Transferencia bancaria*`;
        const msg = _formatMessage(tpl, currentState);
        if (_isDuplicate(msg, currentState.history)) {
            await _pauseAndAlert(userId, currentState, dependencies, text, 'Cliente en submenú de pago (domicilio) sin elegir MP/transferencia tras varios intentos. Evito bucle — derivar a humano.');
            return { matched: true };
        }
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        return { matched: true };
        }
    }

    // ── "No puedo efectivo" → PREPAGO a domicilio (NO retiro) ──────────────────
    // El cliente niega poder pagar en efectivo. Retiro en sucursal = pagar en
    // efectivo al retirar, así que mandarlo a retiro es lo contrario de lo que
    // pidió. Lo encauzamos a domicilio con pago anticipado. Si ADEMÁS pidió retiro
    // explícito (mensaje mixto), gana el retiro (cae al path de abajo).
    if (!infoQuestion && NO_CASH.test(normalizedText) && !RETIRO_KEYWORDS.test(text)) {
        currentState.shippingChoice = 'domicilio';
        currentState.paymentSubChoiceAsked = true;
        const msg = `¡Tranqui! Para envío a domicilio el pago es *anticipado* con *tarjeta de crédito* o *transferencia* — no hace falta efectivo 😊\n\nY al estar pago, el pedido sale enseguida: *te llega en 4 días hábiles* 🚚\n\n¿Cómo preferís abonar?\n1️⃣ *Tarjeta de crédito*\n2️⃣ *Transferencia bancaria*`;
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[PAYMENT_METHOD] ${userId} → negó efectivo, encauzado a DOMICILIO prepago (submenú).`);
        return { matched: true };
    }

    // ── Elección 1: Retiro en sucursal (contrarreembolso, 100% al retirar) ────
    // Rev. 2026-05-30: en lugar de pausar inmediatamente, le pedimos los datos
    // al cliente (con aclaración de "es para buscar la sucursal más cercana") y
    // dejamos que pase por waiting_data. Al guardar la orden, calle se reescribe
    // a "A sucursal" y la calle real queda en calleOriginal (ver stepWaitingData
    // y _finalizeOrderAndNotifyAdmin).
    if (!infoQuestion && (optionNum === '1' || RETIRO_KEYWORDS.test(text))) {
        // ── Combo (jun-2026): RETIRO en sucursal + pago por TRANSFERENCIA ──────────
        // El estándar de retiro es efectivo al retirar, pero el cliente PUEDE pedir
        // pagar por transferencia y retirar igual. No es el flujo automático normal:
        // le damos el alias, pedimos los datos para asignar la sucursal y derivamos a
        // un asesor para coordinar y verificar la transferencia (no auto-confirmamos
        // porque el pago por transferencia requiere chequear el comprobante).
        if (TRANSFER_KEYWORDS.test(normalizedText)) {
            currentState.shippingChoice = 'retiro';
            currentState.paymentMethod = 'transferencia';
            currentState.senaAmount = 0;
            currentState.senaPaid = false;
            if (!currentState.partialAddress) currentState.partialAddress = {};
            currentState.partialAddress.calle = 'A sucursal';
            const msg = `¡Dale! Lo dejamos para *retiro en sucursal* y lo abonás por *transferencia* 📦\n\nPara transferir usá el alias *HERBALIS.TIENDA* a nombre de *BIO ORIGEN S.A.S.* — monto *$${currentState.totalPrice || '?'}*.\n\nPasame también, así te asigno la sucursal más cercana:\nNombre completo:\nLocalidad / Ciudad:\nCódigo postal:\n\nCuando hagas la transferencia, escribime *"listo"* con el comprobante 😊`;
            currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, msg);
            await _pauseAndAlert(userId, currentState, dependencies, text, `Combo retiro en sucursal + transferencia (lo pidió el cliente). Coordinar la sucursal de Correo Argentino más cercana y verificar la transferencia ($${currentState.totalPrice || '?'}) cuando mande el comprobante.`);
            logger.info(`[PAYMENT_METHOD] ${userId} → RETIRO + TRANSFERENCIA (combo) — alias enviado, pausado para coordinación.`);
            return { matched: true };
        }

        currentState.paymentMethod = 'contrarembolso';
        currentState.senaAmount = 0;
        currentState.senaPaid = false;
        currentState.shippingChoice = 'retiro';

        // Retiro en sucursal NO necesita calle/número: con localidad + CP se asigna
        // la sucursal de Correo Argentino que corresponde. Pre-seteamos calle='A
        // sucursal' para que waiting_data NO pida ni valide la calle (el parseo de
        // calle y la validación por Maps quedan guardados por !partialAddress.calle).
        if (!currentState.partialAddress) currentState.partialAddress = {};
        currentState.partialAddress.calle = 'A sucursal';

        // Si el cliente ya dejó datos MIENTRAS el step seguía acá (una mala
        // clasificación previa lo tiene contestando "¿tu nombre?" desde el AI
        // fallback sin transicionar — caso real 5492215731759), rescatarlos del
        // historial para no re-pedirle todo de cero.
        await _prefillRetiroFromHistory(userId, text, currentState, dependencies);

        const _addr = currentState.partialAddress;
        if (_addr.nombre && _addr.ciudad && _addr.cp) {
            // Ya está todo → cerrar por el mismo camino que usa waiting_data para
            // retiro (arma pendingOrder + confirmación + orden 'Confirmado').
            _setStep(currentState, FlowStep.WAITING_DATA);
            saveState(userId);
            logger.info(`[PAYMENT_METHOD] ${userId} → RETIRO con datos completos desde historial — cierro directo.`);
            const closed = await _handleRetiroData(userId, text, normalizedText, currentState, knowledge, dependencies);
            if (closed) return closed;
        }

        const _faltan: string[] = [];
        if (!_addr.nombre) _faltan.push('Nombre completo:');
        if (!_addr.ciudad) _faltan.push('Localidad / Ciudad:');
        if (!_addr.cp) _faltan.push('Código postal:');
        const msg = `¡Listo! Lo dejamos para retiro en sucursal 📦\n\nVas a pagar el total *$${currentState.totalPrice || '?'}* en efectivo cuando lo retirés.\n\nNo necesito tu dirección exacta — con tu *localidad y código postal* te asigno la sucursal de Correo Argentino que te corresponde. Pasame:\n\n${_faltan.join('\n')}`;
        _setStep(currentState, FlowStep.WAITING_DATA);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[PAYMENT_METHOD] ${userId} → RETIRO EN SUCURSAL — pidiendo datos para buscar sucursal cercana (faltan: ${_faltan.length})`);
        return { matched: true };
    }

    // ── Elección 2: Envío a domicilio (prepago) → sub-menú MP/Transfer ─────────
    if (!infoQuestion && (optionNum === '2' || DOMICILIO_KEYWORDS.test(text))) {
        currentState.shippingChoice = 'domicilio';
        currentState.paymentSubChoiceAsked = true;
        const tpl = getFlowTemplate('payment_domicilio_choice', knowledge) ||
            `Perfecto, lo mandamos a tu domicilio 🏠\n\n¿Cómo querés abonar?\n\n1️⃣ *Tarjeta de crédito*\n2️⃣ *Transferencia bancaria*`;
        // Acuse de postdatado si el cliente lo mencionó junto con el envío
        // (ej: "A domicilio ya estaré avisándole después del 10 recién").
        const postdatePrefix = currentState.postdatado
            ? `¡Dale, anotado para ${currentState.postdatado} 📅!\n\n`
            : '';
        const msg = postdatePrefix + _formatMessage(tpl, currentState);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO — submenú prepago presentado (postdatado: ${currentState.postdatado || 'no'})`);
        return { matched: true };
    }

    // ── Atajo: cliente menciona medio de pago directo sin elegir envío ─────────
    // Asumimos DOMICILIO (es la única opción que admite estos medios). Si quería
    // retiro debería decirlo explícitamente; el modelo nuevo no usa anticipo.
    if (!infoQuestion && (MP_KEYWORDS.test(text) || TRANSFER_KEYWORDS.test(normalizedText))) {
        currentState.shippingChoice = 'domicilio';
        if (MP_KEYWORDS.test(text)) {
            currentState.paymentMethod = 'mercadopago';
            currentState.senaAmount = null;
            currentState.senaPaid = false;
            _setStep(currentState, FlowStep.WAITING_MP_PAYMENT);
            // Ack corto antes de que el step MP genere el link — cubre el caso
            // "tarjeta de crédito" donde el cliente espera respuesta inmediata.
            const ackMsg = 'Ok, te paso el link de pago 👇';
            currentState.history.push({ role: 'bot', content: ackMsg, timestamp: Date.now() });
            saveState(userId);
            await sendMessageWithDelay(userId, ackMsg);
            logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO + MP (atajo)`);
            return { matched: false, staleReprocess: true } as any;
        }
        currentState.paymentMethod = 'transferencia';
        currentState.senaAmount = null;
        currentState.senaPaid = false;
        const tpl = getFlowTemplate('payment_transfer_alias', knowledge) ||
            `¡Perfecto! Para transferir usá el alias *{{ALIAS}}* a nombre de *{{TITULAR}}* 🏦\n\nMonto: ${'$'}{{TOTAL}}\n\nUna vez que realices la transferencia, escribime *"listo"* y coordinamos el envío 😊`;
        const msg = _formatMessage(tpl, currentState);
        _setStep(currentState, FlowStep.WAITING_TRANSFER_CONFIRMATION);
        currentState.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, msg);
        logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO + Transferencia (atajo)`);
        return { matched: true };
    }

    // ── AI fallback ───────────────────────────────────────────────────────────
    const aiRes = await aiService.chat(text, {
        step: 'waiting_payment_method',
        goal: `El cliente debe elegir TIPO DE ENVÍO antes que método de pago. Las 2 opciones son:\n\n1️⃣ *Retiro en sucursal* → paga el TOTAL en efectivo al retirar en una sucursal de Correo Argentino (contrarreembolso, sin anticipo previo). Un asesor coordina la sucursal más cercana al cliente.\n\n2️⃣ *Envío a domicilio* → se abona previamente. Después se elige el medio: *tarjeta de crédito* (link de pago protegido) o *transferencia bancaria* al alias *HERBALIS.TIENDA* (BIO ORIGEN S.A.S.). De cara al cliente el medio online se llama "Tarjeta de crédito" (NUNCA "Mercado Pago", débito, Pago Fácil ni Rapipago).\n\nAmbos envíos son GRATIS por Correo Argentino. Tiempos: *retiro en sucursal* (paga al retirar) 7 a 10 días hábiles; *envío a domicilio PREPAGO* (tarjeta de crédito o transferencia) más rápido, 4 días hábiles — usá la velocidad como argumento para el prepago.\n\nPROHIBICIONES ESTRICTAS:\n- NO mencionar anticipo de $10.000 (esa modalidad fue eliminada en mayo 2026)\n- NO ofrecer pago en efectivo al cartero a domicilio — el contrarreembolso ahora es solo en sucursal\n- NO mencionar cuotas\n- NO inventar aliases distintos al oficial\n\nSi el cliente responde con afirmativa genérica ("dale", "sí") sin aclarar, pedile que elija retiro o domicilio. NUNCA avances sin que confirme cuál de las 2 opciones de ENVÍO eligió.\n\nSi el cliente NIEGA poder pagar en efectivo ("no puedo efectivo", "no tengo efectivo", "no manejo efectivo"): NO lo mandes a retiro en sucursal (que es justamente pagar en efectivo al retirar). Ofrecé envío a DOMICILIO con pago anticipado por tarjeta de crédito o transferencia.\n\nSi el cliente DESCONFÍA de pagar por adelantado o de las transferencias/pagos online ("no me gustan las transferencias", "he tenido problemas", "me da miedo pagar antes", "no confío en pagar online"): NO insistas con tarjeta de crédito — eso TAMBIÉN es pago anticipado y es justo lo que lo asusta. Ofrecé *retiro en sucursal*: NO paga nada por adelantado, abona el total en efectivo recién cuando lo retira en la sucursal de Correo Argentino. Es la opción sin riesgo para quien no quiere pagar online, y va alineado con cómo cierra el vendedor a mano.\n\nSi el cliente PREGUNTA algo (cuánto tarda, cómo se paga, dónde retira, cuánto sale el envío, etc.) en vez de elegir: RESPONDÉ su pregunta reaclarando la info aunque YA se la hayas dicho antes (los clientes repreguntan y no se acuerdan — está bien repetir), y RECIÉN DESPUÉS re-preguntá si prefiere retiro o domicilio. NUNCA mandes el link de pago ni avances mientras el cliente siga preguntando.

TAG DE ELECCIÓN (para el sistema): si con este mensaje el cliente ELIGE claramente una de las dos opciones de envío — aunque lo diga como comentario y no como respuesta directa (ej: "me conviene ir a la sucursal del correo y abonar ahí" = retiro) — incluí en extractedData exactamente "ENVIO: retiro" o "ENVIO: domicilio" (sin tilde), y tu respuesta debe avanzar acorde: para retiro, confirmá y pedí Nombre completo, Localidad/Ciudad y Código postal; para domicilio, ofrecé 1️⃣ Tarjeta de crédito / 2️⃣ Transferencia bancaria. Emití el tag SOLO cuando tu propia respuesta esté avanzando con esa opción — si el cliente solo pregunta, compara o duda, respondé la duda, re-preguntá cuál prefiere y NO emitas el tag.`,
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
        if (aiShipping === 'retiro' && !TRANSFER_KEYWORDS.test(normalizedText)) {
            currentState.paymentMethod = 'contrarembolso';
            currentState.senaAmount = 0;
            currentState.senaPaid = false;
            currentState.shippingChoice = 'retiro';
            if (!currentState.partialAddress) currentState.partialAddress = {};
            currentState.partialAddress.calle = 'A sucursal';
            // Rescatar datos ya dejados en el historial de este step (mismo
            // criterio que el path determinístico de retiro).
            await _prefillRetiroFromHistory(userId, text, currentState, dependencies);
            _setStep(currentState, FlowStep.WAITING_DATA);
            logger.info(`[PAYMENT_METHOD] ${userId} → RETIRO vía tag de IA (ENVIO: retiro) — step sincronizado a waiting_data.`);
        } else if (aiShipping === 'domicilio') {
            currentState.shippingChoice = 'domicilio';
            currentState.paymentSubChoiceAsked = true;
            logger.info(`[PAYMENT_METHOD] ${userId} → DOMICILIO vía tag de IA (ENVIO: domicilio) — submenú habilitado.`);
        }
        // saveState ANTES del send (delay humanizado 4-8s): si el proceso se cae
        // en el medio, la transición ya quedó persistida — igual que los paths
        // determinísticos del step.
        currentState.history.push({ role: 'bot', content: aiRes.response, timestamp: Date.now() });
        saveState(userId);
        await sendMessageWithDelay(userId, aiRes.response);
        return { matched: true };
    }

    await _pauseAndAlert(userId, currentState, dependencies, text, 'No se pudo determinar la elección de envío del cliente.');
    return { matched: true };
}
