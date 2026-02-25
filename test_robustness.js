require('dotenv').config();
// Disable Google Maps during test so it doesn't try to validate "Av Falsa" and fail the flow
delete process.env.GOOGLE_MAPS_KEY;
const { processSalesFlow } = require('./src/flows/salesFlow');
const fs = require('fs');
const path = require('path');

const KNOWLEDGE_FILES = {
    v3: path.join(__dirname, 'knowledge_v3.json'),
    v4: path.join(__dirname, 'knowledge_v4.json')
};

function loadKnowledge(scriptName) {
    return JSON.parse(fs.readFileSync(KNOWLEDGE_FILES[scriptName], 'utf-8'));
}

async function runRobustnessTest(scriptName, iteration) {
    const userId = `ROBUST_${scriptName}_${iteration}@c.us`;
    const userState = {
        [userId]: { step: 'greeting', history: [], partialAddress: {} }
    };
    const knowledge = loadKnowledge(scriptName);

    // Trackers for assertions
    const botMessagesSent = [];
    let stateBeforeInteraction = '';
    let messageSentInTurn = false;
    let fallbackCount = 0;

    // A slightly "noisy" Mock AI to simulate real non-linear chats
    const aiService = {
        chat: async (text) => {
            if (text.includes('duda') || text.includes('no se')) {
                fallbackCount++;
                return { goalMet: false, response: "Mock FAQ Response", extractedData: null };
            }
            return { goalMet: true, response: "Mock AI parsed gracefully", extractedData: null };
        },
        parseAddress: async (text) => {
            let res = { _error: false };
            if (text.includes('Pedro')) res.nombre = 'Pedro';
            if (text.includes('Av Falsa 123')) res.calle = 'Av Falsa 123';
            if (text.includes('Cordoba')) { res.ciudad = 'Cordoba'; res.provincia = 'Cordoba'; }
            if (text.includes('5000')) res.cp = '5000';

            if (Object.keys(res).length === 1) return { _error: true };
            console.log("Mock parsed:", res);
            return res;
        },
        analyzeImage: async () => null,
        transcribeAudio: async () => null,
        generateAudio: async () => null,
        generateSuggestion: async () => null,
        validateAddressWithMaps: async (addr) => {
            return { valid: true, formatted: addr.calle + ', ' + addr.ciudad, province: addr.provincia, warnings: [] };
        }
    };

    const dependencies = {
        mockAiService: aiService,
        saveState: () => { },
        sendMessageWithDelay: async (id, msg) => {
            console.log(`[BOT]: ${msg.substring(0, 150).replace(/\n/g, ' ')}...`);
            // ASSERTION 1: No repeating the same exact text twice
            if (botMessagesSent.includes(msg)) {
                throw new Error(`\n❌ FALLA DE BUCLE/REPETICIÓN: El bot repitió el texto exacto:\n"${msg}"\n`);
            }
            botMessagesSent.push(msg);
            messageSentInTurn = true;
        },
        notifyAdmin: async () => { },
        logAndEmit: () => { },
        saveOrderToLocal: () => { },
        sharedState: { pausedUsers: new Set(), config: { activeScript: scriptName } },
        config: { activeScript: scriptName },
        effectiveScript: scriptName
    };

    // A single flawless path to test system integrity 50 times
    const flowToUse = [
        "Hola",                            // greeting -> waiting_preference
        "15 kilos",                        // waiting_weight -> waiting_plan 
        "semillas de nuez de la india",    // -> waiting_plan -> waiting_data (sets product)
        "120 dias",                        // select plan 120 -> waiting_data
        "Pedro Av Falsa 123",              // Tier 1 Address
        "Cordoba",                         // Tier 2 Address (City & CP) -> sets mocking properties
        "5000",                            // CP isolated, validates
        "si confirmo"                      // Final confirmation -> DB save -> completed
    ];

    for (const msg of flowToUse) {
        stateBeforeInteraction = userState[userId].step;
        messageSentInTurn = false;

        await processSalesFlow(userId, msg, userState, knowledge, dependencies);

        const stateAfterInteraction = userState[userId].step;
        console.log(`[TEST] Envío: "${msg}" | Estado Previo: ${stateBeforeInteraction} | Estado Final: ${stateAfterInteraction}`);

        // ASSERTION 2: No ignored messages (State must change OR Bot must send a message/reply)
        if (stateBeforeInteraction === stateAfterInteraction && !messageSentInTurn) {
            throw new Error(`\n❌ FALLA DE IGNORADO: El bot ignoró el mensaje "${msg}" en el step "${stateBeforeInteraction}". No avanzó ni respondió.\n`);
        }

        // ASSERTION 3: No infinite loops (Prevent crazy history bloat during a standard checkout)
        if (userState[userId].history.length > 25) {
            throw new Error(`\n❌ FALLA DE BUCLE: El bot generó más de 25 mensajes de historial, atascado en el step "${stateAfterInteraction}".\n`);
        }
    }

    // Final sanity check
    if (userState[userId].step !== 'waiting_admin_validation' && userState[userId].step !== 'completed' && userState[userId].step !== 'waiting_final_confirmation') {
        throw new Error(`\n❌ FALLA DE ESTANCAMIENTO: El flow no llegó al estado final. Quedó en: "${userState[userId].step}".\n`);
    }

    return true;
}

async function runAll() {
    console.log(`\n================================`);
    console.log(`🚀 INICIANDO TEST DE ROBUSTEZ EXTREMA (100 SIMULACIONES)`);
    console.log(`================================\n`);

    let successCount = 0;
    const TOTAL_TESTS = 50;

    try {
        for (let script of ['v3', 'v4']) {
            console.log(`Verificando Script ${script.toUpperCase()}...`);
            for (let i = 1; i <= TOTAL_TESTS; i++) {
                await runRobustnessTest(script, i);
                successCount++;
            }
            console.log(`✅ Script ${script.toUpperCase()}: 50/50 tests sin bucles ni repeticiones.\n`);
        }

        console.log(`================================`);
        console.log(`🎉 TEST SUPERADO: ${successCount}/100 simulaciones.`);
        console.log(`Cero bucles. Cero mensajes repetidos. Cero mensajes ignorados.`);
        console.log(`================================`);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

runAll();
