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

// LOAD KNOWLEDGE (Real file with placeholders)
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '../knowledge.json'), 'utf8'));

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

describe('Price Centralization', () => {
    let userState;
    const userId = 'test_price';

    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
    });

    // TEST 1: Verify Price Formatting
    test('Should replace {{PRICE_...}} placeholders with real values', async () => {
        userState[userId] = { step: 'waiting_price_confirmation', history: [], selectedProduct: 'Semillas' };

        // User asks for price
        await processSalesFlow(userId, "precio", userState, knowledge, mockDependencies);

        // Expect message to contain real numbers, NOT placeholders
        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.not.stringMatching(/{{PRICE_/)
        );

        // Expect specific price for Semillas 60 days
        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.stringMatching(/36\.900/)
        );
    });
});
