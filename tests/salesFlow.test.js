const { processSalesFlow } = require('../src/flows/salesFlow');

// Mock dependencies
const mockClient = { sendMessage: jest.fn() };
const mockNotifyAdmin = jest.fn();
const mockSaveState = jest.fn();
const mockSendMessage = jest.fn();
const mockLogAndEmit = jest.fn();

// Mock AI Service
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn().mockResolvedValue({ response: "AI Response", goalMet: false }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn()
    }
}));
const { aiService } = require('../src/services/ai');

const deps = {
    client: mockClient,
    notifyAdmin: mockNotifyAdmin,
    saveState: mockSaveState,
    sendMessageWithDelay: mockSendMessage,
    logAndEmit: mockLogAndEmit
};

const knowledge = {
    flow: {
        greeting: { response: "Hola!", nextStep: "waiting_weight" },
        recommendation: { response: "Te recomiendo esto", nextStep: "waiting_preference" },
        preference_capsulas: { match: ["capsulas"], response: "Capsulas ok", nextStep: "waiting_price" },
        preference_semillas: { match: ["semillas"], response: "Semillas ok", nextStep: "waiting_price" }
    },
    faq: []
};

describe('Sales Flow Logic', () => {
    let userState;

    beforeEach(() => {
        userState = {};
        jest.clearAllMocks();
    });

    test('Should greet new user', async () => {
        await processSalesFlow('user1', 'Hola', userState, knowledge, deps);
        expect(userState['user1'].step).toBe('waiting_weight');
        expect(mockSendMessage).toHaveBeenCalledWith('user1', "Hola!");
    });

    test('Should handle preference selection', async () => {
        // Setup state
        userState['user1'] = { step: 'waiting_preference', history: [] };

        await processSalesFlow('user1', 'quiero capsulas', userState, knowledge, deps);

        expect(userState['user1'].selectedProduct).toContain("Cápsulas");
        expect(mockSendMessage).toHaveBeenCalledWith('user1', "Capsulas ok");
    });

    test('Should use AI for weight question', async () => {
        userState['user1'] = { step: 'waiting_weight', history: [] };
        aiService.chat.mockResolvedValueOnce({ response: "AI Says Hi", goalMet: true });

        await processSalesFlow('user1', 'bajar 5 kilos', userState, knowledge, deps);

        expect(aiService.chat).toHaveBeenCalled();
        expect(mockSendMessage).toHaveBeenCalledWith('user1', "Te recomiendo esto"); // Because goalMet=true triggers next step
    });
});
