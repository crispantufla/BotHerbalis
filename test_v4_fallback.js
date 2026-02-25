require('dotenv').config();
const { processSalesFlow } = require('./src/flows/salesFlow');
const knowledge = require('./knowledge_v4.json');
const aiService = require('./src/services/ai');

const userState = {};
const userId = 'test_fallback_v4@c.us';

const mockDependencies = {
    client: { sendMessage: async () => { } },
    notifyAdmin: async () => { },
    saveState: () => { },
    sendMessageWithDelay: async (uid, msg) => console.log(`\n🤖 BOT: ${msg}\n`),
    logAndEmit: () => { },
    effectiveScript: 'v4',
    config: { activeScript: 'v4' }
};

async function simulate() {
    console.log("Starting simulation...");

    userState[userId] = {
        step: 'waiting_preference',
        cart: [],
        assignedScript: 'v4',
        history: [
            { role: 'bot', content: '¿Te queda más cómodo algo súper práctico (cápsulas o gotas) o preferís lo más natural y tradicional (semillas)?', timestamp: Date.now() - 60000 },
            { role: 'user', content: 'es lo mismo', timestamp: Date.now() - 50000 },
            { role: 'bot', content: 'Las cápsulas son más efectivas. ¿Avanzamos con las cápsulas?', timestamp: Date.now() - 40000 },
            { role: 'user', content: 'Y es seguro porque me an estafado tanto', timestamp: Date.now() - 30000 },
            { role: 'bot', content: 'Entiendo tus preocupaciones, pero te aseguro que es 100% natural. ¿Avanzamos con cápsulas?', timestamp: Date.now() - 20000 }
        ]
    };

    try {
        console.log(`\n👤 USER: si`);
        await processSalesFlow(userId, "si", userState, knowledge, mockDependencies);
        console.log(`STATE STEP IS NOW: ${userState[userId].step}`);
        console.log(`SELECTED PROD IS: ${userState[userId].selectedProduct}`);
    } catch (e) {
        console.error("ERROR DE TESTS:", e);
    }

    process.exit(0);
}

simulate();
