/**
 * GEO reject (globalSystem) — rechazo de envíos fuera de Argentina + sus falsos
 * positivos.
 *
 * Bug 2026-06-04 (reporte 5493442409792): un cliente de *Concepción del Uruguay*
 * (Entre Ríos, Argentina) fue geo-rechazado porque el texto contiene "Uruguay", y
 * además quedó pegado en el bloqueo: aunque aclaró "es Concepción del Uruguay,
 * Entre Ríos, Argentina", el bot repitió el rechazo 4 veces (intervino el admin).
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
        sharedState: { pausedUsers: new Set(), io: null, sellerId: 'horacio' },
    };
    return { deps, sent };
}

const baseState = (extra = {}) => ({
    step: 'waiting_preference', history: [], pendingCancelConfirm: false, geoRejected: false, ...extra,
});

describe('GEO reject', () => {
    test('extranjero real ("estoy en uruguay") → geo-rechaza', async () => {
        const { deps, sent } = makeDeps();
        const s = baseState();
        const txt = 'estoy en uruguay';
        const r = await handleSystemGlobals('u1@c.us', txt, norm(txt), s, deps);
        expect(r).toEqual({ matched: true });
        expect(s.geoRejected).toBe(true);
        expect(sent.join(' ')).toMatch(/dentro de Argentina/i);
    });

    test('Concepción del Uruguay (Entre Ríos) → NO geo-rechaza', async () => {
        const { deps, sent } = makeDeps();
        const s = baseState();
        const txt = 'estoy en concepcion del uruguay, entre rios';
        await handleSystemGlobals('u2@c.us', txt, norm(txt), s, deps);
        expect(s.geoRejected).toBe(false);
        expect(sent.join(' ')).not.toMatch(/dentro de Argentina/i);
    });

    test('cliente ya geo-rechazado que aclara estar en Argentina → levanta rechazo + pausa', async () => {
        const { deps } = makeDeps();
        const s = baseState({ geoRejected: true, step: 'rejected_geo' });
        const txt = 'no es la republica oriental, es concepcion del uruguay, entre rios, argentina';
        const r = await handleSystemGlobals('u3@c.us', txt, norm(txt), s, deps);
        expect(r).toEqual({ matched: true });
        expect(s.geoRejected).toBe(false);                       // levantó el rechazo
        expect(deps.sharedState.pausedUsers.has('u3@c.us')).toBe(true); // derivó a humano
    });

    // Caso Claromecó (jun-2026): clienta argentina del sur de prov. de Bs. As. que
    // está temporalmente en Europa y compra al volver. El bot la geo-rechazó por la
    // keyword "Europa", la bloqueó robóticamente ante "queda dentro de Argentina" y
    // solo cedió tras "es Argentina te acabo de decir!!!" (ya enojada).
    test('argentino que declaró su provincia queda inmunizado a un "estoy en Europa" posterior', async () => {
        const { deps, sent } = makeDeps();
        const s = baseState();
        // M7: se identifica como argentina (sur de prov. de Bs. As.)
        const m7 = 'cuando regrese a argentina te contacto para comprar. soy del sur de prov de bs as';
        await handleSystemGlobals('u4@c.us', m7, norm(m7), s, deps);
        expect(s.argentineConfirmed).toBe(true);
        // M9: "ahora estoy en Europa, cuando llegue te compro" — NO debe rechazar
        const m9 = 'prefiero las capsulas. ahora estoy en europa. cuando llegue te compro para 60 dias';
        const r = await handleSystemGlobals('u4@c.us', m9, norm(m9), s, deps);
        expect(s.geoRejected).toBeFalsy();
        expect(sent.join(' ')).not.toMatch(/dentro de Argentina/i);
        expect(r).toBeNull(); // no matcheó el global de geo → sigue el flujo normal
    });

    test('"queda dentro de Argentina" levanta un rechazo previo (no bloqueo robótico)', async () => {
        const { deps } = makeDeps();
        const s = baseState({ geoRejected: true, step: 'rejected_geo' });
        const txt = 'mi localidad se llama claromeco y queda dentro de argentina, sobre el atlantico';
        const r = await handleSystemGlobals('u5@c.us', txt, norm(txt), s, deps);
        expect(r).toEqual({ matched: true });
        expect(s.geoRejected).toBe(false);
        expect(deps.sharedState.pausedUsers.has('u5@c.us')).toBe(true);
    });

    test('argentino de viaje (exterior + compra futura, sin nombrar Argentina) → pausa, no rechazo', async () => {
        const { deps, sent } = makeDeps();
        const s = baseState();
        const txt = 'ahora estoy en europa de vacaciones, cuando vuelva te compro';
        const r = await handleSystemGlobals('u6@c.us', txt, norm(txt), s, deps);
        expect(r).toEqual({ matched: true });
        expect(s.geoRejected).toBeFalsy();                       // no lo rechaza
        expect(deps.sharedState.pausedUsers.has('u6@c.us')).toBe(true); // deriva a humano
        expect(sent.join(' ')).not.toMatch(/dentro de Argentina/i);
    });
});
