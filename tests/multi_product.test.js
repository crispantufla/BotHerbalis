const { processSalesFlow } = require('../src/flows/salesFlow');
const fs = require('fs');
const path = require('path');

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

// LOAD KNOWLEDGE
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
jest.mock('@google/generative-ai', () => ({}), { virtual: true });

describe('Multi-Product Logic', () => {
    let userState;
    const userId = 'test_multi';

    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
    });

    // TEST 1: Single Product (Regression)
    test('Should handle single product selection correctly', async () => {
        userState[userId] = {
            step: 'waiting_plan_choice',
            history: [],
            selectedProduct: "Cápsulas"
        };

        await processSalesFlow(userId, "quiero el plan de 60 dias", userState, knowledge, mockDependencies);

        expect(userState[userId].cart).toHaveLength(1);
        expect(userState[userId].cart[0]).toMatchObject({
            product: 'Cápsulas',
            plan: '60'
        });
        // Expect closing message

        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.stringMatching(/etiqueta/i)
        );
    });

    // TEST 2: Mixed Order Parsing
    test('Should parse mixed order (120 capsulas y 60 semillas)', async () => {
        userState[userId] = { step: 'waiting_plan_choice', history: [] };

        // Complex message
        const text = "y si quiero 120 dias de capsulas y 60 de nueces?";
        await processSalesFlow(userId, text, userState, knowledge, mockDependencies);

        // Should detect 2 items
        expect(userState[userId].cart).toHaveLength(2);

        // Check Item 1: 120 Cápsulas
        const item1 = userState[userId].cart.find(i => i.product === 'Cápsulas');
        expect(item1).toBeDefined();
        expect(item1.plan).toBe('120');

        // Check Item 2: 60 Semillas (matched from "nueces")
        const item2 = userState[userId].cart.find(i => i.product === 'Semillas');
        expect(item2).toBeDefined();
        expect(item2.plan).toBe('60');

        // Expect closing message

        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.stringMatching(/etiqueta/i)
        );
    });
});
