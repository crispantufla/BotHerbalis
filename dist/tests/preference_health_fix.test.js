const { processSalesFlow } = require('../src/flows/salesFlow');
const fs = require('fs');
const path = require('path');
const { FlowStep } = require('../src/types/state');
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
    aiService: {
        chat: jest.fn(),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn()
    }
};
const knowledgeV4 = JSON.parse(fs.readFileSync(path.join(__dirname, '../knowledge_v4.json'), 'utf8'));
// MOCK AI to return health advice
const mockAI = jest.fn().mockImplementation(async (text, context) => {
    return {
        response: "Entiendo perfectamente tu consulta sobre la pre-diabetes. El producto es 100% natural y no interfiere con la glucosa, de hecho ayuda a regular el metabolismo. ¿Te gustaría avanzar con las gotas que elegiste?",
        goalMet: true, // Should be true if it handles both
        extractedData: "PRODUCTO: Gotas de nuez de la india"
    };
});
mockDependencies.aiService.chat = mockAI;
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: mockAI,
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn()
    }
}));
describe('Health Question during Preference Step', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });
    test('Should prioritize AI handling when a health question is asked alongside a product', async () => {
        const userId = 'test_health_user';
        const userState = {
            [userId]: {
                step: 'waiting_preference',
                history: [],
                partialAddress: {}
            }
        };
        const text = "Soy pre diabetica hay contraindicacion? Gotas";
        await processSalesFlow(userId, text, userState, knowledgeV4, mockDependencies);
        // It should have hit AI
        expect(mockAI).toHaveBeenCalled();
        // It should have sent the AI response (addressing diabetes)
        expect(mockSendMessage).toHaveBeenCalledWith(userId, expect.stringContaining("pre-diabetes"));
        // AND it should have reached the funnel response for Gotas
        expect(mockSendMessage).toHaveBeenCalledWith(userId, expect.stringContaining("discretas y se absorben rápido"));
    });
});
