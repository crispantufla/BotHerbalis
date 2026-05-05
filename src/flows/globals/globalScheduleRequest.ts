import { UserState } from '../../types/state';
import { _pauseAndAlert } from '../utils/flowHelpers';
import logger from '../../utils/logger';

/**
 * Global interceptor: detecta cuando un cliente pide un horario ESPECÍFICO
 * de entrega (ej: "vengan mañana a las 17:30", "que pase a las 5 de la tarde").
 *
 * Por qué existe: Correo Argentino NO permite agendar horarios — los carteros
 * van cuando van. La IA, al ser preguntada por un horario, antes inventaba
 * promesas tipo "El envío está programado para mañana a las 17:30 a tu
 * domicilio en X" que después no se podían cumplir.
 *
 * Caso real disparador (3-4/05/2026): cliente pidió "Hola Mañana ala tarde
 * pueden venir 17 30" y la IA respondió "Podemos programar el envío para
 * mañana a las 17:30". El paquete obviamente no llegó a esa hora y el
 * cliente quedó molesto.
 *
 * Comportamiento: en lugar de delegar al AI, pausamos al cliente y avisamos
 * al admin para que coordine manualmente. Salvo que el cliente esté
 * pidiendo postdatado por DÍA (sin hora), eso lo maneja el flujo normal.
 */

// Detector de "hora específica" en el mensaje:
// - "17:30", "17.30", "17 30", "17hs", "5pm", "5 pm"
// - "a las 5 de la tarde", "a las 17", "a las 5 y media"
// - Combinado con verbos de entrega: "vengan", "pasen", "llegue", "envíen"
const TIME_HHMM = /\b([01]?\d|2[0-3])[\s.:hH]+?([0-5]\d)\b/;                  // 17:30, 17 30, 17h30
const TIME_HOUR_AM_PM = /\b(1[0-2]|[1-9])\s*(am|pm|hs|h)\b/i;                  // 5pm, 11hs
const TIME_PHRASE = /\b(a las|hacia las|sobre las)\s+(1[0-9]|2[0-3]|[1-9])(\s*(:|h|hs|y|y media|y cuarto|de la|am|pm))?/i;
const TIME_PART_OF_DAY_VERB = /\b(vengan|pasen|venir|llegue|llegar|env[ií]en|enviar|despachen|despachar|tra[ie]r|tra[ie]gan)\b.*\b(ma[nñ]ana|tarde|noche|mediod[ií]a|temprano)\b/i;
const TIME_VERB_AT_TIME = /\b(vengan|pasen|venir|llegue|llegar|env[ií]en|despachen|tra[ie]gan|reparti[rd])\b.*\b(a las|hacia las|sobre las)\b/i;

export function _detectScheduleRequest(text: string): boolean {
    const t = (text || '').toLowerCase();

    // 1) Tiene HH:MM (ej: 17:30, 17 30, 17h30)
    if (TIME_HHMM.test(t)) return true;

    // 2) Tiene "5pm" / "11hs"
    if (TIME_HOUR_AM_PM.test(t)) return true;

    // 3) "a las 5", "a las 5 de la tarde", "a las 17"
    if (TIME_PHRASE.test(t)) return true;

    // 4) Verbo de entrega + "a las..." (ej: "que vengan a las...")
    if (TIME_VERB_AT_TIME.test(t)) return true;

    // 5) Verbo de entrega + parte del día (ej: "que pasen mañana a la tarde")
    if (TIME_PART_OF_DAY_VERB.test(t)) return true;

    return false;
}

// Solo interceptamos si el cliente está EN o PASADO el step de pago/datos —
// antes de eso, una mención casual de hora (ej: "el de la mañana", "tomo
// cápsulas a la noche") no es pedido de horario de envío. El detector ya es
// bastante específico, pero esto suma seguridad.
const STEPS_RELEVANT = new Set<string>([
    'waiting_payment_method', 'waiting_mp_payment', 'waiting_transfer_confirmation',
    'waiting_data', 'waiting_maps_confirmation', 'waiting_final_confirmation',
    'waiting_admin_validation', 'completed', 'post_sale',
]);

export async function handleScheduleRequest(
    userId: string,
    text: string,
    normalizedText: string,
    currentState: UserState,
    dependencies: any,
): Promise<{ matched: boolean; paused?: boolean } | null> {
    const step = currentState.step as string;
    if (!STEPS_RELEVANT.has(step)) return null;
    if (!_detectScheduleRequest(text)) return null;

    logger.info(`[SCHEDULE-REQ] ${userId} pidió horario específico de entrega en step="${step}". Pausando y alertando admin.`);

    const reply =
        'No puedo asegurarte un horario específico — el envío lo hace el ' +
        'Correo Argentino y no tenemos forma de coordinar la hora exacta del ' +
        'cartero 😔\n\n' +
        'Lo que sí podemos hacer es programar la fecha de despacho o avisarte ' +
        'cuando llegue al correo de tu zona para que lo retires en sucursal.\n\n' +
        'Te derivo con un asesor para coordinar esto manualmente, ¿dale? 😊';

    currentState.history.push({ role: 'bot', content: reply, timestamp: Date.now() });
    if (typeof dependencies.sendMessageWithDelay === 'function') {
        await dependencies.sendMessageWithDelay(userId, reply);
    }

    await _pauseAndAlert(
        userId, currentState, dependencies, text,
        'Cliente pidió un horario específico de entrega (Correo Argentino no permite agendar horario). Coordinar manualmente.',
    );

    return { matched: true, paused: true };
}
