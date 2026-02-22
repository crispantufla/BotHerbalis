const { processSalesFlow } = require('./src/flows/salesFlow');
const fs = require('fs');
const path = require('path');

// Mock AI Service to prevent actual API calls
const aiService = {
    chat: async (text) => {
        return { goalMet: false, response: "Mock AI response", extractedData: null };
    },
    parseAddress: async (text) => {
        let res = { _error: false };
        if (text.includes('10 de marzo')) res.postdatado = "10 de marzo";
        if (text.includes('Juan Perez Av Siempreviva 123 Cordoba 5000')) {
            res.nombre = 'Juan Perez';
            res.calle = 'Av Siempreviva 123';
            res.ciudad = 'Cordoba';
            res.cp = '5000';
            res.provincia = 'Cordoba';
        }

        if (Object.keys(res).length === 1) return { _error: true };
        return { extractedData: res }; // Wrap it nicely
    },
    analyzeImage: async () => null,
    transcribeAudio: async () => null,
    generateAudio: async () => null,
    generateSuggestion: async () => null,
    validateAddressWithMaps: async (addr) => {
        return { valid: true, formatted: addr.calle + ', ' + addr.ciudad, province: addr.provincia, warnings: [] };
    }
};

// No se intercepta el requerimiento, se pasa por inyección

const KNOWLEDGE_FILES = {
    v3: path.join(__dirname, 'knowledge_v3.json'),
    v4: path.join(__dirname, 'knowledge_v4.json')
};

function loadKnowledge(scriptName) {
    if (fs.existsSync(KNOWLEDGE_FILES[scriptName])) {
        return JSON.parse(fs.readFileSync(KNOWLEDGE_FILES[scriptName], 'utf-8'));
    }
    throw new Error(`Knowledge file for ${scriptName} not found.`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runSimulation(scriptName, iteration) {
    const userId = `TEST_${scriptName}_${iteration}@c.us`;
    const userState = {};
    const knowledge = loadKnowledge(scriptName);

    // Custom mock dependencies for silence and speed
    const dependencies = {
        mockAiService: aiService,
        saveState: () => { },
        sendMessageWithDelay: async (id, msg) => {
            // console.log(`[BOT -> ${id}]: ${msg}`);
        },
        notifyAdmin: async (reason, id, details) => {
            // console.log(`[ALERT -> ${id}]: ${reason} - ${details}`);
        },
        logAndEmit: (userId, from, msg) => {
            if (msg.includes('AI Parse Result')) console.log(msg);
        },
        saveOrderToLocal: () => { },
        sharedState: {
            pausedUsers: new Set(),
            config: { activeScript: scriptName }
        },
        config: { activeScript: scriptName },
        effectiveScript: scriptName
    };

    console.log(`\n--- INICIANDO PRUEBA ${iteration}/50 PARA SCRIPT ${scriptName.toUpperCase()} ---`);
    userState[userId] = { step: 'greeting', history: [], partialAddress: {} };

    const conversationFlow = [
        "Hola",
        "15",
        "capsulas",
        "120 dias",
        "mejor semillas para el 10 de marzo",
        "Juan Perez Av Siempreviva 123 Cordoba 5000",
        "si"
    ];

    for (const msg of conversationFlow) {
        // console.log(`[USER -> ${userId}]: ${msg}`);
        await processSalesFlow(userId, msg, userState, knowledge, dependencies);
    }

    // Assertion checks
    const finalState = userState[userId];
    if (finalState.step !== 'waiting_final_confirmation' && finalState.step !== 'waiting_admin_ok') {
        console.error(`❌ FALLÓ PRUEBA ${iteration} (${scriptName}): El bot se estancó en ${finalState.step}`);
        return false;
    }
    if (finalState.selectedProduct !== 'Semillas de nuez de la india') {
        console.error(`❌ FALLÓ PRUEBA ${iteration} (${scriptName}): El producto no se cambió correctamente. Quedó en ${finalState.selectedProduct}`);
        return false;
    }
    if (!finalState.postdatado) {
        console.error(`❌ FALLÓ PRUEBA ${iteration} (${scriptName}): No se guardó la fecha postdatada.`);
        return false;
    }

    console.log(`✅ PRUEBA ${iteration} (${scriptName}): Éxito. Step final: ${finalState.step} | Producto: ${finalState.selectedProduct} | Fecha: ${finalState.postdatado}`);
    return true;
}

async function runAll() {
    let successCount = 0;
    const TOTAL_TESTS = 50;

    for (let script of ['v3', 'v4']) {
        for (let i = 1; i <= TOTAL_TESTS; i++) {
            const success = await runSimulation(script, i);
            if (success) successCount++;
            // Small sleep to not absolutely hammer the OpenAI rate limit if it connects
            // Wait, we are hitting real OpenAI. 100 tests * 3 AI calls = 300 requests. 
            // We should mock OpenAI for speed and cost.
        }
    }
    console.log(`\n================================`);
    console.log(`RESULTADO FINAL: ${successCount} / 100 exitosos.`);
    console.log(`================================`);
}

runAll().catch(console.error);
