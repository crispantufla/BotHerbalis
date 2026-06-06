/**
 * Regresión scheduler — ventana de 24h de WhatsApp + anti-ráfaga (jun-2026).
 *
 *  - Recuperación SOLO dentro de la ventana de 24h (desde el último mensaje del
 *    CLIENTE, no desde nuestras respuestas).
 *  - Nunca todos juntos: tope por corrida (MAX_REENGAGE_PER_RUN).
 *  - cold-lead (≥24h) y second-follow-up (48-72h) desactivados.
 */

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../db', () => ({
    prisma: {
        user: { upsert: jest.fn().mockResolvedValue({}) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        order: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue({}) },
    },
}));
// Forzamos horario comercial para que los jobs corran en el test.
jest.mock('../src/services/timeUtils', () => {
    const actual = jest.requireActual('../src/services/timeUtils');
    return { ...actual, isBusinessHours: () => true };
});

const { checkAbandonedCarts, checkColdLeads } = require('../src/services/scheduler');

const H = 3600 * 1000;
const makeState = (hoursSinceUserMsg, extra = {}) => {
    const now = Date.now();
    return {
        step: 'waiting_data',
        cartRecovered: false,
        reengagementSent: false,
        userName: 'María Pérez',
        lastActivityAt: now - hoursSinceUserMsg * H,
        history: [{ role: 'user', content: 'hola', timestamp: now - hoursSinceUserMsg * H }],
        ...extra,
    };
};
const makeDeps = () => ({
    sendMessageWithDelay: jest.fn().mockResolvedValue(undefined),
    saveState: jest.fn(),
});

describe('checkAbandonedCarts — ventana de 24h', () => {
    test('NO envía a un cliente inactivo >24h (30h)', async () => {
        const deps = makeDeps();
        const sharedState = { userState: { 'a@c.us': makeState(30) }, pausedUsers: new Set() };
        await checkAbandonedCarts(sharedState, deps);
        expect(deps.sendMessageWithDelay).not.toHaveBeenCalled();
    });

    test('SÍ envía dentro de la ventana (~10h)', async () => {
        const deps = makeDeps();
        const sharedState = { userState: { 'b@c.us': makeState(10) }, pausedUsers: new Set() };
        await checkAbandonedCarts(sharedState, deps);
        expect(deps.sendMessageWithDelay).toHaveBeenCalledTimes(1);
    });

    test('NO envía justo en el borde (22h)', async () => {
        const deps = makeDeps();
        const sharedState = { userState: { 'c@c.us': makeState(22) }, pausedUsers: new Set() };
        await checkAbandonedCarts(sharedState, deps);
        expect(deps.sendMessageWithDelay).not.toHaveBeenCalled();
    });

    test('mide desde el último mensaje del CLIENTE, no desde nuestra respuesta', async () => {
        // Cliente escribió hace 30h; nosotros le respondimos hace 1h. Sigue fuera de ventana.
        const now = Date.now();
        const deps = makeDeps();
        const state = makeState(30, {
            lastActivityAt: now - 1 * H, // contaminado por una respuesta nuestra reciente
            history: [
                { role: 'user', content: 'hola', timestamp: now - 30 * H },
                { role: 'bot', content: 'te respondo', timestamp: now - 1 * H },
            ],
        });
        const sharedState = { userState: { 'd@c.us': state }, pausedUsers: new Set() };
        await checkAbandonedCarts(sharedState, deps);
        expect(deps.sendMessageWithDelay).not.toHaveBeenCalled();
    });

    test('anti-ráfaga: no envía a todos juntos (tope por corrida)', async () => {
        const deps = makeDeps();
        const userState = {};
        for (let i = 0; i < 15; i++) userState[`u${i}@c.us`] = makeState(10);
        const sharedState = { userState, pausedUsers: new Set() };
        await checkAbandonedCarts(sharedState, deps);
        // Con 15 elegibles, NO deben salir los 15 en una sola corrida.
        expect(deps.sendMessageWithDelay.mock.calls.length).toBeLessThan(15);
        expect(deps.sendMessageWithDelay.mock.calls.length).toBeGreaterThan(0);
    });

    test('no re-envía a quien ya recibió el nudge (cartRecovered)', async () => {
        const deps = makeDeps();
        const sharedState = { userState: { 'e@c.us': makeState(10, { cartRecovered: true }) }, pausedUsers: new Set() };
        await checkAbandonedCarts(sharedState, deps);
        expect(deps.sendMessageWithDelay).not.toHaveBeenCalled();
    });
});

describe('checkColdLeads — desactivado', () => {
    test('no envía nada aunque el cliente esté inactivo ≥24h', async () => {
        const deps = makeDeps();
        const sharedState = { userState: { 'f@c.us': makeState(40) }, pausedUsers: new Set() };
        await checkColdLeads(sharedState, deps);
        expect(deps.sendMessageWithDelay).not.toHaveBeenCalled();
    });
});
