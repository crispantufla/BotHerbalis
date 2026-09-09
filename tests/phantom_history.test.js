/**
 * Historial fantasma: el history que lee la IA tiene que contener SOLO los
 * mensajes que el cliente realmente recibió.
 *
 * sendMessageWithDelay devuelve false sin enviar en cinco caminos (guard
 * anti venta-fantasma, anti-duplicado, pausa durante el delay de 4-8s,
 * stillValid, y excepción del cliente). Hasta el 2026-09-09 el push al history
 * lo hacía cada call site ANTES de llamar, así que en cualquiera de esos cinco
 * casos quedaba anotado un mensaje que nunca salió — y la IA arrancaba el turno
 * siguiente convencida de que ya lo había dicho. De 143 call sites, solo 6
 * miraban el booleano.
 *
 * Ahora el push vive dentro de sendMessageWithDelay, junto a logAndEmit, que se
 * había movido ahí en jun-2026 por exactamente el mismo motivo.
 */
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../db', () => ({
    prisma: {
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        user: { upsert: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
    },
}));

const { createBotHelpers } = require('../src/handlers/botHelpers');

const makeHelpers = (userState, overrides = {}) => {
    const client = {
        sendMessage: jest.fn().mockResolvedValue(undefined),
        getChatById: jest.fn().mockResolvedValue({ sendStateTyping: jest.fn(), sendSeen: jest.fn() }),
        ...(overrides.client || {}),
    };
    const ctx = {
        sellerId: 'test',
        sharedState: { io: null, config: {} },
        client,
        userState,
        config: { alertNumbers: [], globalPause: false, ...(overrides.config || {}) },
        pausedUsers: overrides.pausedUsers || new Set(),
        redlock: {},
    };
    return { helpers: createBotHelpers(ctx), client };
};
const past = () => Date.now() - 20000; // startTime viejo ⇒ sin delay real
const contents = (state) => state.history.map(h => h.content);

describe('historial fantasma', () => {

    test('envío exitoso → queda anotado una sola vez', async () => {
        const userState = { 'a@c.us': { step: 'waiting_data', history: [] } };
        const { helpers, client } = makeHelpers(userState);

        const sent = await helpers.sendMessageWithDelay('a@c.us', 'Hola, ¿me pasás tu CP?', past());

        expect(sent).toBe(true);
        expect(client.sendMessage).toHaveBeenCalledTimes(1);
        expect(contents(userState['a@c.us'])).toEqual(['Hola, ¿me pasás tu CP?']);
    });

    test('pausado durante el delay → NO se envía y NO queda en el history', async () => {
        const userState = { 'b@c.us': { step: 'waiting_data', history: [] } };
        const paused = new Set(['b@c.us']);
        const { helpers, client } = makeHelpers(userState, { pausedUsers: paused });

        const sent = await helpers.sendMessageWithDelay('b@c.us', 'mensaje que no sale', past());

        expect(sent).toBe(false);
        expect(client.sendMessage).not.toHaveBeenCalled();
        expect(userState['b@c.us'].history).toHaveLength(0);
    });

    test('stillValid false (cambió el step) → NO se envía y NO queda en el history', async () => {
        const userState = { 'c@c.us': { step: 'waiting_data', history: [] } };
        const { helpers, client } = makeHelpers(userState);

        const sent = await helpers.sendMessageWithDelay('c@c.us', 'ya no aplica', past(), () => false);

        expect(sent).toBe(false);
        expect(client.sendMessage).not.toHaveBeenCalled();
        expect(userState['c@c.us'].history).toHaveLength(0);
    });

    test('anti-duplicado → el segundo intento no se envía ni se re-anota', async () => {
        const userState = { 'd@c.us': { step: 'waiting_data', history: [] } };
        const { helpers, client } = makeHelpers(userState);

        await helpers.sendMessageWithDelay('d@c.us', 'mismo texto', past());
        const second = await helpers.sendMessageWithDelay('d@c.us', 'mismo texto', past());

        expect(second).toBe(false);
        expect(client.sendMessage).toHaveBeenCalledTimes(1);
        expect(contents(userState['d@c.us'])).toEqual(['mismo texto']);
    });

    test('el cliente de WhatsApp tira excepción → NO queda en el history', async () => {
        const userState = { 'e@c.us': { step: 'waiting_data', history: [] } };
        const { helpers } = makeHelpers(userState, {
            client: { sendMessage: jest.fn().mockRejectedValue(new Error('WA caído')) },
        });

        const sent = await helpers.sendMessageWithDelay('e@c.us', 'se pierde', past());

        expect(sent).toBe(false);
        expect(userState['e@c.us'].history).toHaveLength(0);
    });

    test('cierre falso bloqueado → al history va el mensaje neutral, no el cierre', async () => {
        const userState = { 'f@c.us': { step: 'waiting_data', pendingOrder: null, history: [] } };
        const { helpers } = makeHelpers(userState);

        const sent = await helpers.sendMessageWithDelay('f@c.us', '¡Listo, todo confirmado! 🙌', past());

        expect(sent).toBe(false);
        const h = contents(userState['f@c.us']);
        expect(h).toHaveLength(1);
        expect(h[0]).toMatch(/reviso bien tu pedido/);
        expect(h[0]).not.toMatch(/todo confirmado/);
    });

    test('secuencia completa: el history termina igual a lo que salió a WhatsApp', async () => {
        const userState = { 'z@c.us': { step: 'waiting_data', pendingOrder: { cart: [{}] }, history: [] } };
        const outbox = [];
        const { helpers } = makeHelpers(userState, {
            client: {
                sendMessage: jest.fn(async (_id, content) => { outbox.push(String(content)); }),
                getChatById: jest.fn().mockResolvedValue({ sendStateTyping: jest.fn(), sendSeen: jest.fn() }),
            },
        });

        await helpers.sendMessageWithDelay('z@c.us', 'uno', past());
        await helpers.sendMessageWithDelay('z@c.us', 'dos', past());
        await helpers.sendMessageWithDelay('z@c.us', 'dos', past());   // anti-dup: no sale
        await helpers.sendMessageWithDelay('z@c.us', 'tres', past());

        // El invariante: ni fantasmas (algo en el history que no salió) ni
        // duplicados (algo anotado dos veces por push del call site + del helper).
        expect(outbox).toEqual(['uno', 'dos', 'tres']);
        expect(contents(userState['z@c.us'])).toEqual(outbox);
    });

    test('chat sin state (ej: aviso al admin) no rompe el envío', async () => {
        const userState = {};
        const { helpers, client } = makeHelpers(userState);

        const sent = await helpers.sendMessageWithDelay('549999@c.us', 'alerta al admin', past());

        expect(sent).toBe(true);
        expect(client.sendMessage).toHaveBeenCalledTimes(1);
    });
});
