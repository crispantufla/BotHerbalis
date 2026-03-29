/**
 * Guion 3 — Multi-unit ordering, cancellation confirmation, non-Argentina rejection
 *
 * Covers:
 * A. Multi-unit ordering: 2, 3, N cajas / units / días
 * B. 50% discount on cheapest unit when 3+ units
 * C. adicionalMAX rules (total plan days < 120)
 * D. buildMultiProductCart for mixed products
 * E. Cancellation confirmation flow (ask before pausing)
 * F. Non-Argentina address rejection
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
const VALID_MAPS = {
    cpValid: true, cpCleaned: null, province: 'Buenos Aires',
    mapsValid: true, mapsFormatted: 'Calle Test 123, Buenos Aires, Argentina', warnings: [],
};
const NON_ARGENTINA_MAPS = {
    cpValid: false, cpCleaned: null, province: null,
    mapsValid: false, mapsFormatted: null,
    warnings: ['📍 La dirección no parece estar en Argentina'],
    notArgentina: true,
};
function makeDataState(overrides = {}) {
    return {
        step: 'waiting_data',
        selectedProduct: 'Cápsulas de nuez de la india',
        selectedPlan: '60',
        isContraReembolsoMAX: true,
        adicionalMAX: 6000,
        price: '46900',
        cart: [{ product: 'Cápsulas de nuez de la india', plan: '60', price: '46.900' }],
        partialAddress: {},
        history: [],
        addressAttempts: 0,
        ...overrides,
    };
}
function makeCompleteState(overrides = {}) {
    return makeDataState({
        partialAddress: { nombre: 'Test User', calle: 'Belgrano 500', ciudad: 'Rosario', cp: '2000' },
        ...overrides,
    });
}
function getBotMessages() {
    return mockSendMessage.mock.calls.map(c => c[1]);
}
// ─── Group A: Multi-unit ordering ─────────────────────────────────────────────
describe('Group A: Multi-unit ordering (6 tests)', () => {
    let userState;
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        mockNotifyAdmin.mockClear();
        smartParseAddress.mockReset().mockResolvedValue(null);
        mockAiChat.mockClear().mockResolvedValue({ response: 'AI response', goalMet: false });
        mockValidateAddress.mockResolvedValue(VALID_MAPS);
        mockLookupCPFromMaps.mockResolvedValue(null);
    });
    const run = async (u, m) => await processSalesFlow(u, m, userState, knowledge, mockDependencies);
    test('1. "quiero 3 cajas" → plan 180, discount applied, bot confirms 3 unidades', async () => {
        userState['u1'] = makeDataState();
        await run('u1', 'En realidad quiero 3 cajas');
        const state = userState['u1'];
        expect(state.selectedPlan).toBe('180');
        expect(state.cart[0].plan).toBe('180');
        // Price should have 50% discount on cheapest unit applied (base60 * 0.5 deducted)
        const cartPrice = parseInt(state.cart[0].price.replace(/\./g, ''), 10);
        // 3 units: 1 pair (120 = 66900) + 1 remainder (60 = 46900) - discount (46900*0.5 = 23450)
        // = 66900 + 46900 - 23450 = 90350
        expect(cartPrice).toBe(90350);
        expect(getBotMessages().some(m => /3 unidades|180 d[ií]as|descuento/i.test(m))).toBe(true);
    });
    test('2. "2 cajas" → plan 120, no discount (only 2 units), no adicionalMAX', async () => {
        userState['u2'] = makeDataState();
        await run('u2', 'Mejor quiero 2 cajas');
        const state = userState['u2'];
        expect(state.selectedPlan).toBe('120');
        // 2 units: 1 pair * base120 = 66900, no discount
        const cartPrice = parseInt(state.cart[0].price.replace(/\./g, ''), 10);
        expect(cartPrice).toBe(66900);
        // 2 units (120 days total) → no adicionalMAX
        expect(state.isContraReembolsoMAX).toBe(false);
        expect(state.adicionalMAX).toBe(0);
    });
    test('3. "4 cajas de capsulas" → plan 240, discount on 1 cheapest unit', async () => {
        userState['u3'] = makeDataState();
        await run('u3', 'Quiero 4 cajas de capsulas');
        const state = userState['u3'];
        expect(state.selectedPlan).toBe('240');
        const cartPrice = parseInt(state.cart[0].price.replace(/\./g, ''), 10);
        // 4 units: 2 pairs * 66900 = 133800, discount = 46900 * 0.5 = 23450
        // = 133800 - 23450 = 110350
        expect(cartPrice).toBe(110350);
        expect(state.isContraReembolsoMAX).toBe(false);
    });
    test('4. "tres cajas" (word number) → plan 180', async () => {
        userState['u4'] = makeDataState();
        await run('u4', 'Quiero tres cajas por favor');
        const state = userState['u4'];
        expect(state.selectedPlan).toBe('180');
    });
    test('5. "180 días" → plan 180 with discount', async () => {
        userState['u5'] = makeDataState();
        await run('u5', 'Me quedo con 180 días mejor');
        const state = userState['u5'];
        expect(state.selectedPlan).toBe('180');
        const cartPrice = parseInt(state.cart[0].price.replace(/\./g, ''), 10);
        expect(cartPrice).toBe(90350);
    });
    test('6. Single "60 días" → plan stays 60, adicionalMAX still applies', async () => {
        userState['u6'] = makeDataState();
        await run('u6', 'En realidad me quedo con el de 60 días nomás');
        const state = userState['u6'];
        expect(state.selectedPlan).toBe('60');
        expect(state.isContraReembolsoMAX).toBe(true);
        expect(state.adicionalMAX).toBeGreaterThan(0);
    });
});
// ─── Group B: buildCartFromSelection discount and adicionalMAX unit tests ─────
describe('Group B: Cart helpers — discount and adicionalMAX unit tests (5 tests)', () => {
    const { buildCartFromSelection, buildMultiProductCart, calculateTotal, _recalcAdicionalMAX } = require('../src/flows/utils/cartHelpers');
    function makeEmptyState() {
        return { cart: [], selectedProduct: null, selectedPlan: null, isContraReembolsoMAX: false, adicionalMAX: 0, totalPrice: null };
    }
    test('7. plan=60 → adicionalMAX applies (total 60 days < 120)', () => {
        const state = makeEmptyState();
        buildCartFromSelection('Cápsulas de nuez de la india', '60', state);
        expect(state.isContraReembolsoMAX).toBe(true);
        expect(state.adicionalMAX).toBeGreaterThan(0);
    });
    test('8. plan=120 → no adicionalMAX (total 120 days = 120)', () => {
        const state = makeEmptyState();
        buildCartFromSelection('Cápsulas de nuez de la india', '120', state);
        expect(state.isContraReembolsoMAX).toBe(false);
        expect(state.adicionalMAX).toBe(0);
    });
    test('9. plan=180 → no adicionalMAX, price has 50% discount applied', () => {
        const state = makeEmptyState();
        buildCartFromSelection('Cápsulas de nuez de la india', '180', state);
        expect(state.isContraReembolsoMAX).toBe(false);
        expect(state.adicionalMAX).toBe(0);
        const price = parseInt(state.cart[0].price.replace(/\./g, ''), 10);
        // 66900 + 46900 - 23450 = 90350
        expect(price).toBe(90350);
    });
    test('10. buildMultiProductCart: 1 capsulas + 1 gotas → total 120 days → no adicionalMAX', () => {
        const state = makeEmptyState();
        buildMultiProductCart([
            { product: 'Cápsulas de nuez de la india', units: 1 },
            { product: 'Gotas de nuez de la india', units: 1 },
        ], state);
        expect(state.cart.length).toBe(2);
        // Total plan days = 60 + 60 = 120 → no adicionalMAX
        expect(state.isContraReembolsoMAX).toBe(false);
        expect(state.adicionalMAX).toBe(0);
    });
    test('11. buildMultiProductCart: 2 capsulas + 1 gotas → 3 units → 50% discount on cheapest', () => {
        const state = makeEmptyState();
        buildMultiProductCart([
            { product: 'Cápsulas de nuez de la india', units: 2 },
            { product: 'Gotas de nuez de la india', units: 1 },
        ], state);
        // Capsulas: 2 units = 1 pair = 66900, no discount on this item
        // Gotas: 1 unit = 48900, BUT gotas is more expensive per unit than capsulas
        // Cheapest unit is capsulas at 46900 → discount = 23450 applied to capsulas subtotal
        // Capsulas subtotal: 66900 - 23450 = 43450
        // Gotas subtotal: 48900
        // Total: 43450 + 48900 = 92350
        const totalCart = state.cart.reduce((sum, item) => {
            return sum + parseInt(item.price.replace(/\./g, ''), 10);
        }, 0);
        calculateTotal(state);
        // Verify the discount was applied (total should be less than without discount)
        // Without discount: 66900 + 48900 = 115800
        expect(totalCart).toBeLessThan(115800);
        expect(state.isContraReembolsoMAX).toBe(false);
    });
});
// ─── Group C: Cancellation confirmation flow (6 tests) ────────────────────────
describe('Group C: Cancellation confirmation flow (6 tests)', () => {
    let userState;
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        mockNotifyAdmin.mockClear();
        smartParseAddress.mockReset().mockResolvedValue(null);
        mockAiChat.mockClear().mockResolvedValue({ response: 'AI response', goalMet: false });
        mockValidateAddress.mockResolvedValue(VALID_MAPS);
    });
    const run = async (u, m) => await processSalesFlow(u, m, userState, knowledge, mockDependencies);
    test('12. "ya no quiero" → bot asks for confirmation, does NOT pause immediately', async () => {
        userState['c1'] = makeCompleteState();
        await run('c1', 'ya no quiero el pedido');
        const msgs = getBotMessages();
        // Should ask for confirmation
        expect(msgs.some(m => /seguro|confirmar|cancelar|sí o no/i.test(m))).toBe(true);
        // Should NOT be paused yet
        expect(mockDependencies.sharedState.pausedUsers.has('c1')).toBe(false);
        expect(userState['c1'].pendingCancelConfirm).toBe(true);
    });
    test('13. "cancelar" → confirmation asked → "sí" → paused', async () => {
        userState['c2'] = makeCompleteState();
        await run('c2', 'cancelar el pedido');
        // Should have pendingCancelConfirm set
        expect(userState['c2'].pendingCancelConfirm).toBe(true);
        mockSendMessage.mockClear();
        mockNotifyAdmin.mockClear();
        // Now user confirms
        await run('c2', 'sí, cancelalo');
        expect(userState['c2'].pendingCancelConfirm).toBe(false);
        // Should be paused now
        expect(mockDependencies.sharedState.pausedUsers.size).toBeGreaterThan(0);
    });
    test('14. "cancelar" → confirmation asked → "no" → flow continues', async () => {
        userState['c3'] = makeCompleteState();
        await run('c3', 'cancelar');
        expect(userState['c3'].pendingCancelConfirm).toBe(true);
        mockSendMessage.mockClear();
        // User says no (standalone "no")
        await run('c3', 'no');
        expect(userState['c3'].pendingCancelConfirm).toBe(false);
        // Not paused
        expect(mockDependencies.sharedState.pausedUsers.has('c3')).toBe(false);
        expect(getBotMessages().some(m => /seguimos|qué bien|seguir|continuar/i.test(m))).toBe(true);
    });
    test('15. Ambiguous reply to cancel confirmation → asks again', async () => {
        userState['c4'] = makeDataState();
        // Put in pending cancel confirm state directly
        userState['c4'].pendingCancelConfirm = true;
        await run('c4', 'no sé todavía');
        expect(userState['c4'].pendingCancelConfirm).toBe(true); // still waiting
        // Message asks again — check for sí/si or cancel-related wording
        expect(getBotMessages().some(m => /cancelar|seg[uú]ro|responde/i.test(m))).toBe(true);
    });
    test('16. "me arrepenti" → bot asks confirmation (not immediate pause)', async () => {
        userState['c5'] = makeDataState();
        await run('c5', 'me arrepenti ya no quiero');
        expect(userState['c5'].pendingCancelConfirm).toBe(true);
        // Not paused yet
        expect(mockDependencies.sharedState.pausedUsers.has('c5')).toBe(false);
    });
    test('17. "cancelar" in greeting step → confirmation asked', async () => {
        userState['c6'] = { step: 'greeting', history: [], partialAddress: {}, cart: [], summary: '' };
        await run('c6', 'quiero cancelar todo');
        // Should ask confirmation (not just blindly pause)
        expect(mockDependencies.sharedState.pausedUsers.has('c6')).toBe(false);
        expect(userState['c6'].pendingCancelConfirm).toBe(true);
    });
});
// ─── Group D: Non-Argentina address rejection (5 tests) ───────────────────────
describe('Group D: Non-Argentina address rejection (5 tests)', () => {
    let userState;
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        mockNotifyAdmin.mockClear();
        smartParseAddress.mockReset().mockResolvedValue(null);
        mockAiChat.mockClear().mockResolvedValue({ response: 'AI response', goalMet: false });
        mockValidateAddress.mockResolvedValue(VALID_MAPS);
        mockLookupCPFromMaps.mockResolvedValue(null);
    });
    const run = async (u, m) => await processSalesFlow(u, m, userState, knowledge, mockDependencies);
    test('18. Non-Argentina address → bot says solo Argentina, clears address', async () => {
        mockValidateAddress.mockResolvedValue(NON_ARGENTINA_MAPS);
        smartParseAddress.mockResolvedValue({
            nombre: 'Juan Gomez', calle: 'Calle Falsa 123', ciudad: 'Madrid', cp: '28001'
        });
        userState['g1'] = makeDataState();
        await run('g1', 'Juan Gomez, Calle Falsa 123, Madrid, CP 28001');
        const msgs = getBotMessages();
        expect(msgs.some(m => /argentina|solo enviamos|dentro de argentina/i.test(m))).toBe(true);
        // Address should be cleared
        expect(userState['g1'].partialAddress?.calle).toBeFalsy();
        // Step stays at waiting_data (not completed)
        expect(userState['g1'].step).toBe('waiting_data');
    });
    test('19. Non-Argentina via GEO_REGEX (outside waiting_data) → global handler rejects', async () => {
        userState['g2'] = { step: 'waiting_preference', history: [], partialAddress: {}, cart: [], summary: '' };
        await run('g2', 'vivo en Chile');
        const msgs = getBotMessages();
        expect(msgs.some(m => /argentina|envios dentro/i.test(m))).toBe(true);
    });
    test('20. Argentina address → normal flow proceeds', async () => {
        mockValidateAddress.mockResolvedValue(VALID_MAPS);
        smartParseAddress.mockResolvedValue({
            nombre: 'Carlos Perez', calle: 'Rivadavia 1000', ciudad: 'Buenos Aires', cp: '1000'
        });
        userState['g3'] = makeDataState();
        await run('g3', 'Carlos Perez, Rivadavia 1000, Buenos Aires, CP 1000');
        // Should advance to final confirmation, not show non-Argentina message
        expect(userState['g3'].step).toBe('waiting_final_confirmation');
        expect(getBotMessages().some(m => /solo enviamos|argentina/i.test(m))).toBe(false);
    });
    test('21. After non-Argentina rejection, user provides Argentina address → proceeds', async () => {
        mockValidateAddress.mockResolvedValueOnce(NON_ARGENTINA_MAPS);
        smartParseAddress.mockResolvedValueOnce({
            nombre: 'Ana Torres', calle: 'Av España 450', ciudad: 'Madrid', cp: '28014'
        });
        userState['g4'] = makeDataState();
        await run('g4', 'Ana Torres, Av España 450, Madrid');
        // Address rejected (non-Argentina), address cleared
        expect(userState['g4'].partialAddress?.calle).toBeFalsy();
        // Now user gives Argentina address
        mockValidateAddress.mockResolvedValue(VALID_MAPS);
        smartParseAddress.mockResolvedValue({
            nombre: 'Ana Torres', calle: 'San Martín 800', ciudad: 'Rosario', cp: '2000'
        });
        mockSendMessage.mockClear();
        await run('g4', 'Ana Torres, San Martín 800, Rosario, 2000');
        expect(userState['g4'].step).toBe('waiting_final_confirmation');
    });
    test('22. Non-Argentina with Maps API returning notArgentina: true explicitly', async () => {
        // Simulate a case where address looks Argentinian by name but Maps says no
        mockValidateAddress.mockResolvedValue({
            cpValid: true, cpCleaned: '1234', province: null, // cpValid=true so CP check doesn't interfere
            mapsValid: false, mapsFormatted: null,
            warnings: ['📍 La dirección no parece estar en Argentina'],
            notArgentina: true,
        });
        smartParseAddress.mockResolvedValue({
            nombre: 'Test User', calle: 'Rivadavia 123', ciudad: 'Montevideo', cp: '1234'
        });
        userState['g5'] = makeDataState();
        await run('g5', 'Test User, Rivadavia 123, Montevideo, CP 1234');
        const msgs = getBotMessages();
        expect(msgs.some(m => /argentina|solo enviamos/i.test(m))).toBe(true);
    });
});
// ─── Group E: Multi-unit + address integration (3 tests) ──────────────────────
describe('Group E: Multi-unit ordering integration (3 tests)', () => {
    let userState;
    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        mockNotifyAdmin.mockClear();
        smartParseAddress.mockReset().mockResolvedValue(null);
        mockAiChat.mockClear().mockResolvedValue({ response: 'AI response', goalMet: false });
        mockValidateAddress.mockResolvedValue(VALID_MAPS);
        mockLookupCPFromMaps.mockResolvedValue(null);
    });
    const run = async (u, m) => await processSalesFlow(u, m, userState, knowledge, mockDependencies);
    test('23. "3 cajas" then full address → reaches confirmation with plan 180', async () => {
        // smartParseAddress returns null for the plan-change message (no address data)
        // Only returns address data when user sends the actual address
        userState['e1'] = makeDataState();
        // First: change to 3 cajas — parseAddress returns null (no digits are address here)
        await run('e1', 'Quiero tres cajas en realidad');
        expect(userState['e1'].selectedPlan).toBe('180');
        mockSendMessage.mockClear();
        // Now set up address mock for the address step
        smartParseAddress.mockResolvedValue({
            nombre: 'Laura Fernandez', calle: 'Mitre 750',
            ciudad: 'Córdoba', cp: '5000'
        });
        // Then: send address
        await run('e1', 'Laura Fernandez, Mitre 750, Córdoba, CP 5000');
        expect(userState['e1'].step).toBe('waiting_final_confirmation');
        expect(userState['e1'].pendingOrder).toBeTruthy();
        // Plan in confirmation message should show 180 días
        const msgs = getBotMessages();
        expect(msgs.some(m => /180/i.test(m))).toBe(true);
    });
    test('24. "2 cajas de capsulas" → cart updated, bot mentions 2 unidades (120 días)', async () => {
        userState['e2'] = makeDataState();
        await run('e2', 'Quiero 2 cajas de capsulas');
        const state = userState['e2'];
        expect(state.selectedPlan).toBe('120');
        // Should mention 2 units or 120 días in bot response
        expect(getBotMessages().some(m => /120 d[ií]as|2 unidades/i.test(m))).toBe(true);
    });
    test('25. "dos unidades" (word number) → plan 120', async () => {
        userState['e3'] = makeDataState();
        await run('e3', 'Mejor quiero dos unidades');
        expect(userState['e3'].selectedPlan).toBe('120');
        expect(userState['e3'].isContraReembolsoMAX).toBe(false);
    });
});
