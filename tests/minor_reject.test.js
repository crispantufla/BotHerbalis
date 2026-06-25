/**
 * MENOR DE EDAD (globalSystem) — rechazo cuando el cliente revela ser menor de 18,
 * + sus falsos positivos.
 *
 * Caso 5493436463086 (25-jun): la clienta dijo "Te lo pido en unos días porque
 * todavía no tengo los 18" y el bot lo trató como POSTERGACIÓN ("dale, cuando estés
 * lista") en vez de rechazar por menor — el gate médico no cubría menores.
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
    step: 'waiting_payment_method', history: [], pendingCancelConfirm: false, ...extra,
});

async function run(text, stateExtra = {}) {
    const { deps, sent } = makeDeps();
    const state = baseState(stateExtra);
    const res = await handleSystemGlobals('u@c.us', text, norm(text), state, deps);
    return { res, sent, state };
}

describe('MENOR DE EDAD — rechazo', () => {
    const MINOR_CASES = [
        'Te lo pido en unos días porque todavía no tengo los 18 ok',
        'no tengo 18 años',
        'tengo 17 años',
        'tengo 15 años y quiero bajar de peso',
        'soy menor de edad',
        'todavía no cumplí 18',
        'mi hija tiene 16 años',
    ];

    test.each(MINOR_CASES)('rechaza por menor: "%s"', async (text) => {
        const { res, sent, state } = await run(text);
        expect(res).toEqual({ matched: true });
        expect(state.step).toBe('rejected_medical');
        expect(sent.join('\n')).toMatch(/menores de 18|cuando cumplas/i);
    });
});

describe('MENOR DE EDAD — NO debe gatillar (falsos positivos)', () => {
    const ADULT_CASES = [
        'tengo 25 años',
        'ya tengo 18',
        'tengo 18 años',
        'no soy menor, tengo 30',
        'quiero bajar 17 kilos',
        'tengo 17 años de casada',
        'soy mayor de edad',
        'quiero bajar 18 kilos',
    ];

    test.each(ADULT_CASES)('NO rechaza: "%s"', async (text) => {
        const { res, state } = await run(text);
        // No debe entrar a la rama de menor (ni dejar el estado en rejected_medical).
        expect(state.step).not.toBe('rejected_medical');
        // Puede devolver null (sin match de globals) o matchear OTRA cosa, pero
        // nunca el rechazo por menor → el step no cambió a rejected_medical.
        if (res && res.matched) {
            // si matcheó algo, que no haya sido por el regex de menor (step intacto)
            expect(state.step).not.toBe('rejected_medical');
        }
    });
});
