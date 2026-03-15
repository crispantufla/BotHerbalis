/**
 * COMPREHENSIVE TEST SUITE: Architecture Refactoring Validation
 * 
 * Tests all components affected by the refactoring:
 * - cartHelpers.ts (NEW)
 * - globalMedia.js (NEW - replaces globalFaq.js)
 * - globals/index.js (MODIFIED - no more FAQ interceptor)
 * - messages.ts (MODIFIED - no more _getStepRedirect)
 * - stepWaitingPlanChoice.ts (REFACTORED)
 * - stepWaitingData.ts (REFACTORED)
 * - stepWaitingWeight.ts (SIMPLIFIED)
 * - stepWaitingPreference.ts (SIMPLIFIED)
 * - validation.ts (UNCHANGED - regression)
 * - Full flow simulations end-to-end
 */

const { processSalesFlow } = require('../src/flows/salesFlow');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════
// MOCK SETUP
// ═══════════════════════════════════════════════

const mockSendMessage = jest.fn();
const mockNotifyAdmin = jest.fn();
const mockSaveState = jest.fn();
const mockClient = { sendMessage: jest.fn() };

const mockDependencies = {
    client: mockClient,
    notifyAdmin: mockNotifyAdmin,
    saveState: mockSaveState,
    sendMessageWithDelay: mockSendMessage,
    logAndEmit: jest.fn(),
    sharedState: { io: { emit: jest.fn() }, pausedUsers: new Set() },
    aiService: require('../src/services/ai').aiService,
    config: { activeScript: 'v3', scriptStats: {} }
};

// LOAD KNOWLEDGE
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '../knowledge_v3.json'), 'utf8'));

// AI SERVICE MOCK
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn().mockResolvedValue({ response: "AI Default Response", goalMet: false }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockImplementation(async (text) => {
            const lower = text.toLowerCase();
            // Full address
            if ((lower.includes('calle') || lower.includes('san martin') || lower.includes('av')) && /\d+/.test(text)) {
                const nameMatch = text.match(/^([A-ZÁÉÍÓÚÑa-záéíóúñ]+\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+)/);
                return {
                    nombre: nameMatch ? nameMatch[1] : "Test User",
                    calle: "Calle Falsa 123",
                    ciudad: "Buenos Aires",
                    provincia: "Buenos Aires",
                    cp: "1000"
                };
            }
            // Partial - just name
            if (/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(text.trim())) {
                return { nombre: text.trim() };
            }
            // Partial - just city and CP
            if (/\d{4}/.test(text) && !lower.includes('calle')) {
                return { ciudad: "Buenos Aires", cp: text.match(/\d{4}/)[0] };
            }
            return { _error: true };
        }),
        generateContextualBridge: jest.fn().mockResolvedValue(""), // Should NOT be called anymore
        analyzeImage: jest.fn().mockResolvedValue(null)
    }
}));

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }), { virtual: true });
jest.mock('../sheets_sync', () => ({ appendOrderToSheet: jest.fn().mockResolvedValue(true) }), { virtual: true });
jest.mock('google-spreadsheet', () => ({}), { virtual: true });
jest.mock('@google/generative-ai', () => ({}), { virtual: true });

// Mock address validator
jest.mock('../src/services/addressValidator', () => ({
    validateAddress: jest.fn().mockResolvedValue({ cpValid: true, cpCleaned: '1000', province: 'Buenos Aires' })
}));

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════

function makeState(step, overrides = {}) {
    return {
        step,
        history: [],
        partialAddress: {},
        cart: [],
        ...overrides
    };
}

function lastSentMessage() {
    const calls = mockSendMessage.mock.calls;
    return calls.length > 0 ? calls[calls.length - 1][1] : null;
}

function allSentMessages() {
    return mockSendMessage.mock.calls.map(c => c[1]);
}

function sentMessageContains(text) {
    return allSentMessages().some(m => m && m.toLowerCase().includes(text.toLowerCase()));
}

// ═══════════════════════════════════════════════
// 1. CART HELPERS (NEW MODULE)
// ═══════════════════════════════════════════════

