
// Mock dependencies BEFORE requiring the module under test
const mockClient = { sendMessage: jest.fn() };
const mockNotifyAdmin = jest.fn();
const mockSaveState = jest.fn();
const mockSendMessage = jest.fn();
const mockLogAndEmit = jest.fn();

// Mock sheets_sync to avoid ESM issues
jest.mock('../sheets_sync', () => ({
    appendOrderToSheet: jest.fn().mockResolvedValue(true)
}));

// Mock safeWrite
jest.mock('../safeWrite', () => ({
    atomicWriteFile: jest.fn()
}));

// Mock AI Service with better stubs
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn().mockResolvedValue({ response: "AI Default Response", goalMet: false }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockResolvedValue({})
    }
}));

const { processSalesFlow } = require('../src/flows/salesFlow');
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
        preference_capsulas: { match: ["capsulas", "gotas"], response: "Capsulas ok", nextStep: "waiting_price" },
        preference_semillas: { match: ["semillas", "te", "té"], response: "Semillas ok", nextStep: "waiting_price" },
        price_capsulas: { response: "Precio Capsulas $100", nextStep: "waiting_plan_choice" },
        price_semillas: { response: "Precio Semillas $80", nextStep: "waiting_plan_choice" },
        closing: { response: "Cierre", nextStep: "waiting_ok" }
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

    test('Should handle preference selection (Normalization)', async () => {
        // Setup state
        userState['user1'] = { step: 'waiting_preference', history: [] };

        // Input with accent "Cápsulas" should match "capsulas"
        await processSalesFlow('user1', 'quiero Cápsulas por favor', userState, knowledge, deps);

        expect(userState['user1'].selectedProduct).toContain("Cápsulas");
        expect(mockSendMessage).toHaveBeenCalledWith('user1', "Capsulas ok");
    });

    test('Should NOT match partial words (False Positive Check)', async () => {
        // Setup state
        userState['user1'] = { step: 'waiting_preference', history: [] };

        // "Leche" contains "te", but it shouldn't match "te" keyword due to \b boundary
        // We mock AI to return a specific response so we know it fell back to AI
        aiService.chat.mockResolvedValueOnce({ response: "No vendemos leche", goalMet: false });

        await processSalesFlow('user1', 'tengo leche?', userState, knowledge, deps);

        // Should NOT match semillas
        expect(userState['user1'].selectedProduct).toBeUndefined();
        // Should have called AI
        expect(aiService.chat).toHaveBeenCalled();
        expect(mockSendMessage).toHaveBeenCalledWith('user1', "No vendemos leche");
    });

    test('Should match exact "Te" for Semillas', async () => {
        userState['user1'] = { step: 'waiting_preference', history: [] };

        await processSalesFlow('user1', 'quiero te', userState, knowledge, deps);

        expect(userState['user1'].selectedProduct).toContain("Semillas");
        expect(mockSendMessage).toHaveBeenCalledWith('user1', "Semillas ok");
    });

    test('Should use AI for weight question', async () => {
        userState['user1'] = { step: 'waiting_weight', history: [] };
        aiService.chat.mockResolvedValueOnce({ response: "AI Says Hi", goalMet: true });

        await processSalesFlow('user1', 'bajar 5 kilos', userState, knowledge, deps);

        expect(aiService.chat).toHaveBeenCalled();
        expect(mockSendMessage).toHaveBeenCalledWith('user1', "Te recomiendo esto"); // Because goalMet=true triggers next step
    });
});
