const { processSalesFlow } = require('./src/flows/salesFlow');

// Mock structure
const userState = {
    '123@c.us': {
        step: 'waiting_plan_choice',
        history: [
            { role: 'user', content: 'lo mas eficiente' },
            { role: 'bot', content: 'Las cápsulas son la opción más efectiva y práctica. ¿Cuántos kilos querés bajar?' },
            { role: 'user', content: '12' },
            { role: 'bot', content: 'Personalmente yo te recomendaría el de 120 días debido al peso que esperas perder 👌' }
        ],
        cart: []
    }
};

const dependencies = {
    client: { getNumberId: async () => ({ _serialized: '123@c.us' }) },
    notifyAdmin: () => { },
    saveState: () => { },
    sendMessageWithDelay: async (id, text) => {
        console.log(`\nBOT SAYS -> ${text}`);
    },
    logAndEmit: () => { },
    saveOrderToLocal: () => { },
    cancelLatestOrder: () => { },
    sharedState: { io: null },
    config: { activeScript: 'v3' }
};

const knowledge = {
    flow: {
        closing: { response: '¡Excelente! Tomamos los datos para armar la etiqueta', nextStep: 'waiting_data' }
    },
    pricing: {
        'Nuez de la India': { '60': '46.900', '120': '66.900' }
    },
    faq: []
};

async function testImplicitPlan() {
    console.log("Simulating USER replying 'oka' to 120d recommendation...");
    await processSalesFlow('123@c.us', 'oka', userState, knowledge, dependencies);

    console.log('\n--- Final State ---');
    console.log('Step:', userState['123@c.us'].step);
    console.log('Selected Plan:', userState['123@c.us'].selectedPlan);
    console.log('Cart:', userState['123@c.us'].cart);
}

testImplicitPlan().catch(console.error);