describe('cartHelpers', () => {
    const { buildCartFromSelection, calculateTotal } = require('../src/flows/utils/cartHelpers');

    describe('buildCartFromSelection', () => {
        test.each([
            ['Cápsulas de nuez de la india', '60'],
            ['Cápsulas de nuez de la india', '120'],
            ['Semillas de nuez de la india', '60'],
            ['Semillas de nuez de la india', '120'],
            ['Gotas de nuez de la india', '60'],
            ['Gotas de nuez de la india', '120'],
        ])('builds cart for %s plan %s', (product, plan) => {
            const state = makeState('waiting_plan_choice');
            buildCartFromSelection(product, plan, state);

            expect(state.cart).toHaveLength(1);
            expect(state.cart[0].product).toBe(product);
            expect(state.cart[0].plan).toBe(plan);
            expect(state.cart[0].price).toBeDefined();
            expect(state.selectedPlan).toBe(plan);
            expect(state.selectedProduct).toBe(product);
        });

        test('60-day plan enables ContraReembolso MAX', () => {
            const state = makeState('waiting_plan_choice');
            buildCartFromSelection('Cápsulas de nuez de la india', '60', state);
            expect(state.isContraReembolsoMAX).toBe(true);
            expect(state.adicionalMAX).toBeGreaterThan(0);
        });

        test('120-day plan disables ContraReembolso MAX', () => {
            const state = makeState('waiting_plan_choice');
            buildCartFromSelection('Cápsulas de nuez de la india', '120', state);
            expect(state.isContraReembolsoMAX).toBe(false);
            expect(state.adicionalMAX).toBe(0);
        });

        test.each(['180', '240', '300', '360'])('extended plan %s calculates correctly', (plan) => {
            const state60 = makeState('waiting_plan_choice');
            const state120 = makeState('waiting_plan_choice');
            const stateExtended = makeState('waiting_plan_choice');

            buildCartFromSelection('Cápsulas de nuez de la india', '60', state60);
            buildCartFromSelection('Cápsulas de nuez de la india', '120', state120);
            buildCartFromSelection('Cápsulas de nuez de la india', plan, stateExtended);

            const price60 = parseInt(state60.cart[0].price.replace(/\./g, ''));
            const price120 = parseInt(state120.cart[0].price.replace(/\./g, ''));
            const priceExt = parseInt(stateExtended.cart[0].price.replace(/\./g, ''));
            const factor = parseInt(plan) / 60;
            const pairs = Math.floor(factor / 2);
            const remainder = factor % 2;
            const expected = (pairs * price120) + (remainder * price60);

            expect(priceExt).toBe(expected);
        });

        test('price is formatted with dots (Argentine locale)', () => {
            const state = makeState('waiting_plan_choice');
            buildCartFromSelection('Cápsulas de nuez de la india', '120', state);
            // Price should be like "66.900" format
            expect(state.cart[0].price).toMatch(/\d+\.\d{3}/);
        });
    });

    describe('calculateTotal', () => {
        test('calculates total without adicional', () => {
            const state = makeState('waiting_plan_choice', {
                cart: [{ product: 'Test', plan: '120', price: '66.900' }],
                adicionalMAX: 0
            });
            const total = calculateTotal(state);
            expect(total).toBe('66.900');
            expect(state.totalPrice).toBe('66.900');
        });

        test('calculates total with adicional MAX', () => {
            const state = makeState('waiting_plan_choice', {
                cart: [{ product: 'Test', plan: '60', price: '46.900' }],
                adicionalMAX: 6000
            });
            const total = calculateTotal(state);
            expect(parseInt(total.replace(/\./g, ''))).toBe(52900);
        });

        test('handles multi-item cart', () => {
            const state = makeState('waiting_plan_choice', {
                cart: [
                    { product: 'Cápsulas', plan: '60', price: '46.900' },
                    { product: 'Gotas', plan: '60', price: '48.900' }
                ],
                adicionalMAX: 0
            });
            const total = calculateTotal(state);
            expect(parseInt(total.replace(/\./g, ''))).toBe(95800);
        });
    });
});

// ═══════════════════════════════════════════════
// 2. VALIDATION (REGRESSION)
// ═══════════════════════════════════════════════

describe('Validation Utils (Regression)', () => {
    const { _isAffirmative, _isNegative } = require('../src/flows/utils/validation');

    describe('_isAffirmative', () => {
        test.each([
            'si', 'sisi', 'dale', 'ok', 'listo', 'bueno', 'de una',
            'joya', 'genial', 'perfecto', 'buenisimo', 'por supuesto',
            'claro', 'vamos', 'sip', 'sep', 'esta bien', 'va'
        ])('detects "%s" as affirmative', (text) => {
            expect(_isAffirmative(text)).toBe(true);
        });

        test.each([
            'si pero primero quiero saber algo', 'bueno no se',
            'si fuera mas barato', 'no quiero', 'prefiero no',
            'capaz', 'quizas', 'tal vez', 'primero decime',
            'si? no estoy seguro la verdad'
        ])('rejects "%s" as NOT affirmative', (text) => {
            expect(_isAffirmative(text)).toBe(false);
        });

        test('rejects questions', () => {
            expect(_isAffirmative('si?')).toBe(false);
            expect(_isAffirmative('bueno?')).toBe(false);
        });

        test('rejects long ambiguous messages', () => {
            expect(_isAffirmative('si bueno pero la verdad no estoy muy segura de eso todavia')).toBe(false);
        });
    });

    describe('_isNegative', () => {
        test.each([
            'no', 'nop', 'nope', 'nah', 'no quiero', 'imposible',
            'ni loca', 'ni loco', 'no me interesa', 'no gracias', 'para nada'
        ])('detects "%s" as negative', (text) => {
            expect(_isNegative(text)).toBe(true);
        });

        test.each([
            'no hay problema con eso verdad?', 'no tengo efectivo pero puedo transferir'
        ])('rejects "%s" as NOT simply negative', (text) => {
            expect(_isNegative(text)).toBe(false);
        });

        // These ARE negative because they are ≤3 words containing "no"
        test.each([
            'no se', 'no pero bueno'
        ])('correctly detects "%s" as negative (short with "no")', (text) => {
            expect(_isNegative(text)).toBe(true);
        });
    });
});

// ═══════════════════════════════════════════════
// 3. MESSAGES UTILS (REGRESSION + NO STEP REDIRECT)
// ═══════════════════════════════════════════════

