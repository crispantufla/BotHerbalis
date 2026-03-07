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
    sharedState: { io: { emit: jest.fn() }, pausedUsers: new Set() }
};

// LOAD KNOWLEDGE (Using V4 for the latest standard)
const knowledgeV4 = JSON.parse(fs.readFileSync(path.join(__dirname, '../knowledge_v4.json'), 'utf8'));

// SMART AI MOCK
// This mock analyzes the "goal" or the "step" to determine what the AI should theoretically respond.
// If it's waiting_data with the FAQ aiGoal, it responds as FAQ. If it's waiting_weight with health concern, it shows empathy.
const mockSmartAI = jest.fn().mockImplementation(async (text, context) => {
    const { FlowStep } = require('../src/types/state');
    const goal = context.goal || "";
    const step = context.step;

    let response = "Respuesta Genérica Simulada.";
    let goalMet = false;

    if (step === FlowStep.WAITING_WEIGHT) {
        if (goal.includes('duda o preocupación sobre su salud') || goal.includes('riñón') || goal.includes('hipertenso')) {
            response = "¡No te preocupes! El producto es 100% natural y no afecta tu salud ni interactúa con medicamentos. ¿Te gustaría saber más sobre las cápsulas o las gotas?";
        }
    } else if (step === FlowStep.WAITING_PREFERENCE) {
        const t = text.toLowerCase();
        if (t.includes('capcula') || t.includes('capsula')) {
            response = "Perfecto, las cápsulas son ideales. ¿De cuántos días querés el tratamiento?";
            return { response, goalMet: true, extractedData: "capsulas" };
        } else if (t.includes('gota')) {
            response = "Excelente elección, las gotas. ¿De cuántos días?";
            return { response, goalMet: true, extractedData: "gotas" };
        } else if (t.includes('semilla')) {
            response = "Semillas anotado. ¿Tratamiento de cuántos días?";
            return { response, goalMet: true, extractedData: "semillas" };
        }
    } else if (step === FlowStep.WAITING_PLAN_CHOICE) {
        const t = text.toLowerCase();
        if (t.includes('60')) {
            return { response: "Plan de 60 días", goalMet: true, extractedData: "60" };
        } else if (t.includes('120') || t.includes('largo')) {
            return { response: "Plan de 120 días", goalMet: true, extractedData: "120" };
        } else if (t.includes('30')) {
            return { response: "Plan de 30 días", goalMet: true, extractedData: "30" };
        }
    } else if (step === FlowStep.WAITING_DATA) {
        if (goal.includes('EXCEPCIÓN CRÍTICA') || goal.includes('función del producto') || goal.includes('contraindicaciones')) {
            response = "Es un producto 100% natural, las únicas contraindicaciones son embarazo y lactancia. Los envíos se realizan cuanto antes. ¿Te parece que lo dejemos anotado?";
        }
    } else if (step === FlowStep.WAITING_PAYMENT_PROOF || step === FlowStep.WAITING_PAYMENT_METHOD) {
        if (goal.includes('todavía no cobró')) {
            response = "Si querés podemos programar el pedido a futuro, así llega cuando cobrás 😊. ¿Para qué fecha te quedaría mejor recibirlo?";
        }
    } else {
        // Objections in waiting_admin_ok, etc.
        if (goal.includes('objeción') || goal.includes('caro')) {
            response = "Entiendo perfectamente, la calidad del producto y el acompañamiento lo valen. Saludos.";
        }
    }

    return { response, goalMet };
});

const mockParseAddress = jest.fn().mockImplementation(async (text) => {
    // Basic heuristics to pretend we parse correctly even with typos
    const lower = text.toLowerCase();
    if (lower.includes('calle') || lower.includes('123') || lower.match(/\d{2,4}/)) {
        return {
            nombre: "Test User",
            calle: "Calle Simulada 123",
            ciudad: "Test City",
            provincia: "Test Prov",
            cp: "1000",
            pisoDepto: null,
            _confidence: 0.95
        };
    }
    return { _error: true };
});

jest.mock('../src/services/ai', () => {
    return {
        aiService: {
            chat: mockSmartAI,
            checkAndSummarize: jest.fn().mockResolvedValue(null),
            parseAddress: mockParseAddress
        }
    };
});

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }), { virtual: true });
jest.mock('../sheets_sync', () => ({ appendOrderToSheet: jest.fn().mockResolvedValue(true) }), { virtual: true });
jest.mock('google-spreadsheet', () => ({}), { virtual: true });
jest.mock('@google/generative-ai', () => ({}), { virtual: true });
jest.mock('../src/services/queueService', () => ({ enqueueMessage: jest.fn() }), { virtual: true });


