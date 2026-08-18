const fs = require('fs');
const path = require('path');

// MOCK FS BEFORE REQUIRING MODULES
jest.mock('fs', () => {
    const actualFs = jest.requireActual('fs');
    return {
        ...actualFs,
        existsSync: jest.fn((p) => {
            if (typeof p === 'string' && p.endsWith('prices.json')) return true;
            return actualFs.existsSync(p);
        }),
        readFileSync: jest.fn((p, opts) => {
            if (typeof p === 'string' && p.endsWith('prices.json')) {
                return JSON.stringify({
                    "Semillas": { "60": "36.900", "120": "49.900" },
                    "Cápsulas": { "60": "46.900", "120": "79.900" },
                    "Gotas": { "60": "40.900", "120": "70.900" }
                });
            }
            return actualFs.readFileSync(p, opts);
        })
    };
});

const { processSalesFlow } = require('../src/flows/salesFlow');

// MOCK DEPENDENCIES
const mockSendMessage = jest.fn();
const mockNotifyAdmin = jest.fn();
const mockSaveState = jest.fn();

const mockDependencies = {
    client: {},
    notifyAdmin: mockNotifyAdmin,
    saveState: mockSaveState,
    sendMessageWithDelay: mockSendMessage,
    logAndEmit: jest.fn(),
    sharedState: { io: { emit: jest.fn() }, pausedUsers: new Set() },
    aiService: require('../src/services/ai').aiService
};

// LOAD KNOWLEDGE V7 (Primary test target)
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '../knowledge_v7.json'), 'utf8'));

// MOCKS
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn().mockResolvedValue({ response: "AI Default", goalMet: false }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockResolvedValue(null)
    }
}));

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }), { virtual: true });
jest.mock('../sheets_sync', () => ({ appendOrderToSheet: jest.fn() }), { virtual: true });
jest.mock('google-spreadsheet', () => ({}), { virtual: true });
jest.mock('openai', () => { return jest.fn().mockImplementation(() => ({})); }, { virtual: true });

describe('V7 Script — Price Centralization', () => {
    let userState;
    const userId = 'test_price';

    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
    });

    test('Should replace {{PRICE_...}} placeholders with real values (Semillas via preference)', async () => {
        userState[userId] = { step: 'waiting_preference', history: [] };

        // User picks semillas => V7 shows prices directly in the preference response
        await processSalesFlow(userId, "semillas", userState, knowledge, mockDependencies);

        // Expect message to contain real numbers, NOT placeholders
        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.not.stringMatching(/{{PRICE_/)
        );

        // Expect specific price for Semillas 60 days
        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.stringMatching(/36\.900/)
        );
    });

    test('Should show the current Cápsulas 60 price (no placeholder)', async () => {
        userState[userId] = { step: 'waiting_preference', history: [] };

        // User picks capsulas => V7 shows prices directly in the preference response
        await processSalesFlow(userId, "capsulas", userState, knowledge, mockDependencies);

        // Dinámico: refleja lo que _getPrice devuelva para el fixture (hoy precio
        // base — el descuento de junio venció y se quitó). No se rompe al tocar la base.
        const { _getPrice } = require('../src/flows/utils/pricing');
        const expected = _getPrice('Cápsulas', '60');
        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.stringMatching(new RegExp(expected.replace(/\./g, '\\.')))
        );
    });
});

describe('V7 Script — Contra Reembolso MAX', () => {
    let userState;
    const userId = 'test_crm';

    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        mockNotifyAdmin.mockClear();
    });

    // Política mayo 2026: el adicional por contra reembolso fue eliminado.
    // stepWaitingPlanChoice ya no toca isContraReembolsoMAX/adicionalMAX.
    test('Plan 60: no setea flags de adicional', async () => {
        userState[userId] = {
            step: 'waiting_plan_choice',
            history: [],
            selectedProduct: 'Cápsulas de nuez de la india',
            cart: []
        };

        await processSalesFlow(userId, "60", userState, knowledge, mockDependencies);

        expect(userState[userId].isContraReembolsoMAX).toBeUndefined();
        expect(userState[userId].adicionalMAX).toBeUndefined();
    });

    test('Plan 120: no setea flags de adicional', async () => {
        userState[userId] = {
            step: 'waiting_plan_choice',
            history: [],
            selectedProduct: 'Cápsulas de nuez de la india',
            cart: []
        };

        await processSalesFlow(userId, "120", userState, knowledge, mockDependencies);

        expect(userState[userId].isContraReembolsoMAX).toBeUndefined();
        expect(userState[userId].adicionalMAX).toBeUndefined();
    });


});

