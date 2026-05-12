/**
 * Regression tests for address-related bugs found in real conversations.
 *
 * Covers:
 * - Esquina false positives ("no es esquina", "entre X y Y" as reference)
 * - CP/ciudad data loss on esquina early return
 * - Address + question combo ("7500 codigo postal, cuanto tarda")
 * - Hesitation detection ("ahora no puedo comprar", "semana que viene")
 * - Postdatado detection ("mandamela el 25 abril")
 */

const { processSalesFlow } = require('../src/flows/salesFlow');
const fs = require('fs');
const path = require('path');

const mockSendMessage = jest.fn();
const mockNotifyAdmin = jest.fn();
const mockSaveState = jest.fn();

const smartParseAddress = jest.fn().mockResolvedValue(null);

const mockAiChat = jest.fn().mockImplementation(async (text, context) => {
    let extractedData = null; let goalMet = false;
    let response = 'AI response for step';
    if (/\b(60|120|180|240)\b/.test(text)) {
        const m = text.match(/\b(60|120|180|240)\b/);
        if (m) extractedData = m[1];
        goalMet = true;
    } else if (/gotas|semilla/i.test(text)) {
        extractedData = 'CHANGE_PRODUCT: ' + (/gotas/i.test(text) ? 'Gotas' : 'Semillas');
    }
    return { response, goalMet, extractedData };
});

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
        parseAddress: smartParseAddress
    }
};

const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '../archive/knowledge_v3.json'), 'utf8'));

jest.mock('../src/services/ai', () => ({ aiService: mockDependencies.aiService }));
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }), { virtual: true });
jest.mock('../sheets_sync', () => ({ appendOrderToSheet: jest.fn() }), { virtual: true });
jest.mock('google-spreadsheet', () => ({}), { virtual: true });
jest.mock('@google/generative-ai', () => ({}), { virtual: true });

// Mock lookupCPFromMaps (Google Maps geocoding for CP)
const mockLookupCPFromMaps = jest.fn().mockResolvedValue(null);
jest.mock('../src/services/addressValidator', () => {
    const actual = jest.requireActual('../src/services/addressValidator');
    return {
        ...actual,
        lookupCPFromMaps: (...args) => mockLookupCPFromMaps(...args)
    };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
        ...overrides
    };
}

function getBotMessages() {
    return mockSendMessage.mock.calls.map(c => c[1]);
}

function hasEsquinaWarning() {
    return getBotMessages().some(m => /Correo Argentino no nos permite enviar a esquinas/i.test(m));
}

