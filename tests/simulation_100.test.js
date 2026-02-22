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
const knowledgeV3 = JSON.parse(fs.readFileSync(path.join(__dirname, '../knowledge_v3.json'), 'utf8'));
const knowledgeV4 = JSON.parse(fs.readFileSync(path.join(__dirname, '../knowledge_v4.json'), 'utf8'));

// MOCKS
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn().mockResolvedValue({ response: "AI Default Response", goalMet: false }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockImplementation(async (text) => {
            // Mock a successful address extraction if the text looks like an address
            const lower = text.toLowerCase();
            if (lower.includes('calle') || lower.includes('123') || lower.includes('san martin')) {
                return { nombre: "Test User", calle: "Calle Falsa 123", ciudad: "Test City", provincia: "Test Prov", cp: "1000" };
            }
            return { _error: true };
        })
    }
}));

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }), { virtual: true });
jest.mock('../sheets_sync', () => ({ appendOrderToSheet: jest.fn().mockResolvedValue(true) }), { virtual: true });
jest.mock('google-spreadsheet', () => ({}), { virtual: true });
jest.mock('@google/generative-ai', () => ({}), { virtual: true });

describe('100 Conversations Simulation (V3 & V4)', () => {

    // Different buyer personas
    const scenarios = [
        {
            name: "Ideal",
            shouldComplete: true,
            messages: [
                "hola quiero bajar de peso",        // -> waiting_weight
                "quiero bajar 10 kilos",            // -> waiting_preference
                "quiero capsulas",                  // -> waiting_plan_choice
                "120 dias por favor",               // -> waiting_data
                "Juan Perez, Calle Falsa 123, Ciudad, 1000", // -> completed
                "si confirmo"                       // -> remains completed
            ]
        },
        {
            name: "Comprador Postdatado",
            shouldComplete: false, // Might pause or loop out, we just want NO infinite loops
            messages: [
                "hola",
                "quiero bajar 5 kilos",
                "las gotas",
                "plan de 60 dias",
                "te puedo pagar a fin de mes? ahora ando corto de efectivo",
                "dale yo te aviso"
            ]
        },
        {
            name: "Usuario con Dudas",
            shouldComplete: true,
            messages: [
                "buenas tardes",
                "necesito bajar 8 kilos",
                "pero una consulta, esto tiene efecto rebote?", // Doubt
                "y tiene alguna contraindicacion para hipertensos?", // Doubt
                "bueno probemos con las capsulas",
                "dale el de 120 dias",
                "Maria Lopez, San Martin 456, Cordoba, 5000",
                "si, todo correcto"
            ]
        },
        {
            name: "Cambio de Producto a la Mitad",
            shouldComplete: true,
            messages: [
                "hola",
                "tengo que bajar 20 kilos",
                "quiero comprar las semillas",
                "uy no espera, pensandolo bien prefiero las capsulas. se puede cambiar?", // Product change resets step
                "quiero las capsulas", // explicitly select the new product
                "el tratamiento completo de 120 dias",
                "Pedro Gomez, Calle Lima 12, Mendoza, 5500",
                "ok confirmo"
            ]
        },
        {
            name: "Negativa Amable",
            shouldComplete: false,
            messages: [
                "hola info",
                "no en realidad solo miraba, no quiero bajar nada",
                "esta muy caro, gracias por la info lo voy a pensar",
                "chau"
            ]
        }
    ];

    const runSimulation = async (knowledge, versionLabel, count) => {
        let loopCount = 0;
        let expectedSuccesses = 0;
        let actualSuccesses = 0;

        for (let i = 0; i < count; i++) {
            // Pick a scenario (robin-round or random, let's do robin-round for determinism)
            const scenario = scenarios[i % scenarios.length];
            const userId = `user_${versionLabel}_${scenario.name.replace(/\s+/g, '')}_${i}`;
            const userState = { [userId]: { step: 'greeting', history: [], partialAddress: {} } };

            if (scenario.shouldComplete) expectedSuccesses++;

            mockSendMessage.mockClear();
            const trackSteps = [];

            for (const msg of scenario.messages) {
                const prevStep = userState[userId].step;

                // MOCK AI response if it's a doubt or chat (to prevent failing checks inside AI logic)
                require('../src/services/ai').aiService.chat.mockResolvedValueOnce({
                    response: "Respuesta simulada de la IA para manejar tu duda o charla.",
                    goalMet: false
                });

                await processSalesFlow(userId, msg, userState, knowledge, mockDependencies);

                const currentStep = userState[userId].step;
                trackSteps.push(currentStep);

                // Anti-Loop Logic: If stays in same step 4 times in a row, loop detected.
                if (prevStep === currentStep && currentStep !== 'completed') {
                    const sameStepCount = trackSteps.filter(s => s === currentStep).length;
                    if (sameStepCount > 4) {
                        loopCount++;
                        console.error(`🚨 LOOP DETECTED in ${versionLabel} [Scenario: ${scenario.name}] for ${userId} at step ${currentStep}`);
                        break;
                    }
                }
            }

            // Verify final state for those that SHOULD complete
            if (scenario.shouldComplete) {
                if (userState[userId].step === 'completed' || userState[userId].step === 'waiting_admin_ok') {
                    actualSuccesses++;
                } else {
                    console.warn(`⚠️ Conversation ${userId} failed to complete. Ended at: ${userState[userId].step}`);
                    console.log(`Path taken: ${trackSteps.join(' -> ')}`);
                }
            }
        }

        expect(loopCount).toBe(0); // NO loops allowed in any scenario
        expect(actualSuccesses).toBe(expectedSuccesses); // All 'shouldComplete' scenarios must complete
    };

    test('Simulate 50 mixed conversations with V3', async () => {
        await runSimulation(knowledgeV3, 'V3', 50);
    });

    test('Simulate 50 mixed conversations with V4', async () => {
        await runSimulation(knowledgeV4, 'V4', 50);
    });
});
