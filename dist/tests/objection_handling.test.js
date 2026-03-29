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
// MOCK AI to return the specific response we expect for the objection
const mockAI = jest.fn().mockImplementation(async (text, context) => {
    const lower = text.toLowerCase();
    if (context.step === 'waiting_plan_choice' && (lower.includes('envio') || lower.includes('conviene'))) {
        return {
            response: "Entiendo que el costo de envío del plan de 60 días te haga dudar. La realidad es que el correo nos cobra el servicio de pago en destino por esos envíos. Por eso muchos eligen el de 120, porque ya trae el envío gratis y te rinde el doble. ¿Qué decís, probamos con el de 120 o querés que te anote el de 60 igual?",
            goalMet: false,
            extractedData: null
        };
    }
    return { response: "Respuesta genérica", goalMet: false, extractedData: null };
});
mockDependencies.aiService.chat = mockAI;
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: mockAI,
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn()
    }
}));
describe('Objection Handling in Sales Flow', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });
    test('Should handle shipping objection instead of jumping to address', async () => {
        const userId = 'test_objection_user';
        const userState = {
            [userId]: {
                step: 'waiting_plan_choice',
                selectedProduct: 'Cápsulas',
                history: [],
                partialAddress: {}
            }
        };
        const objectionText = "El de 60 no me combiene x el envio";
        await processSalesFlow(userId, objectionText, userState, knowledgeV4, mockDependencies);
        // Verification: The step should still be waiting_plan_choice, NOT waiting_data
        expect(userState[userId].step).toBe('waiting_plan_choice');
        expect(mockSendMessage).toHaveBeenCalledWith(userId, expect.stringContaining("envío"));
    });
    test('Should handle shipping schedule question with correct policy', async () => {
        const userId = 'test_schedule_user';
        const userState = {
            [userId]: {
                step: 'waiting_preference',
                history: [],
                partialAddress: {}
            }
        };
        const scheduleText = "Llegaría el envío en horario de tarde?";
        // Mock AI for this specific case
        mockAI.mockImplementationOnce(async (text, context) => {
            return {
                response: "No tenemos ningún control sobre los carteros del Correo Argentino, por lo que no podemos asegurar en qué horario pasará por tu domicilio. Pero quedate tranqui que monitoreamos el envío y si no te encuentran te avisamos en el acto para que lo retires por sucursal. ¿Con qué producto avanzamos?",
                goalMet: false,
                extractedData: null
            };
        });
        await processSalesFlow(userId, scheduleText, userState, knowledgeV4, mockDependencies);
        expect(mockSendMessage).toHaveBeenCalledWith(userId, expect.stringContaining("No tenemos ningún control"));
        expect(userState[userId].step).toBe('waiting_preference');
    });
});