function hasAddressRequest() {
    return getBotMessages().some(m => /nombre.*apellido|direcci[oó]n.*calle|calle.*n[uú]mero|pasame.*datos/i.test(m));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Esquina false positives (5 tests)', () => {
    let userState;
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        mockNotifyAdmin.mockClear();
        smartParseAddress.mockReset();
        mockAiChat.mockClear();
    });

    const runFlow = async (u, m) => await processSalesFlow(u, m, userState, knowledge, mockDependencies);

    test('1. "no es esquina" — should accept address, reach confirmation', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Maria Cristina Rodriguez', calle: 'Rauch 1058',
            ciudad: 'Tres Arroyos', cp: '7500'
        });
        userState['u1'] = makeDataState();
        await runFlow('u1', 'Maria Cristina Rodriguez .la calle no es esquina .Mi casa tiene el numero.afuera . RAUCH 1058 Localidad Tres Arroyos .Codigo postal 7500');

        expect(hasEsquinaWarning()).toBe(false);
        // Address complete → should advance to final confirmation
        expect(userState['u1'].step).toBe('waiting_final_confirmation');
        expect(userState['u1'].pendingOrder.calle).toContain('Rauch');
    });

    test('2. "entre X y Y" as reference — should accept address', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Graciela Mendoza', calle: 'Nicaragua 2075',
            ciudad: 'Rosario', cp: '2000'
        });
        userState['u2'] = makeDataState();
        await runFlow('u2', 'Nombre es Graciela Mendoza, Nicaragua 2075. Rosario, codigo postal 2000. Estoy entre Ituzango y Cerrito por Nicaragua.');

        expect(hasEsquinaWarning()).toBe(false);
        expect(userState['u2'].step).toBe('waiting_final_confirmation');
    });

    test('3. "mitad de cuadra" — should accept address', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Ana Lopez', calle: 'Belgrano 450',
            ciudad: 'Cordoba', cp: '5000'
        });
        userState['u3'] = makeDataState();
        await runFlow('u3', 'Ana Lopez, Belgrano 450, es mitad de cuadra, Cordoba, CP 5000');

        expect(hasEsquinaWarning()).toBe(false);
        expect(userState['u3'].step).toBe('waiting_final_confirmation');
    });

    test('4. Real esquina "esq Callao" in parsed calle — SHOULD trigger warning', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Roberto', calle: 'Av Santa Fe esq Callao',
            ciudad: 'CABA', cp: '1425'
        });
        userState['u4'] = makeDataState();
        await runFlow('u4', 'Roberto, Av Santa Fe esq Callao, CABA, 1425');

        expect(hasEsquinaWarning()).toBe(true);
        expect(userState['u4'].addressIssueType).toBe('intersection');
        // But nombre/ciudad/cp should still be saved
        expect(userState['u4'].partialAddress.nombre).toBe('Roberto');
        expect(userState['u4'].partialAddress.ciudad).toBe('CABA');
        expect(userState['u4'].partialAddress.cp).toBe('1425');
    });

    test('5. "ni esquina ni nada" — should accept address', async () => {
        smartParseAddress.mockResolvedValue({
            calle: 'Mitre 300', ciudad: 'Salta', cp: '4400'
        });
        userState['u5'] = makeDataState({ partialAddress: { nombre: 'Laura' } });
        await runFlow('u5', 'Mitre 300, no es ni esquina ni nada, Salta 4400');

        expect(hasEsquinaWarning()).toBe(false);
        expect(userState['u5'].step).toBe('waiting_final_confirmation');
    });
});


describe('Data loss on esquina/early return (3 tests)', () => {
    let userState;
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        smartParseAddress.mockReset();
    });

    const runFlow = async (u, m) => await processSalesFlow(u, m, userState, knowledge, mockDependencies);

    test('6. CP and ciudad saved even when calle has no_number issue', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Juana Perez', calle: 'Rivadavia',
            ciudad: 'Mendoza', cp: '5500'
        });
        userState['u6'] = makeDataState();
        await runFlow('u6', 'Juana Perez, Rivadavia, Mendoza, 5500');

        // Calle has no number so bot asks for it, but other fields are saved
        expect(userState['u6'].partialAddress.nombre).toBe('Juana Perez');
        expect(userState['u6'].partialAddress.ciudad).toBe('Mendoza');
        expect(userState['u6'].partialAddress.cp).toBe('5500');
        expect(userState['u6'].partialAddress.calle).toBeUndefined();
    });

    test('7. After address issue, corrected address reaches confirmation', async () => {
        // First attempt: calle with no number triggers no_number issue
        smartParseAddress.mockResolvedValueOnce({
            nombre: 'Roberto Silva', calle: 'Santa Fe',
            ciudad: 'CABA', cp: '1425'
        });
        userState['u8'] = makeDataState();
        await runFlow('u8', 'Roberto Silva, Santa Fe, CABA, 1425');

        expect(userState['u8'].addressIssueType).toBe('no_number');
        expect(userState['u8'].partialAddress.cp).toBe('1425');

        // Second attempt: corrected
        smartParseAddress.mockResolvedValueOnce({ calle: 'Av Santa Fe 1234' });
        mockSendMessage.mockClear();
        await runFlow('u8', 'Av Santa Fe 1234');

        expect(userState['u8'].step).toBe('waiting_final_confirmation');
    });

    test('8. Nombre saved from first message even if esquina triggers', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Maria Garcia', calle: 'entre Mitre y Belgrano',
            ciudad: 'Rosario', cp: '2000'
        });
        userState['u'] = makeDataState();
        await runFlow('u', 'Maria Garcia, entre Mitre y Belgrano, Rosario, 2000');

        expect(userState['u'].partialAddress.nombre).toBe('Maria Garcia');
        expect(userState['u'].partialAddress.ciudad).toBe('Rosario');
        expect(userState['u'].partialAddress.cp).toBe('2000');
    });
});