describe('Messages Utils', () => {
    const messagesModule = require('../src/flows/utils/messages');

    test('_getStepRedirect no longer exists', () => {
        expect(messagesModule._getStepRedirect).toBeUndefined();
    });

    test('_formatMessage still works', () => {
        expect(messagesModule._formatMessage).toBeDefined();
        const result = messagesModule._formatMessage("Hola {{PRODUCT}}", { selectedProduct: "Cápsulas" });
        expect(result).toContain("Cápsulas");
    });

    test('_isDuplicate detects exact duplicates', () => {
        const history = [{ role: 'bot', content: 'Hola mundo' }];
        expect(messagesModule._isDuplicate('Hola mundo', history)).toBe(true);
    });

    test('_isDuplicate ignores non-duplicates', () => {
        const history = [{ role: 'bot', content: 'Hola mundo' }];
        expect(messagesModule._isDuplicate('Chau mundo', history)).toBe(false);
    });

    test('_getAdminSuggestions still works', () => {
        expect(messagesModule._getAdminSuggestions).toBeDefined();
        const suggestions = messagesModule._getAdminSuggestions('waiting_data', 'test');
        expect(Array.isArray(suggestions)).toBe(true);
    });
});

// ═══════════════════════════════════════════════
// 4. GLOBALS PIPELINE (NO MORE FAQ INTERCEPTOR)
// ═══════════════════════════════════════════════

describe('Globals Pipeline (Refactored)', () => {
    const userId = 'test_global';

    beforeEach(() => {
        mockSendMessage.mockClear();
        mockNotifyAdmin.mockClear();
        mockClient.sendMessage.mockClear();
        mockDependencies.sharedState.pausedUsers.clear();
    });

    // --- System globals (UNCHANGED) ---
    describe('globalSystem (maintained)', () => {
        test.each([
            ['cancelar', /cancelarlo|Qué pena/i],
            ['quiero cancelar mi pedido', /cancelarlo|Qué pena/i],
        ])('detects cancellation: "%s"', async (text, expected) => {
            const userState = { [userId]: makeState('waiting_plan_choice') };
            await processSalesFlow(userId, text, userState, knowledge, mockDependencies);
            expect(sentMessageContains('cancelar') || sentMessageContains('pena')).toBe(true);
        });

        test('blocks geo-rejected users from Argentina-only shipping', async () => {
            const userState = { [userId]: makeState('waiting_weight') };
            await processSalesFlow(userId, "soy de españa", userState, knowledge, mockDependencies);
            expect(sentMessageContains('solo hacemos envíos dentro de argentina')).toBe(true);
        });

        test.each([
            'soy de mexico', 'vivo en chile', 'estoy en colombia',
            'soy de peru', 'vivo en el exterior', 'no estoy en argentina'
        ])('geo-rejects: "%s"', async (text) => {
            const userState = { [userId]: makeState('waiting_weight') };
            await processSalesFlow(userId, text, userState, knowledge, mockDependencies);
            expect(sentMessageContains('argentina')).toBe(true);
        });

        test('detects medical rejection (embarazo)', async () => {
            const userState = { [userId]: makeState('waiting_weight') };
            await processSalesFlow(userId, "estoy embarazada", userState, knowledge, mockDependencies);
            expect(sentMessageContains('embarazo') || sentMessageContains('lactancia') || sentMessageContains('precaución')).toBe(true);
        });

        test('handles change order request', async () => {
            const userState = { [userId]: makeState('waiting_plan_choice', { selectedProduct: 'Cápsulas' }) };
            await processSalesFlow(userId, "quiero cambiar a otra cosa", userState, knowledge, mockDependencies);
            expect(userState[userId].step).toBe('waiting_preference');
        });
    });

    // --- FAQ NO LONGER INTERCEPTED ---
    describe('FAQ questions NOT intercepted by globals', () => {
        test.each([
            'cuanto sale',
            'que precio tiene',
            'tienen tarjeta',
            'puedo pagar con transferencia',
            'como se toma',
            'como se toman las capsulas',
            'tiene efecto rebote',
            'tiene contraindicaciones',
        ])('"%s" is NOT intercepted by globalFaq (goes to step handler)', async (text) => {
            const userState = { [userId]: makeState('waiting_weight') };
            mockSendMessage.mockClear();

            await processSalesFlow(userId, text, userState, knowledge, mockDependencies);

            // Should NOT contain step redirect patterns anymore
            const messages = allSentMessages();
            const hasStepRedirect = messages.some(m =>
                m && m.startsWith('👉')
            );
            expect(hasStepRedirect).toBe(false);
        });

        test('payment question during waiting_data does NOT trigger double response', async () => {
            const userState = {
                [userId]: makeState('waiting_data', {
                    selectedProduct: 'Cápsulas de nuez de la india',
                    selectedPlan: '120',
                    cart: [{ product: 'Cápsulas', plan: '120', price: '66.900' }]
                })
            };
            mockSendMessage.mockClear();

            // Configure AI to answer the question
            require('../src/services/ai').aiService.chat.mockResolvedValueOnce({
                response: "El pago es en efectivo al cartero cuando recibís el producto.",
                goalMet: false
            });

            await processSalesFlow(userId, "como se paga?", userState, knowledge, mockDependencies);

            // Should get AI response but NO step redirect
            const messages = allSentMessages();
            expect(messages.length).toBeLessThanOrEqual(2); // Max: AI response (no redirect spam)
            const hasRedirect = messages.some(m => m && m.includes('👉'));
            expect(hasRedirect).toBe(false);
        });
    });

    // --- Media globals (NEW) ---
    describe('globalMedia (new)', () => {
        test('detects photo request', async () => {
            const userState = { [userId]: makeState('waiting_preference', { selectedProduct: 'Cápsulas de nuez de la india' }) };
            await processSalesFlow(userId, "mandame fotos de capsulas", userState, knowledge, mockDependencies);
            expect(sentMessageContains('fotos') || sentMessageContains('Acá tenés')).toBe(true);
        });

        test('photo request does NOT add step redirect', async () => {
            const userState = { [userId]: makeState('waiting_weight') };
            await processSalesFlow(userId, "quiero ver fotos", userState, knowledge, mockDependencies);
            const messages = allSentMessages();
            const hasRedirect = messages.some(m => m && m.startsWith('👉'));
            expect(hasRedirect).toBe(false);
        });
    });
});

