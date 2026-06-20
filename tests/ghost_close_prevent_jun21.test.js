/**
 * F1 (26 charlas, caso 2954520621): venta fantasma preventiva. Si el bot va a mandar
 * un "todo listo / pedido confirmado" SIN orden registrada (sin pendingOrder, en step
 * no-cierre), sendMessageWithDelay lo BLOQUEA y manda un mensaje neutral en su lugar.
 * Las confirmaciones legítimas (con pendingOrder o en step de cierre) pasan normal.
 */
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../db', () => ({
    prisma: {
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        user: { upsert: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
    },
}));

const { createBotHelpers } = require('../src/handlers/botHelpers');

const makeHelpers = (userState) => {
    const client = {
        sendMessage: jest.fn().mockResolvedValue(undefined),
        getChatById: jest.fn().mockResolvedValue({ sendStateTyping: jest.fn(), sendSeen: jest.fn() }),
    };
    const ctx = {
        sellerId: 'test', sharedState: { io: null, config: {} }, client,
        userState, config: { alertNumbers: [], globalPause: false },
        pausedUsers: new Set(), redlock: {},
    };
    return { helpers: createBotHelpers(ctx), client };
};
const past = () => Date.now() - 20000; // sin delay

describe('F1 — bloqueo preventivo de venta fantasma', () => {
    test('cierre falso sin orden (step waiting_data) → NO se manda; va el mensaje neutral', async () => {
        const userState = { 'g1@c.us': { step: 'waiting_data', pendingOrder: null, history: [] } };
        const { helpers, client } = makeHelpers(userState);
        await helpers.sendMessageWithDelay('g1@c.us', '¡Listo, todo confirmado! Gracias por confiar 🙌', past());
        expect(client.sendMessage).toHaveBeenCalledTimes(1);
        const sent = client.sendMessage.mock.calls[0][1];
        expect(sent).toMatch(/reviso bien tu pedido/);
        expect(sent).not.toMatch(/todo confirmado|Gracias por confiar/);
    });

    test('confirmación legítima CON pendingOrder → se manda normal', async () => {
        const userState = { 'g2@c.us': { step: 'waiting_data', pendingOrder: { cart: [{}] }, history: [] } };
        const { helpers, client } = makeHelpers(userState);
        await helpers.sendMessageWithDelay('g2@c.us', 'Tu pedido quedó confirmado ✅', past());
        expect(client.sendMessage).toHaveBeenCalledWith('g2@c.us', 'Tu pedido quedó confirmado ✅');
    });

    test('cierre en step de cierre (waiting_admin_validation) → se manda normal', async () => {
        const userState = { 'g3@c.us': { step: 'waiting_admin_validation', pendingOrder: null, history: [] } };
        const { helpers, client } = makeHelpers(userState);
        await helpers.sendMessageWithDelay('g3@c.us', 'pedido confirmado', past());
        expect(client.sendMessage).toHaveBeenCalledWith('g3@c.us', 'pedido confirmado');
    });

    test('mensaje normal (no cierre) → se manda intacto', async () => {
        const userState = { 'g4@c.us': { step: 'waiting_data', pendingOrder: null, history: [] } };
        const { helpers, client } = makeHelpers(userState);
        await helpers.sendMessageWithDelay('g4@c.us', '¿Me pasás tu código postal? 😊', past());
        expect(client.sendMessage).toHaveBeenCalledWith('g4@c.us', '¿Me pasás tu código postal? 😊');
    });
});