describe('Address + question combo (4 tests)', () => {
    let userState;
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        smartParseAddress.mockReset();
        mockAiChat.mockClear();
    });

    const runFlow = async (u, m) => await processSalesFlow(u, m, userState, knowledge, mockDependencies);

    test('9. "7500 Codigo postal, cuanto tarda" — CP saved, reaches confirmation', async () => {
        smartParseAddress.mockResolvedValue({ cp: '7500' });
        userState['u9'] = makeDataState({
            partialAddress: { nombre: 'Maria', calle: 'Rauch 1058', ciudad: 'Tres Arroyos' }
        });
        await runFlow('u9', '7500 Codigo postal .tenes idea cuanto tarda .como es feriado estos dias .gracias');

        // CP should be saved — either still in partialAddress or already in pendingOrder
        const cp = userState['u9'].partialAddress?.cp || userState['u9'].pendingOrder?.cp;
        expect(cp).toBeTruthy();
    });

    test('10. "Calle Belgrano 350, Rosario, cuanto sale el envio?" — address saved', async () => {
        smartParseAddress.mockResolvedValue({
            calle: 'Belgrano 350', ciudad: 'Rosario'
        });
        userState['u10'] = makeDataState({ partialAddress: { nombre: 'Laura' } });
        await runFlow('u10', 'Calle Belgrano 350, Rosario, cuanto sale el envio?');

        const calle = userState['u10'].partialAddress?.calle || userState['u10'].pendingOrder?.calle;
        expect(calle).toBeTruthy();
    });

    test('11. "Codigo postal 5000, es seguro?" — CP saved despite question', async () => {
        smartParseAddress.mockResolvedValue({ cp: '5000' });
        userState['u11'] = makeDataState({
            partialAddress: { nombre: 'Marta', calle: 'San Martin 100', ciudad: 'Cordoba' }
        });
        await runFlow('u11', 'Codigo postal 5000, es seguro el producto?');

        const cp = userState['u11'].partialAddress?.cp || userState['u11'].pendingOrder?.cp;
        expect(cp).toBeTruthy();
    });

    test('12. Full address + "cuando me llega?" — reaches confirmation', async () => {
        smartParseAddress.mockResolvedValue({
            nombre: 'Carlos Ruiz', calle: 'Mitre 789',
            ciudad: 'Tucuman', cp: '4000'
        });
        userState['u12'] = makeDataState();
        await runFlow('u12', 'Carlos Ruiz, calle Mitre 789, Tucuman, codigo postal 4000. Cuando me llega?');

        const step = userState['u12'].step;
        const hasPending = !!userState['u12'].pendingOrder;
        // Should process the address even though there's a question
        expect(step === 'waiting_final_confirmation' || hasPending).toBe(true);
    });
});


describe('Hesitation detection (4 tests)', () => {
    let userState;
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        smartParseAddress.mockReset();
        mockAiChat.mockClear();
    });

    const runFlow = async (u, m) => await processSalesFlow(u, m, userState, knowledge, mockDependencies);

    test('13. "La semana que viene, ahora no puedo comprar" — NOT treated as address', async () => {
        smartParseAddress.mockResolvedValue(null);
        userState['u13'] = makeDataState();
        await runFlow('u13', 'La semana que viene, ahora no puedo comprar');

        const msgs = getBotMessages();
        // Should NOT ask for nombre/direccion directly
        const pureAddressAsk = msgs.find(m =>
            /pasame.*nombre|nombre.*apellido/i.test(m) &&
            !/pago|recibir|envío|tarda|postdat|congel/i.test(m)
        );
        expect(pureAddressAsk).toBeUndefined();
        // AI should have been called for fallback
        expect(mockAiChat).toHaveBeenCalled();
    });

    test('14. "No tengo plata ahora" — treated as hesitation', async () => {
        smartParseAddress.mockResolvedValue(null);
        userState['u14'] = makeDataState();
        await runFlow('u14', 'No tengo la plata ahora');

        expect(mockAiChat).toHaveBeenCalled();
    });

    test('15. "No me alcanza, el mes que viene" — treated as hesitation', async () => {
        smartParseAddress.mockResolvedValue(null);
        userState['u15'] = makeDataState();
        await runFlow('u15', 'No me alcanza, el mes que viene te escribo');

        expect(mockAiChat).toHaveBeenCalled();
    });

    test('16. "Ok" — should ask for address data, NOT hesitation', async () => {
        smartParseAddress.mockResolvedValue(null);
        userState['u16'] = makeDataState();
        await runFlow('u16', 'Ok');

        const msgs = getBotMessages();
        const addressAsk = msgs.find(m => /nombre|direcci[oó]n|calle|datos/i.test(m));
        expect(addressAsk).toBeDefined();
    });
});