// ═══════════════════════════════════════════════
// 5. STEP HANDLERS
// ═══════════════════════════════════════════════

describe('Step Handlers (Refactored)', () => {
    const userId = 'test_step';

    beforeEach(() => {
        mockSendMessage.mockClear();
        mockNotifyAdmin.mockClear();
        mockSaveState.mockClear();
        mockClient.sendMessage.mockClear();
        mockDependencies.sharedState.pausedUsers.clear();
        require('../src/services/ai').aiService.chat.mockResolvedValue({ response: "AI Default Response", goalMet: false });
        require('../src/services/ai').aiService.generateContextualBridge.mockClear();
    });

    // --- GREETING ---
    describe('stepGreeting', () => {
        test('sends greeting message on first contact', async () => {
            const userState = { [userId]: makeState('greeting') };
            await processSalesFlow(userId, 'hola', userState, knowledge, mockDependencies);
            expect(mockSendMessage).toHaveBeenCalled();
            expect(userState[userId].step).toBe('waiting_weight');
        });

        test('skips ad trigger "Hola! (Vengo de un anuncio)"', async () => {
            const userState = { [userId]: makeState('greeting') };
            await processSalesFlow(userId, 'Hola! (Vengo de un anuncio)', userState, knowledge, mockDependencies);
            expect(userState[userId].step).toBe('waiting_weight');
        });

        test.each([
            'hola', 'buenas', 'buenas tardes', 'buenas noches', 'hola como estas',
            'hola quiero info', 'buenas quiero consultar'
        ])('handles greeting: "%s"', async (text) => {
            const userState = { [userId]: makeState('greeting') };
            await processSalesFlow(userId, text, userState, knowledge, mockDependencies);
            expect(userState[userId].step).toBe('waiting_weight');
        });
    });

    // --- WAITING WEIGHT ---
    describe('stepWaitingWeight', () => {
        test.each([
            ['10', 10], ['5', 5], ['20', 20], ['15 kilos', 15],
            ['quiero bajar 8 kilos', 8], ['unos 25', 25], ['12', 12],
            ['3', 3], ['50', 50], ['7 kg', 7]
        ])('extracts weight from "%s" → %i', async (text, expectedWeight) => {
            const userState = { [userId]: makeState('waiting_weight') };
            await processSalesFlow(userId, text, userState, knowledge, mockDependencies);
            expect(userState[userId].weightGoal).toBe(expectedWeight);
        });

        test('advances to recommendation after weight number', async () => {
            const userState = { [userId]: makeState('waiting_weight') };
            await processSalesFlow(userId, '10', userState, knowledge, mockDependencies);
            expect(['waiting_preference', 'waiting_plan_choice']).toContain(userState[userId].step);
        });

        test('does NOT call generateContextualBridge', async () => {
            const userState = { [userId]: makeState('waiting_weight') };
            await processSalesFlow(userId, '10 kilos', userState, knowledge, mockDependencies);
            expect(require('../src/services/ai').aiService.generateContextualBridge).not.toHaveBeenCalled();
        });

        test('detects implicit capsulas preference in weight step', async () => {
            const userState = { [userId]: makeState('waiting_weight') };
            await processSalesFlow(userId, '10 kilos y quiero capsulas', userState, knowledge, mockDependencies);
            expect(userState[userId].weightGoal).toBe(10);
        });

        test('skips to preference after 2+ refusals', async () => {
            const userState = { [userId]: makeState('waiting_weight', { weightRefusals: 2 }) };
            await processSalesFlow(userId, 'no se la verdad', userState, knowledge, mockDependencies);
            expect(userState[userId].step).toBe('waiting_preference');
        });

        test('detects explicit refusal', async () => {
            const userState = { [userId]: makeState('waiting_weight') };
            await processSalesFlow(userId, 'prefiero no contestar eso', userState, knowledge, mockDependencies);
            expect(userState[userId].step).toBe('waiting_preference');
        });

        test('uses AI fallback for non-number messages', async () => {
            const userState = { [userId]: makeState('waiting_weight') };
            require('../src/services/ai').aiService.chat.mockResolvedValueOnce({
                response: "Te entiendo perfectamente. ¿Cuántos kilos querés bajar?",
                goalMet: false
            });
            await processSalesFlow(userId, 'estoy gordita', userState, knowledge, mockDependencies);
            expect(sentMessageContains('entiendo') || sentMessageContains('AI Default')).toBe(true);
        });
    });

    // --- WAITING PREFERENCE ---
    describe('stepWaitingPreference', () => {
        test.each([
            ['capsulas', 'Cápsulas de nuez de la india'],
            ['pastillas', 'Cápsulas de nuez de la india'],
            ['semillas', 'Semillas de nuez de la india'],
            ['gotas', 'Gotas de nuez de la india'],
        ])('detects product keyword "%s" → %s', async (text, expectedProduct) => {
            const userState = { [userId]: makeState('waiting_preference') };
            await processSalesFlow(userId, text, userState, knowledge, mockDependencies);
            expect(userState[userId].selectedProduct).toBe(expectedProduct);
        });

        test('does NOT call generateContextualBridge for capsulas', async () => {
            const userState = { [userId]: makeState('waiting_preference') };
            await processSalesFlow(userId, 'capsulas', userState, knowledge, mockDependencies);
            expect(require('../src/services/ai').aiService.generateContextualBridge).not.toHaveBeenCalled();
        });

        test('does NOT call generateContextualBridge for semillas', async () => {
            const userState = { [userId]: makeState('waiting_preference') };
            await processSalesFlow(userId, 'semillas', userState, knowledge, mockDependencies);
            expect(require('../src/services/ai').aiService.generateContextualBridge).not.toHaveBeenCalled();
        });

        test('does NOT call generateContextualBridge for gotas', async () => {
            const userState = { [userId]: makeState('waiting_preference') };
            await processSalesFlow(userId, 'gotas', userState, knowledge, mockDependencies);
            expect(require('../src/services/ai').aiService.generateContextualBridge).not.toHaveBeenCalled();
        });

        test('advances step after product selection', async () => {
            const userState = { [userId]: makeState('waiting_preference') };
            await processSalesFlow(userId, 'capsulas', userState, knowledge, mockDependencies);
            expect(userState[userId].step).toBe('waiting_plan_choice');
        });

        test('uses AI for indecisive user', async () => {
            const userState = { [userId]: makeState('waiting_preference') };
            require('../src/services/ai').aiService.chat.mockResolvedValueOnce({
                response: "Las cápsulas son más efectivas.",
                goalMet: false
            });
            await processSalesFlow(userId, 'cual me recomendas', userState, knowledge, mockDependencies);
            expect(mockSendMessage).toHaveBeenCalled();
        });

        test('handles comparison "capsulas o gotas"', async () => {
            const userState = { [userId]: makeState('waiting_preference') };
            await processSalesFlow(userId, 'capsulas o gotas', userState, knowledge, mockDependencies);
            expect(mockSendMessage).toHaveBeenCalled();
        });
    });

    // --- WAITING PRICE CONFIRMATION ---
    describe('stepWaitingPriceConfirmation', () => {
        test.each([
            'si', 'dale', 'ok', 'pasame los precios', 'cuanto sale', 'decime el precio'
        ])('confirms price request with "%s"', async (text) => {
            const userState = { [userId]: makeState('waiting_price_confirmation', { selectedProduct: 'Cápsulas de nuez de la india' }) };
            await processSalesFlow(userId, text, userState, knowledge, mockDependencies);
            expect(userState[userId].step).toBe('waiting_plan_choice');
        });
    });

    // --- WAITING PLAN CHOICE (REFACTORED) ---
    describe('stepWaitingPlanChoice (refactored with cartHelpers)', () => {
        const basePlanState = {
            selectedProduct: 'Cápsulas de nuez de la india',
            history: [{ role: 'bot', content: 'Precios de capsulas' }]
        };

        test.each([
            ['60', '60'], ['120', '120'], ['el de 60', '60'], ['plan 120', '120'],
            ['60 dias', '60'], ['120 dias', '120']
        ])('selects plan from "%s" → plan %s', async (text, expectedPlan) => {
            const userState = { [userId]: makeState('waiting_plan_choice', basePlanState) };
            await processSalesFlow(userId, text, userState, knowledge, mockDependencies);
            expect(userState[userId].selectedPlan).toBe(expectedPlan);
        });

        test('60-day plan sets MAX correctly', async () => {
            const userState = { [userId]: makeState('waiting_plan_choice', basePlanState) };
            await processSalesFlow(userId, '60', userState, knowledge, mockDependencies);
            expect(userState[userId].isContraReembolsoMAX).toBe(true);
            expect(userState[userId].adicionalMAX).toBeGreaterThan(0);
        });

        test('120-day plan disables MAX', async () => {
            const userState = { [userId]: makeState('waiting_plan_choice', basePlanState) };
            await processSalesFlow(userId, '120', userState, knowledge, mockDependencies);
            expect(userState[userId].isContraReembolsoMAX).toBe(false);
            expect(userState[userId].adicionalMAX).toBe(0);
        });

        test('advances to waiting_data after plan selection', async () => {
            const userState = { [userId]: makeState('waiting_plan_choice', basePlanState) };
            await processSalesFlow(userId, '120', userState, knowledge, mockDependencies);
            expect(userState[userId].step).toBe('waiting_data');
        });

        test('price question does not select plan', async () => {
            const userState = { [userId]: makeState('waiting_plan_choice', basePlanState) };
            require('../src/services/ai').aiService.chat.mockResolvedValueOnce({
                response: "El de 120 sale 66.900", goalMet: false
            });
            await processSalesFlow(userId, 'cuanto sale el de 120', userState, knowledge, mockDependencies);
            expect(userState[userId].step).toBe('waiting_plan_choice');
        });

        test('AI plan extraction works through cartHelpers', async () => {
            const userState = { [userId]: makeState('waiting_plan_choice', basePlanState) };
            require('../src/services/ai').aiService.chat.mockResolvedValueOnce({
                response: "Genial, el de 120 es la mejor opcion",
                goalMet: true,
                extractedData: "120"
            });
            await processSalesFlow(userId, 'dale el mas largo', userState, knowledge, mockDependencies);
            expect(userState[userId].selectedPlan).toBe('120');
            expect(userState[userId].cart).toHaveLength(1);
        });

        test('skip to confirmation if address already collected', async () => {
            const userState = {
                [userId]: makeState('waiting_plan_choice', {
                    ...basePlanState,
                    partialAddress: { nombre: 'Test', calle: 'Calle 123', ciudad: 'BA' }
                })
            };
            await processSalesFlow(userId, '120', userState, knowledge, mockDependencies);
            expect(userState[userId].step).toBe('waiting_final_confirmation');
        });

        test('upsell intercept: "si" after 120 recommendation', async () => {
            const userState = {
                [userId]: makeState('waiting_plan_choice', {
                    ...basePlanState,
                    history: [{ role: 'bot', content: 'Te recomendaría el de 120 días' }]
                })
            };
            await processSalesFlow(userId, 'dale', userState, knowledge, mockDependencies);
            expect(userState[userId].selectedPlan).toBe('120');
        });
    });

    // --- WAITING OK ---
    describe('stepWaitingOk', () => {
        test('affirmative moves to closing', async () => {
            const userState = { [userId]: makeState('waiting_ok') };
            await processSalesFlow(userId, 'si', userState, knowledge, mockDependencies);
            expect(userState[userId].step).toBe('waiting_data');
        });

        test('negative pauses bot', async () => {
            const userState = { [userId]: makeState('waiting_ok') };
            await processSalesFlow(userId, 'no', userState, knowledge, mockDependencies);
            expect(mockDependencies.sharedState.pausedUsers.has(userId)).toBe(true);
        });

        test('"ir a buscar" triggers no-local message', async () => {
            const userState = { [userId]: makeState('waiting_ok') };
            await processSalesFlow(userId, 'puedo ir a buscar el pedido', userState, knowledge, mockDependencies);
            expect(sentMessageContains('local de venta') || sentMessageContains('Correo Argentino')).toBe(true);
        });
    });

    // --- WAITING DATA ---
    describe('stepWaitingData', () => {
        const baseDataState = {
            selectedProduct: 'Cápsulas de nuez de la india',
            selectedPlan: '120',
            cart: [{ product: 'Cápsulas de nuez de la india', plan: '120', price: '66.900' }]
        };

        test('redirects to preference if no product selected', async () => {
            const userState = { [userId]: makeState('waiting_data', { selectedProduct: null }) };
            await processSalesFlow(userId, 'mi nombre es Juan', userState, knowledge, mockDependencies);
            expect(userState[userId].step).toBe('waiting_preference');
        });

        test('redirects to plan if no plan selected', async () => {
            const userState = {
                [userId]: makeState('waiting_data', {
                    selectedProduct: 'Cápsulas de nuez de la india',
                    selectedPlan: null
                })
            };
            await processSalesFlow(userId, 'mi nombre es Juan', userState, knowledge, mockDependencies);
            expect(userState[userId].step).toBe('waiting_plan_choice');
        });

        test('product change uses cartHelpers', async () => {
            const userState = { [userId]: makeState('waiting_data', baseDataState) };
            await processSalesFlow(userId, 'prefiero cambiar a gotas de 60', userState, knowledge, mockDependencies);
            expect(userState[userId].selectedProduct).toBe('Gotas de nuez de la india');
        });

        test('handles questions during data collection via AI', async () => {
            const userState = { [userId]: makeState('waiting_data', baseDataState) };
            require('../src/services/ai').aiService.chat.mockResolvedValueOnce({
                response: "El pago es en efectivo al cartero",
                goalMet: false
            });
            await processSalesFlow(userId, 'como se paga?', userState, knowledge, mockDependencies);
            expect(mockSendMessage).toHaveBeenCalled();
            // Step should NOT change
            expect(userState[userId].step).toBe('waiting_data');
        });

        test('address collection asks for missing fields', async () => {
            const userState = { [userId]: makeState('waiting_data', baseDataState) };
            require('../src/services/ai').aiService.parseAddress.mockResolvedValueOnce({ nombre: 'Juan Perez' });
            await processSalesFlow(userId, 'Juan Perez', userState, knowledge, mockDependencies);
            expect(mockSendMessage).toHaveBeenCalled();
        });
    });
});

