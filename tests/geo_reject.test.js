/**
 * GEO reject (globalSystem) — rechazo de envíos fuera de España + sus falsos
 * positivos.
 *
 * El bot argentino tenía este mismo test con los papeles cambiados (rechazaba
 * fuera de Argentina y el falso positivo clásico era "Concepción del Uruguay").
 * Aquí la trampa equivalente es una población española cuyo nombre contiene el
 * de otro país, y el cliente español que escribe estando de viaje fuera.
 */

const { handleSystemGlobals } = require('../src/flows/globals/globalSystem');

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }), { virtual: true });
jest.mock('../db', () => ({
    prisma: {
        user: { upsert: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
    },
}));

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function makeDeps() {
    const sent = [];
    const deps = {
        sendMessageWithDelay: jest.fn(async (_id, m) => { sent.push(m); }),
        aiService: { chat: jest.fn().mockResolvedValue({ response: null, goalMet: false }) },
        saveState: jest.fn(),
        notifyAdmin: jest.fn().mockResolvedValue(undefined),
        sharedState: { pausedUsers: new Set(), io: null, sellerId: 'herbalis-es' },
    };
    return { deps, sent };
}

const baseState = (extra = {}) => ({
    step: 'waiting_preference', history: [], pendingCancelConfirm: false, geoRejected: false, ...extra,
});

describe('GEO reject', () => {
    test('cliente de fuera ("estoy en Argentina") → geo-rechaza', async () => {
        const { deps, sent } = makeDeps();
        const s = baseState();
        const txt = 'estoy en argentina';
        const r = await handleSystemGlobals('u1@c.us', txt, norm(txt), s, deps);
        expect(r).toEqual({ matched: true });
        expect(s.geoRejected).toBe(true);
        expect(sent.join(' ')).toMatch(/dentro de España/i);
    });

    test('cliente que nombra su provincia junto a otro país → NO geo-rechaza', async () => {
        const { deps, sent } = makeDeps();
        const s = baseState();
        // "Portugal" aparece, pero la clienta dice claramente que es de Galicia.
        const txt = 'vivo en galicia, cerca de la frontera con portugal';
        await handleSystemGlobals('u2@c.us', txt, norm(txt), s, deps);
        expect(s.geoRejected).toBe(false);
        expect(sent.join(' ')).not.toMatch(/dentro de España/i);
    });

    test('cliente ya geo-rechazado que aclara estar en España → levanta rechazo + pausa', async () => {
        const { deps } = makeDeps();
        const s = baseState({ geoRejected: true, step: 'rejected_geo' });
        const txt = 'no, no estoy fuera, estoy en españa, en cadiz';
        const r = await handleSystemGlobals('u3@c.us', txt, norm(txt), s, deps);
        expect(r).toEqual({ matched: true });
        expect(s.geoRejected).toBe(false);                          // levantó el rechazo
        expect(deps.sharedState.pausedUsers.has('u3@c.us')).toBe(true); // derivó a humano
    });

    test('cliente que declaró su provincia queda inmunizado a un "estoy en Francia" posterior', async () => {
        const { deps, sent } = makeDeps();
        const s = baseState();
        // M1: se identifica como de aquí (Andalucía).
        const m1 = 'cuando vuelva a españa te escribo para pedirlo. soy de andalucia';
        await handleSystemGlobals('u4@c.us', m1, norm(m1), s, deps);
        expect(s.spainConfirmed).toBe(true);
        // M2: "ahora estoy en Francia, cuando llegue lo pido" — NO debe rechazar.
        const m2 = 'prefiero las capsulas. ahora estoy en francia. cuando llegue te lo pido para 60 dias';
        const r = await handleSystemGlobals('u4@c.us', m2, norm(m2), s, deps);
        expect(s.geoRejected).toBeFalsy();
        expect(sent.join(' ')).not.toMatch(/dentro de España/i);
        expect(r).toBeNull(); // no matcheó el global de geo → sigue el flujo normal
    });

    test('"es que estoy en España" levanta un rechazo previo (no bloqueo robótico)', async () => {
        const { deps } = makeDeps();
        const s = baseState({ geoRejected: true, step: 'rejected_geo' });
        const txt = 'mi pueblo esta en la provincia de caceres, en españa, no te confundas';
        const r = await handleSystemGlobals('u5@c.us', txt, norm(txt), s, deps);
        expect(r).toEqual({ matched: true });
        expect(s.geoRejected).toBe(false);
        expect(deps.sharedState.pausedUsers.has('u5@c.us')).toBe(true);
    });

    test('cliente de aquí de viaje (extranjero + compra futura, sin nombrar España) → pausa, no rechazo', async () => {
        const { deps, sent } = makeDeps();
        const s = baseState();
        const txt = 'ahora estoy en portugal de vacaciones, cuando vuelva te lo pido';
        const r = await handleSystemGlobals('u6@c.us', txt, norm(txt), s, deps);
        expect(r).toEqual({ matched: true });
        expect(s.geoRejected).toBeFalsy();                          // no lo rechaza
        expect(deps.sharedState.pausedUsers.has('u6@c.us')).toBe(true); // deriva a humano
        expect(sent.join(' ')).not.toMatch(/dentro de España/i);
    });
});