describe('Postdatado detection (4 tests)', () => {
    let userState;
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        smartParseAddress.mockReset();
        mockAiChat.mockClear();
    });

    const runFlow = async (u, m) => await processSalesFlow(u, m, userState, knowledge, mockDependencies);

    test('17. "Mejor mandamela el 25 abril" — postdatado saved', async () => {
        smartParseAddress.mockResolvedValue({ postdatado: '25 abril' });
        userState['u17'] = makeDataState({
            partialAddress: { nombre: 'Graciela', calle: 'Nicaragua 2075', ciudad: 'Rosario', cp: '2000' }
        });
        await runFlow('u17', 'Mejor mandamela el 25 abril');

        // Postdatado should be on the state
        expect(userState['u17'].postdatado).toBeTruthy();
    });

    test('18. "Enviamelo para el 10 de mayo" — postdatado saved', async () => {
        smartParseAddress.mockResolvedValue({ postdatado: '10 de mayo' });
        userState['u18'] = makeDataState({
            partialAddress: { nombre: 'Luis', calle: 'Mitre 100', ciudad: 'Salta', cp: '4400' }
        });
        await runFlow('u18', 'Enviamelo para el 10 de mayo por favor');

        expect(userState['u18'].postdatado).toBeTruthy();
    });

    test('19. "Ahora no puedo, mandamela la semana que viene" — hesitation handled with empathy', async () => {
        smartParseAddress.mockResolvedValue({ postdatado: 'semana que viene' });
        userState['u19'] = makeDataState({
            partialAddress: { nombre: 'Rosa', calle: 'San Martin 500', ciudad: 'Cordoba', cp: '5000' }
        });
        await runFlow('u19', 'Ahora no puedo, mandamela la semana que viene');

        // Should be handled as hesitation by AI fallback (not ignored as address)
        expect(mockAiChat).toHaveBeenCalled();
        // Should NOT be treated as a pure address request
        const msgs = getBotMessages();
        const pureAddressAsk = msgs.find(m =>
            /nombre.*apellido/i.test(m) && !/pago|recibir|envío|postdat|congel/i.test(m)
        );
        expect(pureAddressAsk).toBeUndefined();
    });

    test('20. "Mandamelo mañana" — NOT postdatado (wants sooner)', async () => {
        smartParseAddress.mockResolvedValue(null);
        userState['u20'] = makeDataState({
            partialAddress: { nombre: 'Pedro', calle: 'Rivadavia 200', ciudad: 'CABA', cp: '1000' }
        });
        await runFlow('u20', 'Mandamelo mañana');

        expect(userState['u20'].postdatado).toBeFalsy();
    });
});

// ─── CP Lookup via Google Maps (5 tests) ─────────────────────────────────────

