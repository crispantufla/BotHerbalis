/**
 * Cuando el cliente DIFIERE la compra a futuro —"te vuelvo a escribir la semana
 * que viene", "cuando cobre te digo", "me voy de viaje"— el bot tiene que
 * OFRECER dejarlo anotado para ese día, no aflojar con un "vale, cuando quieras".
 *
 * Lo resuelve detectPostponeDeferral() en objectionDetector: dispara 'postergar'
 * con un rebuttal que ofrece dejarlo anotado (cubriendo "lo compro más adelante"
 * y "no voy a estar en casa").
 *
 * La restricción dura es CERO falsos positivos sobre frases de compra-YA,
 * fecha-de-entrega o datos: si el cliente está cerrando, no se le puede ofrecer
 * aplazarlo. Esta batería es la versión peninsular de la que calibró el bot
 * argentino (allí eran modismos rioplatenses).
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
    'te vuelvo a escribir la semana que viene',
    'te vuelvo a escribir la semana que viene, que cobro',
    'me encantaria pero ahora no tengo dinero, cuando cobre te digo',
    'la semana que viene cobro y entonces te lo pido',
    'en cuanto me ingresen te escribo y lo pedimos',
    'ahora estoy tieso, a final de mes lo pillo',
    'espero la paga extra y entonces te lo pido',
    'lo consulto y te vuelvo a escribir la semana que viene',
    'esta bien, te confirmo mas adelante',
    'vale, cualquier cosa te escribo otro dia',
    'me voy de viaje la semana que viene, no voy a estar para recibirlo',
    'me mudo el mes que viene asi que ahora no me viene bien pedirlo',
    'me voy al pueblo 15 dias, dejalo para cuando vuelva por favor',
    'anotalo para el uno de agosto',
    'vale, mandalo despues del 20 de julio',
    'te escribo en 2 semanas',
    'te escribo en una semana',
    'hablamos en 2 semanas',
    'hablamos en un par de semanas',
    'te digo en 15 dias',
    'en un mes te escribo',
];

// NO debe disparar (compra/recepción YA, fecha de entrega, dato, afirmación):
const SHOULD_NOT_FIRE = [
    'vale lo quiero, mandamelo la semana que viene para que me llegue',
    'perfecto, necesito que me llegue para el lunes, se puede?',
    'que me llegue el lunes para tenerlo',
    'aunque me vaya de viaje me lo pueden dejar en casa, cierralo',
    'mandamelo a esta direccion que es donde voy a estar de vacaciones: gran via 45',
    'a que direccion lo mando si me estoy mudando?',
    'cualquier cosa te digo',
    'ahora estoy en el trabajo, luego te escribo',
    'manana te confirmo que lo vea bien',
    'ahora no puedo, en un rato te escribo',
    'ya he cobrado, lo quiero',
    'vale ya tengo el dinero, hagamoslo',
    'lo quiero ya, cuando me lo podeis mandar',
    'me llamo ana, calle mayor 12 3 b, 28013 madrid',
    'cuanto vale el de 60?',
    'el de 120 cuanto cuesta y en cuanto llega',
    'perfecto, lo pago al recibirlo entonces',
    'vale, lo recojo en correos y lo pago alli',
];

describe('detectPostponeDeferral — familia "diferir compra a futuro"', () => {
    test('la evasiva suave anclada a fecha futura dispara', () => {
        expect(detectPostponeDeferral(norm('te vuelvo a escribir la semana que viene'))).toBe(true);
        expect(detectPostponeDeferral(norm('te vuelvo a escribir la semana que viene, que cobro'))).toBe(true);
    });

    test.each(SHOULD_OFFER)('OFRECE postdatar: "%s"', (txt) => {
        expect(detectPostponeDeferral(norm(txt))).toBe(true);
    });

    test.each(SHOULD_NOT_FIRE)('NO dispara (compra-ya / entrega / dato): "%s"', (txt) => {
        expect(detectPostponeDeferral(norm(txt))).toBe(false);
    });
});

describe('detectObjection — el diferimiento se enruta como postergar con oferta de agendar', () => {
    test('evasiva anclada → postergar tier=standard con rebuttal que ofrece anotarlo', () => {
        const m = detectObjection('waiting_ok', norm('te vuelvo a escribir la semana que viene, que cobro'), freshState());
        expect(m).not.toBeNull();
        expect(m.type).toBe('postergar');
        expect(m.tier).toBe('standard');
        // El rebuttal dedicado lidera con dejarlo anotado (no rechaza, no congela precio)
        expect(m.response).toMatch(/anotad|anotado|anoto/i);
        expect(m.response).not.toMatch(/congel/i);
        // CIERRA: empuja a tomar datos / fecha, no afloja la venta.
        expect(m.response).toMatch(/dato|qué día|que dia|recibirlo|cuándo|cuando/i);
    });

    test('una categoría explícita (consultar) gana sobre el diferimiento', () => {
        // "tengo que consultar con mi marido" + evasiva: debe ser 'consultar', no 'postergar'
        const m = detectObjection('waiting_ok', norm('tengo que consultar con mi marido y te vuelvo a escribir la semana que viene'), freshState());
        expect(m).not.toBeNull();
        expect(m.type).toBe('consultar');
    });

    test('no dispara en steps fuera de ACTIVE_STEPS', () => {
        const m = detectObjection('greeting', norm('te vuelvo a escribir la semana que viene, que cobro'), freshState({ step: 'greeting' }));
        expect(m).toBeNull();
    });

    test('regresión: el path viejo de postergar por keyword sigue andando', () => {
        const m = detectObjection('waiting_plan_choice', norm('cobro el viernes'), freshState({ step: 'waiting_plan_choice' }));
        expect(m).not.toBeNull();
        expect(m.type).toBe('postergar');
    });
});

describe('_detectPostdatado — gate cobre/cobrar', () => {
    test('"cuando cobre" ahora captura (antes el gate lo bloqueaba)', () => {
        expect(_detectPostdatado(norm('dale, cuando cobre'))).toBeTruthy();
    });

    test('"ya he cobrado, lo quiero" NO aplaza (quiere comprar ya)', () => {
        expect(_detectPostdatado(norm('ya cobre, lo quiero'))).toBeNull();
    });

    test('"cobro el 5" sigue capturando (regresión)', () => {
        expect(_detectPostdatado(norm('cobro el 5 y entonces te lo pido'))).toBeTruthy();
    });
});
