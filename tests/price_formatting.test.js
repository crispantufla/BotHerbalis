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
    sharedState: { io: { emit: jest.fn() }, pausedUsers: new Set() }
};

// LOAD KNOWLEDGE V3 (Primary test target)
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '../knowledge_v3.json'), 'utf8'));

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

describe('V3 Script — Price Centralization', () => {
    let userState;
    const userId = 'test_price';

    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
    });

    test('Should replace {{PRICE_...}} placeholders with real values (Semillas via preference)', async () => {
        userState[userId] = { step: 'waiting_preference', history: [] };

        // User picks semillas => V3 shows prices directly in the preference response
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

    test('Should show updated Cápsulas 60 price ($46.900)', async () => {
        userState[userId] = { step: 'waiting_preference', history: [] };

        // User picks capsulas => V3 shows prices directly in the preference response
        await processSalesFlow(userId, "capsulas", userState, knowledge, mockDependencies);

        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.stringMatching(/46\.900/)
        );
    });
});

describe('V3 Script — Contra Reembolso MAX', () => {
    let userState;
    const userId = 'test_crm';

    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        mockNotifyAdmin.mockClear();
    });

    test('Plan 60 should set isContraReembolsoMAX = true and adicionalMAX = 6000', async () => {
        userState[userId] = {
            step: 'waiting_plan_choice',
            history: [],
            selectedProduct: 'Cápsulas de nuez de la india',
            cart: []
        };

        await processSalesFlow(userId, "60", userState, knowledge, mockDependencies);

        expect(userState[userId].isContraReembolsoMAX).toBe(true);
        expect(userState[userId].adicionalMAX).toBe(6000);
    });

    test('Plan 120 should set isContraReembolsoMAX = false and adicionalMAX = 0', async () => {
        userState[userId] = {
            step: 'waiting_plan_choice',
            history: [],
            selectedProduct: 'Cápsulas de nuez de la india',
            cart: []
        };

        await processSalesFlow(userId, "120", userState, knowledge, mockDependencies);

        expect(userState[userId].isContraReembolsoMAX).toBe(false);
        expect(userState[userId].adicionalMAX).toBe(0);
    });


});

describe('V3 Script — FAQ Keywords', () => {
    let userState;
    const userId = 'test_faq';

    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
    });

    test('FAQ: "estafa" should trigger trust response', async () => {
        userState[userId] = { step: 'waiting_weight', history: [] };

        await processSalesFlow(userId, "esto es una estafa", userState, knowledge, mockDependencies);

        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.stringContaining("pago al recibir")
        );
    });

    test('FAQ: "tarjeta" should respond with payment info', async () => {
        userState[userId] = { step: 'waiting_plan_choice', history: [] };

        await processSalesFlow(userId, "aceptan tarjeta?", userState, knowledge, mockDependencies);

        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.stringContaining("pago al recibir")
        );
    });

    test('FAQ: "contraindicaciones" should respond about pregnancy', async () => {
        userState[userId] = { step: 'waiting_preference', history: [] };

        await processSalesFlow(userId, "tiene contraindicaciones?", userState, knowledge, mockDependencies);

        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.stringContaining("embarazo")
        );
    });

    test('FAQ: "costo de envio" should respond about free shipping', async () => {
        userState[userId] = { step: 'waiting_preference', history: [] };

        // Use exact FAQ keyword to avoid overlap with pricing FAQ
        await processSalesFlow(userId, "gastos de envio", userState, knowledge, mockDependencies);

        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.stringContaining("gratuito")
        );
    });
});