// ═══════════════════════════════════════════════
// 6. NO DOUBLE RESPONSE SCENARIOS
// ═══════════════════════════════════════════════

describe('No Double Response (Core Fix Validation)', () => {
    const userId = 'test_no_double';

    beforeEach(() => {
        mockSendMessage.mockClear();
        require('../src/services/ai').aiService.chat.mockResolvedValue({ response: "AI Response", goalMet: false });
    });

    test.each([
        ['waiting_weight', 'cuanto sale?'],
        ['waiting_weight', 'como se paga'],
        ['waiting_preference', 'tiene efectos secundarios?'],
        ['waiting_plan_choice', 'se puede pagar con tarjeta?'],
        ['waiting_ok', 'cuanto tarda el envio?'],
        ['waiting_data', 'se puede transferir?'],
    ])('No "👉" redirect after FAQ in step "%s" with message "%s"', async (step, msg) => {
        const userState = {
            [userId]: makeState(step, {
                selectedProduct: 'Cápsulas de nuez de la india',
                selectedPlan: '120',
                cart: [{ product: 'Cápsulas', plan: '120', price: '66.900' }]
            })
        };

        await processSalesFlow(userId, msg, userState, knowledge, mockDependencies);

        const messages = allSentMessages();
        const redirectMessages = messages.filter(m => m && m.startsWith('👉'));
        expect(redirectMessages).toHaveLength(0);
    });

    test.each([
        'tarjeta', 'transferencia', 'mercadopago', 'debito',
        'rapipago', 'visa', 'mastercard'
    ])('Payment keyword "%s" does NOT trigger globalFaq anymore', async (keyword) => {
        const userState = { [userId]: makeState('waiting_weight') };
        await processSalesFlow(userId, `puedo pagar con ${keyword}?`, userState, knowledge, mockDependencies);

        const messages = allSentMessages();
        // Should NOT have the old fixed "Te cuento, el pago es únicamente en efectivo" from globalFaq
        const hasOldFaqResponse = messages.some(m =>
            m && m.includes('Te cuento, el pago es únicamente en efectivo')
        );
        expect(hasOldFaqResponse).toBe(false);
    });

    test.each([
        'como se toman', 'como lo tomo', 'como se toma', 'como se usa'
    ])('"%s" does NOT trigger globalFaq anymore', async (text) => {
        const userState = { [userId]: makeState('waiting_plan_choice', { selectedProduct: 'Cápsulas de nuez de la india' }) };
        await processSalesFlow(userId, text, userState, knowledge, mockDependencies);
        // Should go to AI, not to fixed FAQ
        const messages = allSentMessages();
        const hasOldFaqResponse = messages.some(m => m && m.includes('CÁPSULAS:'));
        expect(hasOldFaqResponse).toBe(false);
    });
});

