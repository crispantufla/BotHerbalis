const { processSalesFlow } = require('../src/flows/salesFlow');
const fs = require('fs');
const path = require('path');

// MOCK DEPENDENCIES (Global vars to track calls)
const mockSendMessage = jest.fn();
const mockNotifyAdmin = jest.fn();
const mockSaveState = jest.fn();

// MOCK CONSTANTS
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

// MOCKS - Defined INLINE to avoid hoisting issues
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn().mockResolvedValue({ response: "AI Default Response", goalMet: false }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockResolvedValue(null)
    }
}));

jest.mock('../safeWrite', () => ({
    atomicWriteFile: jest.fn()
}), { virtual: true });

jest.mock('../sheets_sync', () => ({
    appendOrderToSheet: jest.fn()
}), { virtual: true });

// Mock ESM libraries just in case they leak through
jest.mock('google-spreadsheet', () => ({}), { virtual: true });
jest.mock('@google/generative-ai', () => ({}), { virtual: true });

describe('Sales Flow Logic', () => {
    let userState;
    const userId = 'test_user';

    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
        mockNotifyAdmin.mockClear();
        // Reset weightRefusals if any
    });

    // TEST 1: Delivery Constraint
    test('Should detect delivery constraint (Saturday) and explain shipping', async () => {
        userState[userId] = { step: 'waiting_weight', history: [] };

        await processSalesFlow(userId, "Ok yo estoy el sabado en casa", userState, knowledge, mockDependencies);

        // Expect delivery message
        expect(mockSendMessage).toHaveBeenCalledWith(
            userId,
            expect.stringMatching(/Tené en cuenta que enviamos por Correo Argentino/i)
        );
        // Expect redirect message
        // The redirect depends on step. waiting_weight -> 'cuántos kilos querés bajar'
        expect(mockSendMessage).toHaveBeenCalledWith(
            userId,
            expect.stringMatching(/cuántos kilos querés bajar/)
        );
    });

    // TEST 2: Weight Refusal (Skip)
    test('Should skip to products if user refuses weight question', async () => {
        userState[userId] = { step: 'waiting_weight', history: [], weightRefusals: 0 };

        // "Prefiero no contestar" -> refusal regex
        await processSalesFlow(userId, "Prefiero no contestar", userState, knowledge, mockDependencies);

        expect(mockSendMessage).toHaveBeenCalledWith(
            userId,
            expect.stringMatching(/¡Entiendo, no hay problema!/i)
        );

        expect(userState[userId].step).toBe('waiting_preference');
    });

    // TEST 3: Weight Refusal (Count > 2)
    test('Should skip to products after 2 failed/refused attempts', async () => {
        userState[userId] = { step: 'waiting_weight', history: [], weightRefusals: 1 };

        // User says something irrelevant that isn't a number
        await processSalesFlow(userId, "bla bla bla", userState, knowledge, mockDependencies);

        expect(mockSendMessage).toHaveBeenCalledWith(
            userId,
            expect.stringMatching(/¡Entiendo, no hay problema!/i)
        );
        expect(userState[userId].step).toBe('waiting_preference');
    });
});