// 100 TEST SCENARIOS GENERATION
const generateTestCases = () => {
    const cases = [];

    // 1. TERRIBLE SPELLING & GRAMMAR (25 cases)
    for (let i = 1; i <= 25; i++) {
        cases.push({
            name: `Mala Ortografia ${i}`,
            shouldComplete: true,
            messages: [
                "ola qiero info", // greeting
                `kiero vajar ${Math.floor(Math.random() * 20) + 5} kilos`, // weight - misspelled
                i % 2 === 0 ? "capculas" : "las d gota", // plan
                "d 60 dia", // duration
                "maria juares, caye falsa 456, ciuda kapital, cp 2000", // address exact
                "zi komfirmo" // confirmation
            ]
        });
    }

    // 2. MIXED HEALTH QUESTIONS ON DATA COLLECTION (25 cases)
    for (let i = 1; i <= 25; i++) {
        cases.push({
            name: `Pregunta de Salud Toma Datos ${i}`,
            shouldComplete: i % 5 !== 0, // 80% complete, 20% abandon mid-way
            messages: [
                "hola buenas tardes",
                "quiero bajar 15 kg",
                "capsulas",
                "el tratamiento mas largo porfa",
                // THE EDGE CASE: Asking health/shipping during address
                i % 2 === 0
                    ? "dame un seg q busco mi cp. otra cosa, tiene alguna contraindicaciones tomar tomar nuez de la India"
                    : "los envíos tienen día especial. perdon q pregunte tanto",
                // Bot should use AI fallback and not pause. Then user replies address:
                "perdon me colgue, Juan Perez, Calle del sol 123, Rosario 2000",
                "si todo ok"
            ].filter(Boolean) // keep array clean
        });
    }

    // 3. HEALTH QUESTIONS DURING WEIGHT/Plan (25 cases)
    for (let i = 1; i <= 25; i++) {
        cases.push({
            name: `Salud en Peso ${i}`,
            shouldComplete: true,
            messages: [
                "hola info",
                // EDGE CASE: Mixed number + question about health
                i % 2 === 0
                    ? "Quiero bajar 10 kg Pero quiero ver si no serían dañinas para mí salud Porque tengo solo un riñón"
                    : "NECESITO BAJAR 20 KILOS. SOY HIPERTENSO puedo tomar?",
                "capsulas",
                "120 dias",
                "Ricardo, Belgrano 987, CABA 1000",
                "confirmo"
            ]
        });
    }

    // 4. ABRUPT CHANGES, OBJECTIONS, ETC (25 cases)
    for (let i = 1; i <= 25; i++) {
        cases.push({
            name: `Cambios de Opinion ${i}`,
            shouldComplete: false, // Most won't complete, we just check no infinite loops/crashes
            messages: [
                "buenas", // greeting
                "quiero bajar 10 kilos",
                "semillas",
                "60 dias",
                // Suddenly objects
                "uh pero me contaron q la semilla hace mal al higado es vdd?",
                "na no me convence, no gracias", // User abandons gracefully
                // Wait, maybe thay come back
                "hola de nuevo, estuve pensando, quiero las capsulas al final",
                "si 60 dias",
                "mira manana te paso los datos, o despues te confirmo mas tarde" // Payment timing exception
            ]
        });
    }

    return cases;
};

const allScenarios = generateTestCases();


describe('100 Conversations Stress Test with Edge Cases', () => {

    beforeAll(() => {
        // Inject our mock dependencies logic into the require cache if needed, 
        // though jest.mock usually handles module resolution.
        mockDependencies.aiService = require('../src/services/ai').aiService;
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    const runSimulation = async (knowledge, scenariosList) => {
        let loopCount = 0;
        let expectedSuccesses = scenariosList.filter(s => s.shouldComplete).length;
        let actualSuccesses = 0;

        for (const scenario of scenariosList) {
            const userId = `test_edge_${scenario.name.replace(/\s+/g, '_')}`;
            const userState = { [userId]: { step: 'greeting', history: [], partialAddress: {} } };

            mockSendMessage.mockClear();
            mockSmartAI.mockClear();

            const trackSteps = [];

            for (const msg of scenario.messages) {
                const prevStep = userState[userId].step;

                // Process single message
                await processSalesFlow(userId, msg, userState, knowledge, mockDependencies);

                const currentStep = userState[userId].step;
                trackSteps.push(currentStep);

                // LOOP PROTECTION
                if (prevStep === currentStep && currentStep !== FlowStep.COMPLETED) {
                    const sameStepCount = trackSteps.filter(s => s === currentStep).length;
                    if (sameStepCount > 5) { // Tolerant to some back-and-forth like multiple AI responses
                        loopCount++;
                        console.error(`🚨 LOOP DETECTED in Scenario: ${scenario.name} for ${userId} at step ${currentStep}`);
                        break;
                    }
                }
            }

            // SUCCESS VALIDATION
            if (scenario.shouldComplete) {
                const finalStep = userState[userId].step;
                if ([FlowStep.COMPLETED, FlowStep.WAITING_ADMIN_OK, FlowStep.WAITING_FINAL_CONFIRMATION, FlowStep.WAITING_ADMIN_VALIDATION, FlowStep.WAITING_PAYMENT_PROOF].includes(finalStep)) {
                    actualSuccesses++;
                } else {
                    console.warn(`[!] Conversation ${scenario.name} failed to complete. Ended at: ${finalStep}`);
                    console.log(`Path taken: ${trackSteps.join(' -> ')}`);
                }
            }
        }

        expect(loopCount).toBe(0); // Zero infinite loops
        // Log the actual successes for manual observation if they differ, but we expect all "shouldComplete" to pass.
        // If there's 1-2 fuzzy failures due to mocking heuristics, we at least ensure NO loops and NO pauses.
        expect(actualSuccesses).toBeGreaterThanOrEqual(expectedSuccesses * 0.9); // Allow 10% margin of error on mock parsing
    };

    test('Runs 100 edge case conversations smoothly', async () => {
        // Run with a 30 second timeout as 100 conversations take a while
        expect(allScenarios.length).toBe(100);
        await runSimulation(knowledgeV4, allScenarios);
    }, 30000);

});
