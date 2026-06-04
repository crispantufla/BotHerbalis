/**
 * Cancelación: al DECLINAR la cancelación, el bot debe RETOMAR el hilo (re-enviar
 * el último prompt real), no soltar con un genérico "¿en qué te puedo ayudar?".
 *
 * Reporte 5491157450451: el cliente venía de "¿confirmás que podés retirar?"; un
 * audio se transcribió "...me arrepentí ya" → cancel-confirm; el cliente aclaró
 * "no, voy a retirar, afirmativo" y el bot perdió el hilo de la confirmación.
 */

const { handleSystemGlobals } = require('../src/flows/globals/globalSystem');

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }), { virtual: true });
jest.mock('../db', () => ({
    prisma: { user: { upsert: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) } },
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

describe('Cancelación — declinar retoma el hilo', () => {
    test('"no, voy a retirar, afirmativo" → re-envía el prompt de confirmación, no el genérico', async () => {
        const { deps, sent } = makeDeps();
        const state = {
            step: 'waiting_admin_validation',
            pendingCancelConfirm: true,
            geoRejected: false,
            history: [
                { role: 'bot', content: '¡Dale! ¿Confirmás que podés ir a retirar el pedido a la sucursal del Correo Argentino? 😊', timestamp: 1 },
                { role: 'user', content: 'me arrepenti', timestamp: 2 },
                { role: 'bot', content: '¿Estás seguro/a de que no querés continuar? Respondé sí para cancelar o no para seguir.', timestamp: 3 },
            ],
        };
        const txt = 'no, voy a retirar, afirmativo';
        const r = await handleSystemGlobals('c1@c.us', txt, norm(txt), state, deps);

        expect(r).toEqual({ matched: true });
        expect(state.pendingCancelConfirm).toBe(false);
        const lastSent = sent[sent.length - 1];
        expect(lastSent).toMatch(/pod[ée]s ir a retirar/i);            // retomó el prompt previo
        expect(lastSent).not.toMatch(/en qu[ée] te puedo ayudar/i);     // NO el genérico que soltaba el hilo
    });

    test('confirmar la cancelación ("sí, cancelar") sigue cancelando + pausa', async () => {
        const { deps } = makeDeps();
        const state = {
            step: 'waiting_admin_validation',
            pendingCancelConfirm: true,
            geoRejected: false,
            history: [{ role: 'bot', content: '¿Estás seguro/a de que no querés continuar? Respondé sí para cancelar o no para seguir.', timestamp: 1 }],
        };
        const txt = 'si, cancelar';
        const r = await handleSystemGlobals('c2@c.us', txt, norm(txt), state, deps);
        expect(r).toEqual({ matched: true });
        expect(state.pendingCancelConfirm).toBe(false);
        expect(deps.sharedState.pausedUsers.has('c2@c.us')).toBe(true);
    });
});