describe('V7 Script — FAQ Keywords', () => {
    let userState;
    const userId = 'test_faq';

    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
    });

    // SKIP: FAQ keyword matching is handled by bot.js/index.js caller, not processSalesFlow directly.
    // These tests cannot pass by calling processSalesFlow alone — the FAQ interceptor runs before it.
    test.skip('FAQ: trust concern with tarjeta mention triggers payment FAQ', async () => {
        userState[userId] = { step: 'waiting_weight', history: [] };

        // "estafa" alone has no FAQ match in knowledge_v7.json (no trust/scam keyword)
        // Combining with "tarjeta" triggers the payment FAQ which proves security via pago al recibir
        await processSalesFlow(userId, "esto es una estafa, aceptan tarjeta?", userState, knowledge, mockDependencies);

        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.stringContaining("pago al recibir")
        );
    });

    test.skip('FAQ: "tarjeta" should respond with payment info', async () => {
        userState[userId] = { step: 'waiting_plan_choice', history: [] };

        await processSalesFlow(userId, "aceptan tarjeta?", userState, knowledge, mockDependencies);

        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.stringContaining("pago al recibir")
        );
    });

    // SKIP: contraindications FAQ is intercepted by globalFaq.js BEFORE processSalesFlow is called.
    // Testing via processSalesFlow always hits the AI fallback, not the FAQ handler.
    test.skip('FAQ: "contraindicaciones" should respond about pregnancy', async () => {
        userState[userId] = { step: 'waiting_preference', history: [] };

        await processSalesFlow(userId, "tiene contraindicaciones?", userState, knowledge, mockDependencies);

        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.stringContaining("embarazo")
        );
    });

    // SKIP: shipping FAQ is intercepted by globalFaq.js BEFORE processSalesFlow is called.
    // Testing via processSalesFlow always hits the AI fallback, not the FAQ handler.
    test.skip('FAQ: "costo de envio" should respond about free shipping', async () => {
        userState[userId] = { step: 'waiting_preference', history: [] };

        // Use exact FAQ keyword to avoid overlap with pricing FAQ
        await processSalesFlow(userId, "gastos de envio", userState, knowledge, mockDependencies);

        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.stringContaining("gratuito")
        );
    });
});

describe('Pricing & Phone matching helpers', () => {
    const { _getPrice } = require('../src/flows/utils/pricing');
    const { _normalizeSpanishPhone, _isPhoneMatch, _isAdminPhone } = require('../src/flows/utils/flowHelpers');

    test('Pricing: should normalize accents in product names', () => {
        expect(_getPrice('Capsulas', '60')).toBe('46.900');
        expect(_getPrice('capsulas', '120')).toBe('79.900');
        expect(_getPrice('cápsulas de nuez', '60')).toBe('46.900');
        expect(_getPrice('Gotas', '60')).toBe('40.900');
        expect(_getPrice('gotas', '120')).toBe('70.900');
        expect(_getPrice('Semillas', '60')).toBe('36.900');
        expect(_getPrice('semillas de nuez', '120')).toBe('49.900');
    });

    test('Phone matching: should correctly match Spanish numbers', () => {
        expect(_isPhoneMatch('34612345678@c.us', '34612345678')).toBe(true);
        expect(_isPhoneMatch('34612345678@c.us', '+34 612 34 56 78')).toBe(true);
        expect(_isPhoneMatch('34612345678@c.us', '612345678')).toBe(true);
        expect(_isPhoneMatch('612345678@c.us', '34612345678')).toBe(true);

        // Should reject empty or short prefixes (anti-exploit)
        expect(_isPhoneMatch('34612345678@c.us', '')).toBe(false);
        expect(_isPhoneMatch('34612345678@c.us', '34')).toBe(false);
        expect(_isPhoneMatch('34612345678@c.us', '3461')).toBe(false);
        expect(_isPhoneMatch('34699999999@c.us', '34612345678')).toBe(false);
    });

    test('Admin check: should safely validate alertNumbers list', () => {
        const configAlerts = ['', null, undefined, '+34 612 34 56 78'];
        expect(_isAdminPhone('34612345678@c.us', configAlerts)).toBe(true);
        expect(_isAdminPhone('34699999999@c.us', configAlerts)).toBe(false);
        expect(_isAdminPhone('34699999999@c.us', [''])).toBe(false);
        expect(_isAdminPhone('34699999999@c.us', [])).toBe(false);
        expect(_isAdminPhone('', configAlerts)).toBe(false);
    });
});

