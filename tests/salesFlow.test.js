
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

const sharedState = {
    pausedUsers: new Set(),
    io: null
};

const deps = {
    client: mockClient,
    notifyAdmin: mockNotifyAdmin,
    saveState: mockSaveState,
    sendMessageWithDelay: mockSendMessage,
    logAndEmit: mockLogAndEmit,
    sharedState
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
        sharedState.pausedUsers = new Set();
        jest.clearAllMocks();
    });

    test('Should greet new user', async () => {
        await processSalesFlow('user1', 'Hola', userState, knowledge, deps);
        expect(userState['user1'].step).toBe('waiting_weight');
        expect(mockSendMessage).toHaveBeenCalledWith('user1', "Hola!");
    });

    test('Should handle preference selection (Normalization)', async () => {
        userState['user1'] = { step: 'waiting_preference', history: [] };
        await processSalesFlow('user1', 'quiero Cápsulas por favor', userState, knowledge, deps);

        expect(userState['user1'].selectedProduct).toContain("Cápsulas");
        expect(mockSendMessage).toHaveBeenCalledWith('user1', "Capsulas ok");
    });

    test('Should NOT match partial words (False Positive Check)', async () => {
        userState['user1'] = { step: 'waiting_preference', history: [] };
        aiService.chat.mockResolvedValueOnce({ response: "No vendemos leche", goalMet: false });

        await processSalesFlow('user1', 'tengo leche?', userState, knowledge, deps);

        expect(userState['user1'].selectedProduct).toBeUndefined();
        expect(aiService.chat).toHaveBeenCalled();
        expect(mockSendMessage).toHaveBeenCalledWith('user1', "No vendemos leche");
    });

    test('Should match exact "Te" for Semillas', async () => {
        userState['user1'] = { step: 'waiting_preference', history: [] };
        await processSalesFlow('user1', 'quiero te', userState, knowledge, deps);

        expect(userState['user1'].selectedProduct).toContain("Semillas");
        expect(mockSendMessage).toHaveBeenCalledWith('user1', "Semillas ok");
    });

    test('Should use SCRIPT (not AI) when user gives a number for weight', async () => {
        userState['user1'] = { step: 'waiting_weight', history: [] };

        await processSalesFlow('user1', 'bajar 5 kilos', userState, knowledge, deps);

        // With the new script-first logic, a number should trigger the scripted response directly
        expect(aiService.chat).not.toHaveBeenCalled();
        expect(mockSendMessage).toHaveBeenCalledWith('user1', "Te recomiendo esto");
    });

    test('Should use AI fallback when no number given for weight', async () => {
        userState['user1'] = { step: 'waiting_weight', history: [] };
        aiService.chat.mockResolvedValueOnce({ response: "¿Cuántos kilos querés bajar?", goalMet: false });

        await processSalesFlow('user1', 'quiero adelgazar', userState, knowledge, deps);

        expect(aiService.chat).toHaveBeenCalled();
        expect(mockSendMessage).toHaveBeenCalledWith('user1', "¿Cuántos kilos querés bajar?");
    });

    test('Should pause and alert admin when bot cannot handle message', async () => {
        userState['user1'] = { step: 'waiting_legal_acceptance', history: [] };

        await processSalesFlow('user1', 'algo totalmente random', userState, knowledge, deps);

        // Should have paused the user
        expect(sharedState.pausedUsers.has('user1')).toBe(true);
        // Should have notified admin
        expect(mockNotifyAdmin).toHaveBeenCalledWith(
            expect.stringContaining('PAUSADO'),
            'user1',
            expect.any(String)
        );
    });
});
