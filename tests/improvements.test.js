const { processSalesFlow } = require('../src/flows/salesFlow');
const fs = require('fs');
const path = require('path');
// Mock aiService factory BEFORE require
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn(),
        parseAddress: jest.fn(),
        checkAndSummarize: jest.fn().mockResolvedValue(null)
    }
}));
const { aiService } = require('../src/services/ai');

// MOCKS
jest.mock('fs', () => {
    const actualFs = jest.requireActual('fs');
    const path = require('path');
    return {
        ...actualFs,
        existsSync: jest.fn((p) => {
            if (typeof p === 'string' && (p.endsWith('prices.json') || p.endsWith('knowledge_v3.json'))) return true;
            return actualFs.existsSync(p);
        }),
        readFileSync: jest.fn((p, opts) => {
            if (typeof p === 'string' && p.endsWith('prices.json')) {
                return JSON.stringify({
                    "Semillas": { "60": "36.900", "120": "49.900" },
                    "Cápsulas": { "60": "46.900", "120": "79.900" },
                    "Gotas": { "60": "48.900", "120": "68.900" },
                    "adicionalMAX": "6.000"
                });
            }
            if (typeof p === 'string' && p.endsWith('knowledge_v3.json')) {
                return actualFs.readFileSync(path.join(__dirname, '../knowledge_v3.json'), opts);
            }
            return actualFs.readFileSync(p, opts);
        })
    };
});

jest.mock('../src/services/addressValidator', () => ({
    validateAddress: jest.fn().mockResolvedValue({ cpValid: true, mapsFormatted: null, warnings: [] })
}));
// safeWrite.js is in root dir
jest.mock('../safeWrite.js', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../sheets_sync.js', () => ({ appendOrderToSheet: jest.fn() }));

// Mock dependencies object
const mockDependencies = {
    client: { sendMessage: jest.fn() },
    notifyAdmin: jest.fn(),
    saveState: jest.fn(),
    sendMessageWithDelay: jest.fn(),
    logAndEmit: jest.fn()
};

// Load knowledge
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '../knowledge_v3.json'), 'utf8'));

