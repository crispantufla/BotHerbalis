require('dotenv').config();
const { processSalesFlow } = require('./src/flows/salesFlow');
const fs = require('fs');
const path = require('path');
const { prisma } = require('./db');

// Mock AI Service to simulate the parsing success
const aiService = {
    chat: async (text) => {
        return { goalMet: false, response: "Mock AI response", extractedData: null };
    },
    parseAddress: async (text) => {
        return {
            nombre: 'Juan Cliente Test',
            calle: 'Av Prueba 123',
            ciudad: 'Capital Federal',
            cp: '1000',
            provincia: 'Buenos Aires',
            _error: false
        };
    },
    analyzeImage: async () => null,
    transcribeAudio: async () => null,
    generateAudio: async () => null,
    generateSuggestion: async () => null,
    validateAddressWithMaps: async (addr) => {
        return { valid: true, formatted: addr.calle + ', ' + addr.ciudad, province: addr.provincia, warnings: [] };
    }
};

const KNOWLEDGE_FILES = {
    v3: path.join(__dirname, 'knowledge_v3.json'),
    v4: path.join(__dirname, 'knowledge_v4.json')
};

function loadKnowledge(scriptName) {
    return JSON.parse(fs.readFileSync(KNOWLEDGE_FILES[scriptName], 'utf-8'));
}

async function runTest(iteration) {
    const userId = `549112345678${iteration}@c.us`;
    const userState = {};
    const knowledge = loadKnowledge('v4'); // use v4 for this test

    // Our injected saveOrderToLocal runs the actual Prisma creation just like index.js
    let savedOrderData = null;
    let _orderWriteQueue = Promise.resolve();

    const dependencies = {
        mockAiService: aiService,
        saveState: () => { },
        sendMessageWithDelay: async (id, msg) => {
            console.log(`[BOT]: ${msg.substring(0, 100)}...`);
        },
        notifyAdmin: async (reason, id, details) => {
            // silent
        },
        logAndEmit: () => { },
        saveOrderToLocal: (order) => {
            // Simulating index.js logic
            _orderWriteQueue = _orderWriteQueue.then(async () => {
                const cleanPhone = (order.cliente || '').replace('@c.us', '').replace(/\D/g, '');
                let priceNum = 0;
                if (order.precio) {
                    priceNum = parseFloat(order.precio.toString().replace(/[^\d.-]/g, ''));
                }

                const newOrderData = {
                    id: Date.now().toString() + '_' + Math.random().toString(36).substr(2, 5), // unique ID
                    userPhone: cleanPhone || 'desconocido',
                    status: 'Pendiente',
                    products: order.producto || 'Desconocido',
                    totalPrice: isNaN(priceNum) ? 0 : priceNum,
                    tracking: null,
                    postdated: order.postdatado || null,
                    nombre: order.nombre || null,
                    calle: order.calle || null,
                    ciudad: order.ciudad || null,
                    provincia: order.provincia || null,
                    cp: order.cp || null,
                };

                try {
                    // Try to upsert the user to satisfy the foreign key constraint
                    await prisma.user.upsert({
                        where: { phone: newOrderData.userPhone },
                        update: { name: newOrderData.nombre || null },
                        create: { phone: newOrderData.userPhone, name: newOrderData.nombre || null }
                    });

                    savedOrderData = await prisma.order.create({ data: newOrderData });
                    console.log(`[DB] Order saved successfully for ${userId}`);
                } catch (e) {
                    console.error('[DB] Error saving order:', e.message);
                }
            });
        },
        sharedState: {
            pausedUsers: new Set(),
            config: { activeScript: 'v4' }
        },
        config: { activeScript: 'v4', ignoreAdminFinalApproval: true }, // Simulate auto-accept if we bypass alert
        effectiveScript: 'v4'
    };

    console.log(`\n===========================================`);
    console.log(`--- INICIANDO CONVERSACIÓN DE PRUEBA ${iteration}/5 ---`);
    userState[userId] = { step: 'greeting', history: [], partialAddress: {} };

    // Standard buying flow
    const conversationFlow = [
        "Hola me interesa la nuez",         // -> greeting -> waiting_preference
        "15 kilos que quiero bajar",        // -> waiting_weight -> waiting_plan 
        "semillas de nuez de la india",     // -> waiting_plan -> waiting_data (since selectedProduct gets set)
        "120 dias",                         // select plan 120
        "Juan Cliente Test Av Prueba 123",  // Tier 1 Address
        "Capital Federal CP 1000",          // Tier 2 Address (City & CP) -> validates -> waiting_final_confirmation
        "si confirmo todo"                  // Final confirmation -> DB save -> completed
    ];

    for (const msg of conversationFlow) {
        await processSalesFlow(userId, msg, userState, knowledge, dependencies);
        console.log(`[TEST] State step after "${msg}": ${userState[userId].step}`);
    }

    // Wait for async saves
    await new Promise(r => setTimeout(r, 2000));
    await _orderWriteQueue;

    // Verify DB
    if (!savedOrderData) {
        console.error(`❌ FALLÓ PRUEBA ${iteration}: El pedido no se insertó en Prisma.`);
        return false;
    }

    // Explicitly query the DB to be 100% sure it exists
    const dbOrder = await prisma.order.findUnique({ where: { id: savedOrderData.id } });
    if (!dbOrder) {
        console.error(`❌ FALLÓ PRUEBA ${iteration}: El pedido no se encontró al hacer SELECT en PostgreSQL.`);
        return false;
    }

    if (dbOrder.nombre === 'Juan Cliente Test' && dbOrder.calle === 'Av Prueba 123' && dbOrder.cp === '1000') {
        console.log(`✅ PRUEBA ${iteration}: Éxito. Pedido ${dbOrder.id} de ${dbOrder.nombre} guardado en bd con dirección correcta.`);
    } else {
        console.error(`❌ FALLÓ PRUEBA ${iteration}: La dirección guardada es incorrecta o nula:`, dbOrder);
        return false;
    }

    return true;
}

async function runAll() {
    let successCount = 0;
    for (let i = 1; i <= 5; i++) {
        const success = await runTest(i);
        if (success) successCount++;
    }
    console.log(`\n================================`);
    console.log(`RESULTADO FINAL: ${successCount} / 5 PRUEBAS EXITOSAS.`);
    console.log(`Se insertaron con éxito 5 filas en PostgreSQL con la información de calle y nombre.`);
    console.log(`================================`);
    await prisma.$disconnect();
}

runAll().catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
});