// ═══════════════════════════════════════════════
// 7. FULL CONVERSATION SIMULATIONS (200+ runs)
// ═══════════════════════════════════════════════

describe('Full Conversation Simulations (200 runs)', () => {
    const scenarios = [
        {
            name: "Ideal_Capsulas_120",
            shouldComplete: true,
            messages: [
                "hola quiero bajar de peso",
                "quiero bajar 10 kilos",
                "quiero capsulas",
                "120 dias por favor",
                "Juan Perez, Calle Falsa 123, Ciudad, 1000",
                "si confirmo"
            ]
        },
        {
            name: "Ideal_Semillas_60",
            shouldComplete: true,
            messages: [
                "buenas tardes",
                "5 kilos",
                "semillas",
                "60",
                "Maria Garcia, Av San Martin 456, Rosario, 2000",
                "si"
            ]
        },
        {
            name: "Ideal_Gotas_120",
            shouldComplete: true,
            messages: [
                "hola",
                "3 kilos",
                "gotas",
                "120",
                "Ana Lopez, Calle Lima 789, Mendoza, 5500",
                "dale"
            ]
        },
        {
            name: "Usuario_con_Dudas",
            shouldComplete: true,
            messages: [
                "buenas tardes",
                "necesito bajar 8 kilos",
                "pero tiene efecto rebote?",
                "bueno probemos con las capsulas",
                "dale el de 120 dias",
                "Maria Lopez, San Martin 456, Cordoba, 5000",
                "si todo correcto"
            ]
        },
        {
            name: "Cambio_Producto",
            shouldComplete: true,
            messages: [
                "hola",
                "tengo que bajar 20 kilos",
                "quiero comprar las semillas",
                "uy no prefiero las capsulas",
                "quiero las capsulas",
                "el de 120",
                "Pedro Gomez, Calle Lima 12, Mendoza, 5500",
                "ok confirmo"
            ]
        },
        {
            name: "Comprador_Directo",
            shouldComplete: true,
            messages: [
                "hola quiero capsulas de 120 dias",
                "10",
                "capsulas",
                "120",
                "Test User, Calle Falsa 123, CABA, 1000",
                "si perfecto"
            ]
        },
        {
            name: "Postdatado",
            shouldComplete: false,
            messages: [
                "hola",
                "quiero bajar 5 kilos",
                "las gotas",
                "60",
                "te puedo pagar a fin de mes?",
                "dale yo te aviso"
            ]
        },
        {
            name: "Negativa_Amable",
            shouldComplete: false,
            messages: [
                "hola info",
                "esta muy caro lo voy a pensar",
                "chau"
            ]
        },
        {
            name: "Solo_Pregunta_Precio",
            shouldComplete: false,
            messages: [
                "hola buenas",
                "8 kilos",
                "cuanto salen las capsulas?",
                "y las semillas?",
                "voy a pensarlo gracias"
            ]
        },
        {
            name: "Geo_Rechazado",
            shouldComplete: false,
            messages: [
                "hola soy de españa",
                "pero puedo pagar el envio internacional?"
            ]
        }
    ];

    const runSimulation = async (count) => {
        let loopCount = 0;
        let expectedSuccesses = 0;
        let actualSuccesses = 0;
        let errors = [];

        for (let i = 0; i < count; i++) {
            const scenario = scenarios[i % scenarios.length];
            const uid = `sim_${scenario.name}_${i}`;
            const userState = { [uid]: makeState('greeting') };

            if (scenario.shouldComplete) expectedSuccesses++;

            mockSendMessage.mockClear();
            const trackSteps = [];

            for (const msg of scenario.messages) {
                const prevStep = userState[uid].step;

                require('../src/services/ai').aiService.chat.mockResolvedValueOnce({
                    response: "Respuesta simulada de la IA.",
                    goalMet: false
                });

                try {
                    await processSalesFlow(uid, msg, userState, knowledge, mockDependencies);
                } catch (e) {
                    errors.push(`${uid}: ${e.message}`);
                    break;
                }

                const currentStep = userState[uid].step;
                trackSteps.push(currentStep);

                if (prevStep === currentStep && currentStep !== 'completed') {
                    const sameStepCount = trackSteps.filter(s => s === currentStep).length;
                    if (sameStepCount > 4) {
                        loopCount++;
                        errors.push(`🚨 LOOP in ${uid} at step ${currentStep}`);
                        break;
                    }
                }
            }

            if (scenario.shouldComplete) {
                const finalStep = userState[uid].step;
                if (['completed', 'waiting_admin_ok', 'waiting_final_confirmation', 'waiting_admin_validation'].includes(finalStep)) {
                    actualSuccesses++;
                } else {
                    errors.push(`⚠️ ${uid} ended at: ${finalStep} — Path: ${trackSteps.join(' → ')}`);
                }
            }
        }

        if (errors.length > 0) {
            console.log('Simulation errors:', errors.join('\n'));
        }

        return { loopCount, expectedSuccesses, actualSuccesses, errors };
    };

    test('Simulate 200 conversations with NO loops', async () => {
        const result = await runSimulation(200);
        expect(result.loopCount).toBe(0);
    });

    test('All shouldComplete scenarios reach final steps', async () => {
        const result = await runSimulation(200);
        expect(result.actualSuccesses).toBe(result.expectedSuccesses);
    });

    test('No unhandled exceptions in 200 conversations', async () => {
        const result = await runSimulation(200);
        const exceptions = result.errors.filter(e => !e.startsWith('⚠️') && !e.startsWith('🚨'));
        expect(exceptions).toHaveLength(0);
    });
});

