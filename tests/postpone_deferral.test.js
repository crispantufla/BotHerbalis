/**
 * Regresión (reporte del dueño, 29-jun): "al bot se le pasan los postdatados".
 * Cuando el cliente DIFIERE la compra a futuro —"te vuelvo a hablar la semana
 * que viene", "...que cobro", "cuando cobre te aviso", "me voy de viaje"— el bot
 * no ofrecía agendar/postdatar. La detección determinística no cubría esa familia
 * (solo lo *podía* agarrar la IA, de forma poco confiable).
 *
 * Fix: detectPostponeDeferral() en objectionDetector — dispara 'postergar' con un
 * rebuttal que OFRECE agendar (cubriendo "vas a comprar" y "no estás en casa").
 * Calibrado contra una batería de 90 frases rioplatenses verificada de forma
 * adversarial; la restricción dura es CERO falsos positivos sobre frases de
 * compra-YA / fecha-de-entrega / afirmaciones.
 *
 * Además: el gate de _detectPostdatado listaba `cobro` pero no `cobre`, así que
 * bloqueaba la captura de "cuando cobre" pese a tener el patrón de extracción.
 */
jest.mock('../db', () => ({ prisma: {} }));
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../src/services/funnelLogger', () => ({
    logStepTransition: jest.fn(), markExit: jest.fn().mockResolvedValue(undefined), logMessage: jest.fn().mockResolvedValue(undefined),
}));

const { detectObjection, detectPostponeDeferral } = require('../src/flows/utils/objectionDetector');
const helpers = require('../src/flows/utils/flowHelpers');
const _detectPostdatado = helpers._detectPostdatado;

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const freshState = (over = {}) => ({ step: 'waiting_ok', history: [], objectionsHandled: {}, ...over });

// ── Subconjunto curado de la batería adversarial ───────────────────────────
// SÍ debe ofrecer postdatar (difiere por plata / ausencia / soft-exit anclado):
const SHOULD_OFFER = [
    'te vuelvo a hablar la semana que viene',                 // caso exacto del dueño
    'te vuelvo a hablar la semana que viene, que cobro',      // caso exacto del dueño
    'uff me encantaria pero ahora no tengo plata, cuando cobre te aviso',
    'la semana que viene cobro y ahi te compro tranqui',
    'apenas me depositen te hablo y lo encargamos',
    'ahora ando seco, a fin de mes lo agarro',
    'espero el aguinaldo y ahi me lo pido tranquilo',
    'lo consulto y te vuelvo a escribir la semana que viene',
    'esta bien, te confirmo mas adelante',
    'ok cualquier cosa te escribo otro dia',
    'me voy de viaje la semana que viene, no voy a estar para recibirlo',
    'me mudo el mes que viene asi que ahora no me conviene pedirlo',
    'me voy al sur 15 dias, dejalo para cuando vuelva porfa',
    'agendamelo para el primero de agosto',
    'dale, mandalo despues del 20 de julio',
    // Reporte dueño: "te hablo en 2 semanas" → el bot aflojaba con "tranqui cuando quieras".
    'te hablo en 2 semanas',
    'te escribo en una semana',
    'nos hablamos en 2 semanas',
    'hablamos en un par de semanas',
    'te aviso en 15 dias',
    'en un mes te hablo',
];

// NO debe disparar (compra/recepción YA, fecha de entrega, dato, afirmación):
const SHOULD_NOT_FIRE = [
    'dale lo quiero, mandamelo la semana que viene asi me llega',
    'perfecto, necesito que me llegue para el lunes, se puede?',
    'que me llegue el lunes asi lo tengo',
    'igual aunque viaje me lo pueden recibir en casa, dale cerralo',
    'mandamelo a esta direccion que es donde voy a estar de vacaciones: san martin 450',
    'a que direccion lo mando si me estoy por mudar?',
    'cualquier cosa te aviso',
    'ahora estoy en el laburo, mas tarde te escribo',
    'manana te confirmo asi lo veo bien',
    'ahora no puedo, en un rato te hablo',
    'ya cobre, lo quiero',
    'dale ya tengo la plata, hacemoslo',
    'lo quiero ya, cuando me lo podes mandar',
    'mi nombre es ana, calle belgrano 1234, cp 1407 caba',
    'cuanto sale el de 60?',
    'el de 90 cuanto cuesta y en cuanto llega',
    'perfe, transferencia entonces',
    'ok lo pago al retirar en la sucursal',
];