describe('Strategic Improvements', () => {
    let userState = {};
    const userId = 'user_test_imp';

    beforeEach(() => {
        userState = {};
        jest.clearAllMocks();

        // Default AI responses
        aiService.chat.mockImplementation(async (text, context) => {
            if (context.step === 'waiting_preference_consultation') {
                return { response: "Te recomiendo gotas.", goalMet: true };
            }
            if (context.step === 'waiting_plan_choice') {
                // Return generic response
                return { response: "Elige 60 o 120", goalMet: false };
            }
            if (text.includes("prefiero capsulas")) {
                // The flow uses regex matching on the input TEXT, not the AI response, for product changes in waiting_data!
                // See line 1018 in salesFlow.js: 
                // const productChangeMatch = normalizedText.match(...)
                // raising this flag triggers the change logic.
                // However, the test sends "prefiero capsulas" which SHOULD match the regex.
                // Wait, if it matches the regex, it enters the if(productChangeMatch) block.
                // Inside, it checks: if (newProduct && newProduct !== currentState.selectedProduct)
                return { response: "Entendido, cambiamos.", goalMet: true };
            }
            return { response: "AI Response", goalMet: false };
        });

        // Parse format must match what flow expects: { calle: ..., ciudad: ..., cp: ... }
        // The flow does: const data = await aiService.parseAddress(text);
        // then: if (data.calle ...) currentState.partialAddress.calle = data.calle
        aiService.parseAddress.mockImplementation(async (text) => {
            if (text.includes("Calle Falsa")) return { calle: "Calle Falsa 123" };
            return { _error: true }; // Return error/null if no match
        });
    });

    test('1. Consultative Tagging: Should mark sales as consultative', async () => {
        // Setup state to waiting_preference
        userState[userId] = {
            step: 'waiting_preference',
            history: [],
            consultativeSale: false
        };

        // Trigger consultative logic (indecision)
        await processSalesFlow(userId, "Estoy entre gotas y semillas", userState, knowledge, mockDependencies);

        // Verify consultativeSale flag is set to true
        expect(userState[userId].consultativeSale).toBe(true);
        expect(mockDependencies.sendMessageWithDelay).toHaveBeenCalledWith(
            userId, "Te recomiendo gotas."
        );
    });

    test('2. Data Persistence: Should preserve weightGoal when changing product', async () => {
        // Setup state with existing data
        userState[userId] = {
            step: 'waiting_data',
            selectedProduct: 'Semillas',
            selectedPlan: '60', // REQUIRED to pass the guard in waiting_data
            weightGoal: 'Quiero bajar 20kg', // Custom field we want to preserve
            history: [],
            addressAttempts: 0
        };

        // User changes product using AI fallback logic in waiting_data
        // The flow uses regex: \b(mejor|quiero|prefiero|cambio|cambia|dame|paso a|en vez)\b.*\b(capsula|...)\b
        await processSalesFlow(userId, "quiero cambiar a capsulas", userState, knowledge, mockDependencies);

        // Verify product changed
        expect(userState[userId].selectedProduct).toContain('Cápsulas');
        // Verify weightGoal is PRESERVED (not undefined)
        expect(userState[userId].weightGoal).toBe('Quiero bajar 20kg');
    });

    test('3. Smart Address Accumulation: Should acknowledge partial progress', async () => {
        // Setup waiting_data state
        userState[userId] = {
            step: 'waiting_data',
            selectedProduct: 'Semillas',
            selectedPlan: '60', // REQUIRED to pass the guard
            partialAddress: {},
            history: [],
            addressAttempts: 0
        };

        // User sends partial address
        // Ensure mock trigger matches strict logic.
        // Flow: const data = await aiService.parseAddress(text);
        // Test Mock: if (text.includes("Calle Falsa")) return { calle: "Calle Falsa 123" };
        await processSalesFlow(userId, "Vivo en Calle Falsa 123", userState, knowledge, mockDependencies);

        // Verify partial address updated
        expect(userState[userId].partialAddress.calle).toBe('Calle Falsa 123');

        // Verify response acknowledges receipt (any of the randomized messages)
        // acks = ["¡Perfecto! Ya agendé...", "Buenísimo. Me queda pendiente...", "¡Dale! Ya casi estamos..."]
        expect(mockDependencies.sendMessageWithDelay).toHaveBeenCalledWith(
            userId, expect.stringMatching(/Ya agendé|pendiente|Ya casi estamos/i)
        );

        // Verify attempts reset to 0 (because progress was made)
        expect(userState[userId].addressAttempts).toBe(0);
    });

    test('4. Postponement Handling: Should NOT force closing question if user is busy', async () => {
        // Setup state where AI usually asks for goal
        userState[userId] = {
            step: 'waiting_preference',
            history: [],
            addressAttempts: 0
        };

        // Mock AI response to simulate the "Postponement" rule taking effect
        // Real AI would be prompted, but here we mock the OUTPUT to verify flow handling
        aiService.chat.mockResolvedValueOnce({
            response: "Dale, tranqui. Avisame cuando puedas! 😊",
            goalMet: false
        });

        // User says they are working
        await processSalesFlow(userId, "Estoy trabajando, despues te digo", userState, knowledge, mockDependencies);

        // Verify the bot sent the non-pushy response
        expect(mockDependencies.sendMessageWithDelay).toHaveBeenCalledWith(
            userId, "Dale, tranqui. Avisame cuando puedas! 😊"
        );

        // Verify it did NOT try to force a step transition or repetitive question logic
        // (This is implicit if the flow just sends the response and breaks)
    });

    test('5. Full Price List: Should show all prices if explicitly asked', async () => {
        // Setup state
        userState[userId] = { step: 'waiting_preference', history: [] };

        // Mock AI response for explicit price request
        aiService.chat.mockResolvedValueOnce({
            response: "Acá tenés todo: Semillas $36.900, Cápsulas $46.900...",
            goalMet: false
        });

        await processSalesFlow(userId, "pasame todos los precios", userState, knowledge, mockDependencies);

        expect(mockDependencies.sendMessageWithDelay).toHaveBeenCalledWith(
            userId, expect.stringContaining("Acá tenés todo")
        );
    });
});
