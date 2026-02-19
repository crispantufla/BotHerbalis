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
        chat: jest.fn().mockImplementation(async (text, context) => {
            // Mock AI response for recommendation
            if (context.step === 'waiting_preference_consultation') {
                return { response: "AI CONSULTATION RESPONSE", goalMet: true };
            }
            return { response: "AI Default", goalMet: false };
        }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockResolvedValue(null)
    }
}));

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }), { virtual: true });
jest.mock('../sheets_sync', () => ({ appendOrderToSheet: jest.fn() }), { virtual: true });
jest.mock('google-spreadsheet', () => ({}), { virtual: true });
jest.mock('openai', () => { return jest.fn().mockImplementation(() => ({})); }, { virtual: true });

describe('Product Recommendation Logic', () => {
    let userState;
    const userId = 'test_rec';

    beforeEach(() => {
        userState = {};
        mockSendMessage.mockClear();
    });

    test('Should trigger consultation for "Estoy entre gotas y semillas"', async () => {
        userState[userId] = { step: 'waiting_preference', history: [] };

        // This input mentions "gotas" and "semillas" -> Multiple mentions
        await processSalesFlow(userId, "Estoy entre las gotas y las semillas", userState, knowledge, mockDependencies);

        // Expect AI consultation response
        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, "AI CONSULTATION RESPONSE"
        );

        // Step should remain waiting_preference (or stay same to catch next input)
        // My implementation says: "Stay in waiting_preference to catch the final choice next"
        // and doesn't call _setStep. So step remains 'waiting_preference'.
        expect(userState[userId].step).toBe('waiting_preference');
    });

    test('Should trigger consultation for "Cual es mejor?"', async () => {
        userState[userId] = { step: 'waiting_preference', history: [] };

        await processSalesFlow(userId, "Cual es mejor?", userState, knowledge, mockDependencies);

        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, "AI CONSULTATION RESPONSE"
        );
    });

    test('Should select CAPSULAS directly if only capsulas mentioned', async () => {
        userState[userId] = { step: 'waiting_preference', history: [] };

        await processSalesFlow(userId, "prefiero capsulas", userState, knowledge, mockDependencies);

        expect(mockSendMessage).toHaveBeenCalledWith(
            userId, expect.stringMatching(/Cápsulas es la mejor opción/i)
        );
    });

    test('Should NOT trigger payment FAQ for address with "pampa"', async () => {
        // "pampa" contains "mp". Ancient bug triggered "Only cash on delivery" response.
        const addressText = "Calle Falsa 123, La Pampa, CP 6300";
        userState[userId] = {
            step: 'waiting_data',
            history: [],
            selectedProduct: 'Semillas',
            selectedPlan: '60',
            partialAddress: {}
        };

        // We expect this to be processed as address data, NOT as FAQ.
        // It should call aiService.parseAddress (which we mocked to return null by default in this file,
        // so it might fall through to "Thanks! I have some data" or similar, 
        // BUT definitely NOT the payment FAQ response "Por el momento trabajamos únicamente con pago al recibir").

        await processSalesFlow(userId, addressText, userState, knowledge, mockDependencies);

        // Check that sent message does NOT contain the FAQ response
        // FAQ response for "mp" is: "Por el momento trabajamos únicamente con pago al recibir"
        expect(mockSendMessage).not.toHaveBeenCalledWith(
            userId, expect.stringContaining("únicamente con pago al recibir")
        );
    });
});