describe('detectPostponeDeferral — familia "diferir compra a futuro"', () => {
    test('los 2 casos exactos del dueño disparan', () => {
        expect(detectPostponeDeferral(norm('te vuelvo a hablar la semana que viene'))).toBe(true);
        expect(detectPostponeDeferral(norm('te vuelvo a hablar la semana que viene, que cobro'))).toBe(true);
    });

    test.each(SHOULD_OFFER)('OFRECE postdatar: "%s"', (txt) => {
        expect(detectPostponeDeferral(norm(txt))).toBe(true);
    });

    test.each(SHOULD_NOT_FIRE)('NO dispara (compra-ya / entrega / dato): "%s"', (txt) => {
        expect(detectPostponeDeferral(norm(txt))).toBe(false);
    });
});

describe('detectObjection — el diferimiento se enruta como postergar con oferta de agendar', () => {
    test('caso del dueño → postergar tier=standard con rebuttal que ofrece agendar', () => {
        const m = detectObjection('waiting_ok', norm('te vuelvo a hablar la semana que viene, que cobro'), freshState());
        expect(m).not.toBeNull();
        expect(m.type).toBe('postergar');
        expect(m.tier).toBe('standard');
        // El rebuttal dedicado lidera con agendar/programar (no rechaza, no congela precio)
        expect(m.response).toMatch(/agend|program/i);
        expect(m.response).not.toMatch(/congel/i);
        // CIERRA: empuja a tomar datos / fecha, no afloja la venta (feedback dueño 29-jun:
        // "no hace falta que lo resuelvas ahora" sobra, hay que cerrarla).
        expect(m.response).toMatch(/dato|cargo el pedido|qué día|que dia|recibirlo/i);
        expect(m.response).not.toMatch(/no hace falta que lo resuelvas/i);
    });

    test('una categoría explícita (consultar) gana sobre el diferimiento', () => {
        // "tengo que consultar con mi marido" + soft-exit: debe ser 'consultar', no 'postergar'
        const m = detectObjection('waiting_ok', norm('tengo que consultar con mi marido y te vuelvo a hablar la semana que viene'), freshState());
        expect(m).not.toBeNull();
        expect(m.type).toBe('consultar');
    });

    test('no dispara en steps fuera de ACTIVE_STEPS', () => {
        const m = detectObjection('greeting', norm('te vuelvo a hablar la semana que viene, que cobro'), freshState({ step: 'greeting' }));
        expect(m).toBeNull();
    });

    test('regresión: el path viejo de postergar por keyword sigue andando', () => {
        const m = detectObjection('waiting_plan_choice', norm('cobro el viernes recien'), freshState({ step: 'waiting_plan_choice' }));
        expect(m).not.toBeNull();
        expect(m.type).toBe('postergar');
    });
});

describe('_detectPostdatado — gate cobre/cobrar', () => {
    test('"cuando cobre" ahora captura (antes el gate lo bloqueaba)', () => {
        expect(_detectPostdatado(norm('dale, cuando cobre'))).toBeTruthy();
    });

    test('"ya cobre, lo quiero" NO postdata (quiere comprar ya)', () => {
        expect(_detectPostdatado(norm('ya cobre, lo quiero'))).toBeNull();
    });

    test('"cobro el 5" sigue capturando (regresión)', () => {
        expect(_detectPostdatado(norm('cobro el 5 y ahi te compro'))).toBeTruthy();
    });
});
