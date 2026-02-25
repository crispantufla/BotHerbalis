require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const mockUser = {
    step: 'greeting',
    addressAttempts: 0,
    partialAddress: {},
    cart: [],
    assignedScript: 'v3',
    history: [],
    summary: null,
    stepEnteredAt: Date.now(),
    lastActivityAt: Date.now(),
    lastInteraction: Date.now()
};

const dependencies = {
    client: { info: { wid: { user: "123" } } },
    notifyAdmin: async () => console.log('notified'),
    saveState: () => { },
    sendMessageWithDelay: async (id, text) => console.log('BOT SAYS:', text),
    logAndEmit: () => { },
    saveOrderToLocal: () => { },
    cancelLatestOrder: async () => { },
    sharedState: {},
    config: { activeScript: 'v3' }
};

const fs = require('fs');
const knowledge = JSON.parse(fs.readFileSync('./data/knowledge_v3.json'));
const userState = { 'test@c.us': mockUser };

const processSalesFlow = require('./src/flows/salesFlow').processSalesFlow;

async function test() {
    await processSalesFlow('test@c.us', 'hola', userState, knowledge, dependencies);
    console.log("FINAL STATE:", userState['test@c.us']);
}

test().catch(e => console.error(e));