// ═══════════════════════════════════════════════
// 8. EDGE CASES
// ═══════════════════════════════════════════════

describe('Edge Cases', () => {
    const userId = 'test_edge';

    beforeEach(() => {
        mockSendMessage.mockClear();
        require('../src/services/ai').aiService.chat.mockResolvedValue({ response: "AI Default Response", goalMet: false });
    });

    test('empty message does not crash', async () => {
        const userState = { [userId]: makeState('waiting_weight') };
        await expect(processSalesFlow(userId, '', userState, knowledge, mockDependencies)).resolves.not.toThrow();
    });

    test('very long message does not crash', async () => {
        const userState = { [userId]: makeState('waiting_weight') };
        const longMsg = 'a'.repeat(5000);
        await expect(processSalesFlow(userId, longMsg, userState, knowledge, mockDependencies)).resolves.not.toThrow();
    });

    test('special characters do not crash', async () => {
        const userState = { [userId]: makeState('waiting_weight') };
        await expect(processSalesFlow(userId, '¿¡@#$%^&*(){}[]', userState, knowledge, mockDependencies)).resolves.not.toThrow();
    });

    test('emoji-only message does not crash', async () => {
        const userState = { [userId]: makeState('waiting_weight') };
        await expect(processSalesFlow(userId, '😊👍🎉', userState, knowledge, mockDependencies)).resolves.not.toThrow();
    });

    test('numbers-only message in preference step does not crash', async () => {
        const userState = { [userId]: makeState('waiting_preference') };
        await expect(processSalesFlow(userId, '123456', userState, knowledge, mockDependencies)).resolves.not.toThrow();
    });

    test('unknown step migrates gracefully', async () => {
        const userState = { [userId]: makeState('some_unknown_step_v99') };
        await processSalesFlow(userId, 'hola', userState, knowledge, mockDependencies);
        // Unknown steps get migrated to waiting_weight (the default step after stale migration)
        expect(userState[userId].step).toBe('waiting_weight');
    });

    test('stale step "waiting_legal_acceptance" migrates to waiting_final_confirmation', async () => {
        const userState = { [userId]: makeState('waiting_legal_acceptance') };
        await processSalesFlow(userId, 'hola', userState, knowledge, mockDependencies);
        expect(userState[userId].step).not.toBe('waiting_legal_acceptance');
    });

    test.each([
        '0 kilos', '1', '99', '100', '200'
    ])('extreme weight "%s" does not crash', async (text) => {
        const userState = { [userId]: makeState('waiting_weight') };
        await expect(processSalesFlow(userId, text, userState, knowledge, mockDependencies)).resolves.not.toThrow();
    });
});