describe('CP lookup from Google Maps when client doesnt know CP (5 tests)', () => {
    let userState;
    const runFlow = async (u, m) => await processSalesFlow(u, m, userState, knowledge, mockDependencies);
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        mockNotifyAdmin.mockClear();
        smartParseAddress.mockReset();
        mockAiChat.mockClear();
        mockLookupCPFromMaps.mockReset();
        mockLookupCPFromMaps.mockResolvedValue(null);
    });

    test('21. Address without CP — Maps finds CP, bot asks for confirmation', async () => {
        // Use "Gualeguaychu" — NOT in the static CITY_CP_MAP table, so Maps lookup triggers
        smartParseAddress.mockResolvedValue({ nombre: 'Juan Perez', calle: 'Mendoza 99', ciudad: 'Gualeguaychu' });
        mockLookupCPFromMaps.mockResolvedValue('2820');
        userState['u21'] = makeDataState();
        await runFlow('u21', 'Juan Perez, Mendoza 99, Gualeguaychu');

        // Should have called lookupCPFromMaps with calle + ciudad
        expect(mockLookupCPFromMaps).toHaveBeenCalledWith('Mendoza 99', 'Gualeguaychu');

        // Bot should ask for CP confirmation
        const msgs = getBotMessages();
        expect(msgs.some(m => /2820/.test(m) && /correcto/i.test(m))).toBe(true);

        // CP should NOT be set yet (pending confirmation)
        expect(userState['u21'].partialAddress.cp).toBeFalsy();
        // pendingCPFromMaps should be stored
        expect(userState['u21'].pendingCPFromMaps).toBe('2820');
    });

    test('22. User confirms suggested CP — CP is saved and order proceeds', async () => {
        smartParseAddress.mockResolvedValue(null);
        userState['u22'] = makeDataState({
            partialAddress: { nombre: 'Juan Perez', calle: 'Mendoza 99', ciudad: 'Rosario' },
            pendingCPFromMaps: '2000'
        });
        await runFlow('u22', 'Si, es correcto');

        // CP should now be set
        expect(userState['u22'].partialAddress.cp || userState['u22'].pendingOrder?.cp).toBeTruthy();
        // pendingCPFromMaps should be cleared
        expect(userState['u22'].pendingCPFromMaps).toBeFalsy();
    });

    test('23. User says no to suggested CP — bot asks for real CP', async () => {
        smartParseAddress.mockResolvedValue(null);
        userState['u23'] = makeDataState({
            partialAddress: { nombre: 'Maria', calle: 'Colon 500', ciudad: 'Trelew' },
            pendingCPFromMaps: '9100'
        });
        await runFlow('u23', 'No, ese no es');

        const msgs = getBotMessages();
        expect(msgs.some(m => /c[oó]digo postal/i.test(m))).toBe(true);
        // pendingCPFromMaps should be cleared
        expect(userState['u23'].pendingCPFromMaps).toBeFalsy();
        // CP should not be set
        expect(userState['u23'].partialAddress.cp).toBeFalsy();
    });

    test('24. User provides their own CP instead of confirming — uses their CP', async () => {
        smartParseAddress.mockResolvedValue(null);
        userState['u24'] = makeDataState({
            partialAddress: { nombre: 'Luis', calle: 'San Martin 300', ciudad: 'Cipolletti' },
            pendingCPFromMaps: '8324'
        });
        await runFlow('u24', 'No, es 8325');

        // Should use the user-provided CP, not the suggested one
        const cp = userState['u24'].partialAddress.cp || userState['u24'].pendingOrder?.cp;
        expect(cp).toBe('8325');
        expect(userState['u24'].pendingCPFromMaps).toBeFalsy();
    });

    test('25. Maps returns no CP — falls through to ask normally', async () => {
        // Use "Villa Elisa" — NOT in static CITY_CP_MAP, so Maps lookup triggers
        smartParseAddress.mockResolvedValue({ nombre: 'Ana Lopez', calle: 'Ruta 3 km 5', ciudad: 'Villa Elisa' });
        mockLookupCPFromMaps.mockResolvedValue(null);
        userState['u25'] = makeDataState();
        await runFlow('u25', 'Ana Lopez, Ruta 3 km 5, Villa Elisa');

        // Should have tried Maps but got nothing
        expect(mockLookupCPFromMaps).toHaveBeenCalled();

        // Bot should ask for CP the normal way (missing field)
        const msgs = getBotMessages();
        const asksCp = msgs.some(m => /c[oó]digo postal|cp/i.test(m));
        expect(asksCp).toBe(true);

        // No pending CP
        expect(userState['u25'].pendingCPFromMaps).toBeFalsy();
    });
});
