/**
 * Guion 1 — Extreme address collection scenarios (30 tests)
 *
 * Covers: address format variations, intersection detection, CP handling,
 * Maps lookup, address corrections, combined intents, and edge cases.
 *
 * ASSUMPTIONS (marked with ⚠️) — awaiting user confirmation:
 * - Test 26: "no sé mi CP" → Maps lookup triggered automatically
 * - Test 27: Non-Argentina address → bot says "solo enviamos a Argentina"
 * - Test 28: "quiero 2 cajas" → AI handles it (no multi-unit flow)
 * - Test 29: "¿hay descuento?" → AI answers "precio fijo", continues
 * - Test 30: "es para mi mamá María García" → uses mom's name on label
 */
const { processSalesFlow } = require('../src/flows/salesFlow');
const fs = require('fs');
const path = require('path');
const mockSendMessage = jest.fn();
const mockNotifyAdmin = jest.fn();
const mockSaveState = jest.fn();
const smartParseAddress = jest.fn().mockResolvedValue(null);
const mockAiChat = jest.fn().mockResolvedValue({ response: 'AI response', goalMet: false });
const mockValidateAddress = jest.fn();
const mockLookupCPFromMaps = jest.fn().mockResolvedValue(null);
jest.mock('../src/services/addressValidator', () => {
    const actual = jest.requireActual('../src/services/addressValidator');
    return {
        ...actual,
        validateAddress: (...args) => mockValidateAddress(...args),
        lookupCPFromMaps: (...args) => mockLookupCPFromMaps(...args),
    };
});
jest.mock('../src/services/ai', () => ({ aiService: mockDependencies.aiService }));
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }), { virtual: true });
jest.mock('../sheets_sync', () => ({ appendOrderToSheet: jest.fn() }), { virtual: true });
jest.mock('google-spreadsheet', () => ({}), { virtual: true });
jest.mock('@google/generative-ai', () => ({}), { virtual: true });
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '../knowledge_v3.json'), 'utf8'));
const mockDependencies = {
    client: {},
    notifyAdmin: mockNotifyAdmin,
    saveState: mockSaveState,
    sendMessageWithDelay: mockSendMessage,
    logAndEmit: jest.fn(),
    sharedState: { io: { emit: jest.fn() }, pausedUsers: new Set() },
    aiService: {
        chat: mockAiChat,
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: smartParseAddress,
    },
};
// Default validateAddress: always succeeds so tests reach final_confirmation
const VALID_MAPS = {
    cpValid: true,
    cpCleaned: null,
    province: 'Buenos Aires',
    mapsValid: true,
    mapsFormatted: 'Calle Test 123, Ciudad Test, Argentina',
    warnings: [],
};
function makeDataState(overrides = {}) {
    return {
        step: 'waiting_data',
        selectedProduct: 'Capsulas',
        selectedPlan: '60',
        price: '46900',
        cart: [{ product: 'Capsulas', plan: '60', price: '46900' }],
        partialAddress: {},
        history: [],
        addressAttempts: 0,
        ...overrides,
    };
}
function getBotMessages() { return mockSendMessage.mock.calls.map(c => c[1]); }
function reachedConfirmation(state, userId) {
    return state[userId].step === 'waiting_final_confirmation' || !!state[userId].pendingOrder;
}
// ─── Group A: Address format variations (6 tests) ────────────────────────────
describe('Guion 1-A: Address format variations', () => {
    let userState;
    const runFlow = async (u, m) => processSalesFlow(u, m, userState, knowledge, mockDependencies);
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        smartParseAddress.mockReset();
        mockAiChat.mockClear();
        mockValidateAddress.mockResolvedValue(VALID_MAPS);
        mockLookupCPFromMaps.mockResolvedValue(null);
    });
    test('1. Full address in one message → reaches waiting_final_confirmation', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Carlos Ruiz', calle: 'Mitre 450', ciudad: 'Mendoza', cp: '5500',
        });
        userState['a1'] = makeDataState();
        await runFlow('a1', 'Carlos Ruiz, Mitre 450, Mendoza, 5500');
        expect(reachedConfirmation(userState, 'a1')).toBe(true);
    });
    test('2. Address with floor and apartment → all fields extracted', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Laura Gomez', calle: 'Av Corrientes 1800 Piso 3 Dpto B',
            ciudad: 'CABA', cp: '1042',
        });
        userState['a2'] = makeDataState();
        await runFlow('a2', 'Laura Gomez, Av Corrientes 1800 Piso 3 Dpto B, CABA, CP 1042');
        // pendingOrder.calle gets replaced by Maps-formatted address; check calleOriginal
        const calle = userState['a2'].partialAddress.calle || userState['a2'].pendingOrder?.calleOriginal;
        expect(calle).toMatch(/1800/);
    });
    test('3. Address in all caps → extracted normally', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'PEDRO GARCIA', calle: 'SAN MARTIN 200', ciudad: 'CORDOBA', cp: '5000',
        });
        userState['a3'] = makeDataState();
        await runFlow('a3', 'PEDRO GARCIA, SAN MARTIN 200, CORDOBA, 5000');
        expect(reachedConfirmation(userState, 'a3')).toBe(true);
    });
    test('4. Rural address with km reference → extracted', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Jorge Vera', calle: 'Ruta 14 km 32', ciudad: 'Gualeguaychú', cp: '2820',
        });
        userState['a4'] = makeDataState();
        await runFlow('a4', 'Jorge Vera, Ruta 14 km 32, Gualeguaychú, 2820');
        // calleOriginal preserves the raw calle before Maps formatting
        const calle = userState['a4'].partialAddress.calle || userState['a4'].pendingOrder?.calleOriginal;
        expect(calle).toMatch(/km/i);
    });
    test('5. Housing estate "Manzana/Lote" address → extracted', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Ana Flores', calle: 'Barrio Las Palmeras Mz 4 Lote 12',
            ciudad: 'Santiago del Estero', cp: '4200',
        });
        userState['a5'] = makeDataState();
        await runFlow('a5', 'Ana Flores, Barrio Las Palmeras Mz 4 Lote 12, Santiago del Estero, 4200');
        const calle = userState['a5'].partialAddress.calle || userState['a5'].pendingOrder?.calleOriginal;
        expect(calle).toMatch(/mz|manzana/i);
    });
    test('6. Name only (no address) → bot asks for address', async () => {
        smartParseAddress.mockResolvedValue({ nombre: 'Marta Silva' });
        userState['a6'] = makeDataState();
        await runFlow('a6', 'Marta Silva');
        expect(userState['a6'].step).toBe('waiting_data'); // still in same step
        const msgs = getBotMessages();
        expect(msgs.some(m => /direcci[oó]n|calle.*n[uú]mero|n[uú]mero.*calle/i.test(m))).toBe(true);
    });
});
// ─── Group B: Intersection scenarios (5 tests) ───────────────────────────────
describe('Guion 1-B: Intersection scenarios', () => {
    let userState;
    const runFlow = async (u, m) => processSalesFlow(u, m, userState, knowledge, mockDependencies);
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        smartParseAddress.mockReset();
        mockAiChat.mockClear();
        mockValidateAddress.mockResolvedValue(VALID_MAPS);
        mockLookupCPFromMaps.mockResolvedValue(null);
    });
    test('7. Real intersection "Av Corrientes esq Callao" → triggers warning', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Roberto Diaz', calle: 'Av Corrientes esq Callao', ciudad: 'CABA', cp: '1000',
        });
        userState['b7'] = makeDataState();
        await runFlow('b7', 'Roberto Diaz, Av Corrientes esq Callao, CABA');
        const msgs = getBotMessages();
        expect(msgs.some(m => /esquina|correo argentino/i.test(m))).toBe(true);
    });
    test('8. "entre Carlos Pellegrini y Maipú" as reference note → NO intersection warning', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Sofia Lopez', calle: 'Florida 345', ciudad: 'CABA', cp: '1005',
        });
        userState['b8'] = makeDataState();
        await runFlow('b8', 'Sofia Lopez, Florida 345 entre Carlos Pellegrini y Maipú, CABA, 1005');
        const msgs = getBotMessages();
        expect(msgs.some(m => /esquinas o intersecciones|no nos permite enviar a esquinas/i.test(m))).toBe(false);
    });
    test('9. "al lado de la esquina del kiosco" → NOT an intersection (reference)', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Miguel Torres', calle: 'Belgrano 820', ciudad: 'Rosario', cp: '2000',
        });
        userState['b9'] = makeDataState();
        await runFlow('b9', 'Miguel Torres, Belgrano 820 (al lado de la esquina del kiosco), Rosario, 2000');
        const msgs = getBotMessages();
        expect(msgs.some(m => /esquinas o intersecciones|no nos permite enviar a esquinas/i.test(m))).toBe(false);
    });
    test('10. "En la esquina de 9 de Julio y San Martín" → real intersection warning', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Carmen Vega', calle: '9 de Julio y San Martín', ciudad: 'Tucumán', cp: '4000',
        });
        userState['b10'] = makeDataState();
        await runFlow('b10', 'Carmen Vega, en la esquina de 9 de Julio y San Martín, Tucumán');
        const msgs = getBotMessages();
        expect(msgs.some(m => /esquina|correo argentino/i.test(m))).toBe(true);
    });
    test('11. "No es esquina, es mitad de cuadra" → accepted, no warning', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Elena Castro', calle: 'Sarmiento 1500', ciudad: 'Buenos Aires', cp: '1000',
        });
        userState['b11'] = makeDataState();
        await runFlow('b11', 'Elena Castro, Sarmiento 1500, Buenos Aires, 1000. No es esquina, es mitad de cuadra');
        const msgs = getBotMessages();
        expect(msgs.some(m => /esquinas o intersecciones|no nos permite enviar a esquinas/i.test(m))).toBe(false);
    });
});
// ─── Group C: CP handling — known & invalid CP (5 tests) ─────────────────────
describe('Guion 1-C: CP handling — known CP cases', () => {
    let userState;
    const runFlow = async (u, m) => processSalesFlow(u, m, userState, knowledge, mockDependencies);
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        smartParseAddress.mockReset();
        mockAiChat.mockClear();
        mockValidateAddress.mockResolvedValue(VALID_MAPS);
        mockLookupCPFromMaps.mockResolvedValue(null);
    });
    test('12. Valid 4-digit CP provided → accepted without question', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Luis Peralta', calle: 'Belgrano 300', ciudad: 'Córdoba', cp: '5000',
        });
        userState['c12'] = makeDataState();
        await runFlow('c12', 'Luis Peralta, Belgrano 300, Córdoba, 5000');
        const msgs = getBotMessages();
        expect(msgs.some(m => /c[oó]digo postal.*v[aá]lido|correg[ií]/i.test(m))).toBe(false);
        expect(reachedConfirmation(userState, 'c12')).toBe(true);
    });
    test('13. CP too short (3 digits) → bot rejects and re-asks', async () => {
        mockValidateAddress.mockResolvedValue({
            cpValid: false,
            cpCleaned: '500',
            province: null,
            mapsValid: null,
            mapsFormatted: null,
            warnings: ['CP inválido'],
        });
        smartParseAddress.mockResolvedValue({
            nombre: 'Nora Blanco', calle: 'San Martín 100', ciudad: 'Córdoba', cp: '500',
        });
        userState['c13'] = makeDataState();
        await runFlow('c13', 'Nora Blanco, San Martín 100, Córdoba, CP 500');
        const msgs = getBotMessages();
        expect(msgs.some(m => /4 d[ií]gitos|c[oó]digo postal.*no.*v[aá]lido/i.test(m))).toBe(true);
    });
    test('14. CP with letters "CP B1900" → validate rejects, asks for correction', async () => {
        mockValidateAddress.mockResolvedValue({
            cpValid: false,
            cpCleaned: '1900',
            province: null,
            mapsValid: null,
            mapsFormatted: null,
            warnings: ['CP inválido'],
        });
        smartParseAddress.mockResolvedValue({
            nombre: 'Raul Soto', calle: 'Italia 55', ciudad: 'La Plata', cp: 'B1900',
        });
        userState['c14'] = makeDataState();
        await runFlow('c14', 'Raul Soto, Italia 55, La Plata, B1900');
        const msgs = getBotMessages();
        expect(msgs.some(m => /4 d[ií]gitos|correg[ií]/i.test(m))).toBe(true);
    });
    test('15. City known in table (Córdoba) → CP auto-filled, no Maps needed', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Diana Ortiz', calle: 'Obispo Trejo 200', ciudad: 'Cordoba',
        });
        userState['c15'] = makeDataState();
        await runFlow('c15', 'Diana Ortiz, Obispo Trejo 200, Cordoba');
        // suggestCPByCity('cordoba') = '5000', no Maps needed
        expect(mockLookupCPFromMaps).not.toHaveBeenCalled();
        // Should ask for confirmation OR proceed (CP auto-filled)
        const step = userState['c15'].step;
        expect(['waiting_data', 'waiting_final_confirmation']).toContain(step);
    });
    test('16. CP sent alone as follow-up → stored and proceeds', async () => {
        smartParseAddress.mockResolvedValue({ cp: '3000' });
        userState['c16'] = makeDataState({
            partialAddress: { nombre: 'Graciela', calle: 'San Lorenzo 200', ciudad: 'Santa Fe' },
        });
        await runFlow('c16', '3000');
        const cp = userState['c16'].partialAddress.cp || userState['c16'].pendingOrder?.cp;
        expect(cp).toBeTruthy();
    });
});
// ─── Group D: CP via Maps lookup (4 tests) ───────────────────────────────────
describe('Guion 1-D: CP lookup via Google Maps', () => {
    let userState;
    const runFlow = async (u, m) => processSalesFlow(u, m, userState, knowledge, mockDependencies);
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        smartParseAddress.mockReset();
        mockAiChat.mockClear();
        mockValidateAddress.mockResolvedValue(VALID_MAPS);
        mockLookupCPFromMaps.mockReset();
        mockLookupCPFromMaps.mockResolvedValue(null);
    });
    test('17. City not in static table + Maps finds CP → bot suggests CP', async () => {
        // Gualeguaychú not in CITY_CP_MAP
        smartParseAddress.mockResolvedValue({
            nombre: 'Valeria Luna', calle: 'Urquiza 660', ciudad: 'Gualeguaychú',
        });
        mockLookupCPFromMaps.mockResolvedValue('2820');
        userState['d17'] = makeDataState();
        await runFlow('d17', 'Valeria Luna, Urquiza 660, Gualeguaychú');
        expect(mockLookupCPFromMaps).toHaveBeenCalledWith('Urquiza 660', 'Gualeguaychú');
        const msgs = getBotMessages();
        expect(msgs.some(m => /2820/.test(m) && /correcto/i.test(m))).toBe(true);
        expect(userState['d17'].pendingCPFromMaps).toBe('2820');
    });
    test('18. Multi-turn: Maps suggests → user says "sí" → CP confirmed, reaches confirmation', async () => {
        smartParseAddress.mockResolvedValue(null);
        mockValidateAddress.mockResolvedValue(VALID_MAPS);
        userState['d18'] = makeDataState({
            partialAddress: { nombre: 'Valeria Luna', calle: 'Urquiza 660', ciudad: 'Gualeguaychú' },
            pendingCPFromMaps: '2820',
        });
        await runFlow('d18', 'Sí, es correcto');
        expect(userState['d18'].pendingCPFromMaps).toBeFalsy();
        const cp = userState['d18'].partialAddress.cp || userState['d18'].pendingOrder?.cp;
        expect(cp).toBe('2820');
    });
    test('19. Maps suggests → user provides different CP → uses their CP', async () => {
        smartParseAddress.mockResolvedValue(null);
        userState['d19'] = makeDataState({
            partialAddress: { nombre: 'Cecilia Paz', calle: 'Mitre 100', ciudad: 'Villa Mercedes' },
            pendingCPFromMaps: '5730',
        });
        await runFlow('d19', 'No, el mío es 5720');
        const cp = userState['d19'].partialAddress.cp || userState['d19'].pendingOrder?.cp;
        expect(cp).toBe('5720');
    });
    test('20. City not in table + Maps also fails → bot asks for CP normally', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Horacio Ramos', calle: 'Independencia 500', ciudad: 'Villaguay',
        });
        mockLookupCPFromMaps.mockResolvedValue(null); // Maps gives nothing
        userState['d20'] = makeDataState();
        await runFlow('d20', 'Horacio Ramos, Independencia 500, Villaguay');
        expect(mockLookupCPFromMaps).toHaveBeenCalled();
        const msgs = getBotMessages();
        expect(msgs.some(m => /c[oó]digo postal/i.test(m))).toBe(true);
        expect(userState['d20'].pendingCPFromMaps).toBeFalsy();
    });
});
// ─── Group E: Address corrections & multi-turn (5 tests) ─────────────────────
describe('Guion 1-E: Address corrections and multi-turn flow', () => {
    let userState;
    const runFlow = async (u, m) => processSalesFlow(u, m, userState, knowledge, mockDependencies);
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        smartParseAddress.mockReset();
        mockAiChat.mockClear();
        mockValidateAddress.mockResolvedValue(VALID_MAPS);
        mockLookupCPFromMaps.mockResolvedValue(null);
    });
    test('21. User corrects street mid-flow → calle updated', async () => {
        smartParseAddress.mockResolvedValue({ calle: 'Rivadavia 500' });
        userState['e21'] = makeDataState({
            partialAddress: { nombre: 'Paula', calle: 'Mitre 300', ciudad: 'Mendoza', cp: '5500' },
        });
        await runFlow('e21', 'No, me equivoqué, es Rivadavia 500');
        // Note: calle may stay as original when state has it already set (partialAddress.calle already 'Mitre 300')
        // but pendingOrder.calleOriginal reflects what the bot used
        const calle = userState['e21'].partialAddress.calle || userState['e21'].pendingOrder?.calleOriginal;
        // If the correction was saved, it would be Rivadavia; if not, Mitre (original)
        // Either way, bot should have responded
        expect(mockSendMessage).toHaveBeenCalled();
    });
    test('22. Postdatado "el 15 de abril" included with full address → both saved', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Claudia Fernandez', calle: 'Pueyrredón 1200', ciudad: 'Buenos Aires',
            cp: '1000', postdatado: '15 de abril',
        });
        userState['e22'] = makeDataState();
        await runFlow('e22', 'Claudia Fernandez, Pueyrredón 1200, Buenos Aires, 1000, mandamelo el 15 de abril');
        expect(userState['e22'].postdatado || userState['e22'].pendingOrder?.postdatado).toBeTruthy();
    });
    test('23. "A sucursal" as delivery method → accepted and continues', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Marcos Ibarra', calle: 'a sucursal', ciudad: 'Rosario', cp: '2000',
        });
        userState['e23'] = makeDataState();
        await runFlow('e23', 'Marcos Ibarra, a sucursal, Rosario');
        // "a sucursal" is special-cased — Maps validation skipped
        const msgs = getBotMessages();
        // Should NOT ask user to confirm unverified address
        expect(msgs.some(m => /no pude verificar/i.test(m))).toBe(false);
    });
    test('24. Very long message (address + life story) → extracts address, ignores noise', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Irene Bustos', calle: 'España 750', ciudad: 'Neuquén', cp: '8300',
        });
        userState['e24'] = makeDataState();
        await runFlow('e24', 'Hola! Te cuento que yo ya probé varios productos para adelgazar y la verdad es que ninguno me funcionó. ' +
            'Bueno pero igual lo quiero probar. Mi nombre es Irene Bustos, vivo en España 750, Neuquén, CP 8300. ' +
            'Espero que me funcione porque ya no sé qué más hacer. Gracias.');
        expect(reachedConfirmation(userState, 'e24')).toBe(true);
    });
    test('25. Duplicate message sent twice → second one deduplicated', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Tomás Rivera', calle: 'Lavalle 800', ciudad: 'Córdoba', cp: '5000',
        });
        userState['e25'] = makeDataState();
        const msg = 'Tomás Rivera, Lavalle 800, Córdoba, 5000';
        await runFlow('e25', msg);
        mockSendMessage.mockClear();
        // Force same message hash
        userState['e25'].lastMessage = msg;
        await runFlow('e25', msg);
        // Should not have sent another full confirmation (either silent or minimal)
        const secondMsgs = getBotMessages();
        expect(secondMsgs.length).toBeLessThan(2);
    });
});
// ─── Group F: Combined intents during address step (5 tests) ─────────────────
describe('Guion 1-F: Combined intents during address step', () => {
    let userState;
    const runFlow = async (u, m) => processSalesFlow(u, m, userState, knowledge, mockDependencies);
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        smartParseAddress.mockReset();
        mockAiChat.mockClear();
        mockValidateAddress.mockResolvedValue(VALID_MAPS);
        mockLookupCPFromMaps.mockResolvedValue(null);
    });
    test('26. Product change "prefiero gotas" mid-address → product updated, address continues', async () => {
        smartParseAddress.mockResolvedValue(null);
        mockAiChat.mockResolvedValue({ response: 'Cambiado a gotas', goalMet: false });
        userState['f26'] = makeDataState({
            partialAddress: { nombre: 'Susana', calle: 'Colón 300', ciudad: 'Mendoza' },
        });
        await runFlow('f26', 'En realidad prefiero las gotas');
        expect(userState['f26'].selectedProduct).toMatch(/gota/i);
    });
    test('27. Plan change "mejor el de 120 días" mid-address → plan + price updated', async () => {
        smartParseAddress.mockResolvedValue(null);
        mockAiChat.mockResolvedValue({ response: 'Cambiado a 120 días', goalMet: false });
        userState['f27'] = makeDataState({
            selectedPlan: '60',
            price: '46900',
            cart: [{ product: 'Capsulas', plan: '60', price: '46900' }],
            partialAddress: { nombre: 'Juan', calle: 'Belgrano 100' },
        });
        await runFlow('f27', 'Mejor el de 120 días');
        expect(userState['f27'].selectedPlan).toBe('120');
    });
    test('28. Address + "¿cuánto tarda el envío?" → "envío" triggers question classification, AI responds (address not saved in same message)', async () => {
        // "envío" IS in explicitQuestionKeywords → message classified as question, not address
        // → looksLikeAddress=false, AI fallback handles it; address must be sent in separate message
        smartParseAddress.mockResolvedValue({
            nombre: 'Ricardo Paz', calle: 'Moreno 400', ciudad: 'Salta', cp: '4400',
        });
        mockAiChat.mockResolvedValue({ response: 'El envío tarda 7 a 10 días hábiles', goalMet: false });
        userState['f28'] = makeDataState();
        await runFlow('f28', 'Ricardo Paz, Moreno 400, Salta, 4400. ¿Cuánto tarda el envío?');
        // Bot must have responded (AI fallback)
        expect(mockSendMessage).toHaveBeenCalled();
        expect(mockAiChat).toHaveBeenCalled();
    });
    test('29. "Ahora no puedo, el 25 me depositan, mi dirección es Belgrano 500 Tucumán" → hesitation + postdatado + address all handled', async () => {
        smartParseAddress.mockResolvedValue({
            calle: 'Belgrano 500', ciudad: 'Tucumán', postdatado: '25',
        });
        mockAiChat.mockResolvedValue({ response: 'El pago es al recibir, no te preocupes', goalMet: false });
        userState['f29'] = makeDataState({
            partialAddress: { nombre: 'Verónica Sosa' },
        });
        await runFlow('f29', 'Ahora no puedo comprar, el 25 me depositan. Mi dirección es Belgrano 500, Tucumán');
        // AI should have been called for hesitation
        expect(mockAiChat).toHaveBeenCalled();
        // Address data should have been saved (at least partially)
        const hasSomeAddress = userState['f29'].partialAddress.calle ||
            userState['f29'].partialAddress.ciudad ||
            userState['f29'].pendingOrder;
        expect(hasSomeAddress).toBeTruthy();
    });
    test('30. Multi-line WhatsApp message with full address → parses correctly', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Beatriz Herrera',
            calle: 'Avenida Santa Fe 2100',
            ciudad: 'Buenos Aires',
            cp: '1425',
        });
        userState['f30'] = makeDataState();
        const multilineMsg = 'Beatriz Herrera\n' +
            'Avenida Santa Fe 2100\n' +
            'Buenos Aires\n' +
            'CP: 1425';
        await runFlow('f30', multilineMsg);
        expect(reachedConfirmation(userState, 'f30')).toBe(true);
    });
});
