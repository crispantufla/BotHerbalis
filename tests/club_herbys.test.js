/**
 * Club Herbys — la conversación de la promo (src/flows/clubHerbys.ts) entrando
 * por processSalesFlow, con Claude simulado. Guion: docs/guion-rosario.pdf.
 */
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../src/services/funnelLogger', () => {
    const ok = () => jest.fn().mockResolvedValue(undefined);
    return { logStepTransition: ok(), markExit: ok(), incrementMessageCount: ok(), incrementAiCallCount: ok(), logMessage: ok(), markStaleAsDropped: ok(), STEP_ORDER: [] };
});

const mockDb = {
    promoRecipient: { findFirst: jest.fn().mockResolvedValue({ id: 'r1', repliedAt: null }), update: jest.fn().mockResolvedValue({}) },
    user: { upsert: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
    chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    order: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
};
jest.mock('../db', () => ({ prisma: mockDb }));

const { processSalesFlow } = require('../src/flows/salesFlow');
const { TEXTS, parseDecision, isSafeReply, MAX_AI_TURNS } = require('../src/flows/clubHerbys');
const { renderBaseMessage } = require('../src/services/promo/promoDispatcher');
const { DEFAULT_BASE_MESSAGE } = require('../src/services/promo/promoVariation');

const USER = '5493410000001@c.us';

function promoState(over = {}) {
    return {
        step: 'promo_offer', history: [{ role: 'bot', content: 'BENEFICIO ESPECIAL HERBALIS + CLUB HERBYS …', timestamp: Date.now() - 3600000 }],
        cart: [], partialAddress: {}, summary: '',
        promo: { active: true, campaignId: 'c1', sentAt: Date.now() - 3600000, price60: '-', prevStep: null, outcome: null },
        ...over,
    };
}

/** Claude simulado: devuelve en orden los textos de `replies`. */
function deps(replies) {
    const queue = [...replies];
    const create = jest.fn(async () => {
        const r = queue.shift();
        if (r instanceof Error) throw r;
        return { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: r }] };
    });
    const userState = {};
    const sharedState = { sellerId: 'clubherbys', pausedUsers: new Set(), logAndEmit: jest.fn(), userState };
    return {
        userState,
        create,
        d: {
            // Como el real: lo que sale queda en el historial (ver phantom_history.test.js).
            sendMessageWithDelay: jest.fn(async (uid, msg) => { userState[uid]?.history.push({ role: 'bot', content: msg }); return true; }),
            saveState: jest.fn(),
            notifyAdmin: jest.fn().mockResolvedValue(undefined),
            sharedState,
            sellerId: 'clubherbys',
            config: {},
            aiService: { anthropic: { messages: { create } }, chat: jest.fn() },
        },
    };
}
const J = (decision, respuesta = '') => JSON.stringify({ decision, respuesta });
const sent = (d) => d.sendMessageWithDelay.mock.calls.map((c) => c[1]);
const say = (t, ctx) => processSalesFlow(USER, t, ctx.userState, {}, ctx.d);

beforeEach(() => jest.clearAllMocks());

describe('quién recibe respuesta', () => {
    test('sin promo activa sigue el guion de venta de Herbalis, no el de Club Herbys', async () => {
        const ctx = deps([J('acepta')]);
        const knowledge = require('../knowledge_v7.json');
        await processSalesFlow(USER, 'hola', ctx.userState, knowledge, ctx.d);
        expect(ctx.create).not.toHaveBeenCalled();   // la IA de Club Herbys no se usa
        const sent = ctx.d.sendMessageWithDelay.mock.calls.map((c) => c[1]).join('\n');
        expect(sent).toMatch(/Soy Elena de Herbalis/);
        expect(sent).not.toMatch(/Club Herbys/);
        expect(ctx.userState[USER].promo).toBeFalsy();
    });

    test('chat cerrado: no contesta, le reenvía el mensaje a la asesora', async () => {
        const ctx = deps([J('responder', 'x')]);
        ctx.userState[USER] = promoState();
        ctx.userState[USER].promo.closed = true;
        await say('che, y entonces?', ctx);
        expect(ctx.create).not.toHaveBeenCalled();
        expect(ctx.d.sendMessageWithDelay).not.toHaveBeenCalled();
        expect(ctx.d.notifyAdmin).toHaveBeenCalledWith(expect.stringMatching(/Volvió a escribir/), USER, expect.stringContaining('che, y entonces?'));
    });
});

describe('los caminos del guion', () => {
    test('acepta → confirmación fija, aviso, pausa y cierre', async () => {
        const ctx = deps([J('acepta')]);
        ctx.userState[USER] = promoState();
        const r = await say('Si, lo quiero!', ctx);
        expect(r.paused).toBe(true);
        expect(sent(ctx.d)).toEqual([TEXTS.C]);
        expect(ctx.d.notifyAdmin).toHaveBeenCalledWith(expect.stringMatching(/ACEPTÓ/), USER, expect.stringContaining('Si, lo quiero!'));
        expect(ctx.d.sharedState.pausedUsers.has(USER)).toBe(true);
        expect(ctx.userState[USER].promo).toMatchObject({ outcome: 'accepted', closed: true });
    });

    test('duda que la referencia contesta → responde la IA y sigue abierto; después acepta', async () => {
        const ctx = deps([J('responder', 'Claro 😊 Abonás $18.900 al recibir y después 4 cuotas semanales de $7.900. ¿Lo querés aprovechar?'), J('acepta')]);
        ctx.userState[USER] = promoState();
        await say('como es eso?', ctx);
        expect(sent(ctx.d)).toEqual([expect.stringContaining('$18.900')]);
        expect(ctx.userState[USER].promo.closed).toBeFalsy();
        expect(ctx.d.sharedState.pausedUsers.has(USER)).toBe(false);
        await say('dale', ctx);
        expect(sent(ctx.d)[1]).toBe(TEXTS.C);
        // La IA recibe la charla con turnos alternados y termina en el mensaje de la persona.
        const msgs = ctx.create.mock.calls[1][0].messages;
        expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'dale' });
        expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    });

    test('derivar → texto fijo de derivación, aviso y cierre', async () => {
        const ctx = deps([J('derivar')]);
        ctx.userState[USER] = promoState();
        await say('y llegan a Casilda?', ctx);
        expect(sent(ctx.d)).toEqual([TEXTS.E]);
        expect(ctx.d.notifyAdmin).toHaveBeenCalledWith(expect.stringMatching(/asesora/), USER, expect.stringContaining('Casilda'));
        expect(ctx.userState[USER].promo.closed).toBe(true);
    });

    test('no → despedida, cierre sin aviso', async () => {
        const ctx = deps([J('no')]);
        ctx.userState[USER] = promoState();
        await say('no gracias', ctx);
        expect(sent(ctx.d)).toEqual([TEXTS.F]);
        expect(ctx.d.notifyAdmin).not.toHaveBeenCalled();
        expect(mockDb.promoRecipient.findFirst).toHaveBeenCalled();
    });

    test('baja → disculpa y se anota opted_out', async () => {
        const ctx = deps([J('baja')]);
        ctx.userState[USER] = promoState();
        await say('no me escriban mas', ctx);
        expect(sent(ctx.d)).toEqual([TEXTS.G]);
        await new Promise((r) => setImmediate(r));
        expect(mockDb.promoRecipient.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ outcome: 'opted_out', status: 'opted_out' }) }));
    });
});

describe('red de seguridad', () => {
    test('si la IA falla o devuelve basura, deriva (nunca adivina un sí)', async () => {
        for (const reply of [new Error('529 overloaded'), 'no es json', J('quizas'), J('responder', '')]) {
            const ctx = deps([reply]);
            ctx.userState[USER] = promoState();
            await say('hola', ctx);
            expect(sent(ctx.d)).toEqual([TEXTS.E]);
        }
    });

    test('una respuesta con otro monto, el total o kilos no sale: deriva', async () => {
        for (const bad of ['Son $50.500 en total 😊', 'El total es 50.500', 'El anticipo es $18.000', 'Con esto bajás 20 kilos', 'Bajás 15kg en un mes', 'Resultados garantizados 💯','Sale $20.000 de anticipo', 'Mirá https://x.com']) {
            const ctx = deps([J('responder', bad)]);
            ctx.userState[USER] = promoState();
            await say('cuanto es?', ctx);
            expect(sent(ctx.d)).toEqual([TEXTS.E]);
        }
    });

    test(`después de ${MAX_AI_TURNS} respuestas sin decidir, deriva`, async () => {
        const ok = J('responder', 'Es el plan de Gotas Herbalis por 60 días 😊 ¿Lo querés aprovechar?');
        const ctx = deps(Array(MAX_AI_TURNS + 1).fill(ok));
        ctx.userState[USER] = promoState();
        for (let i = 0; i < MAX_AI_TURNS + 1; i++) await say(`pregunta ${i}`, ctx);
        expect(sent(ctx.d).slice(-1)).toEqual([TEXTS.E]);
        expect(sent(ctx.d).filter((t) => t !== TEXTS.E)).toHaveLength(MAX_AI_TURNS);
    });

    test('parseDecision / isSafeReply', () => {
        expect(parseDecision('```json\n{"decision":"acepta","respuesta":""}\n```')).toEqual({ decision: 'acepta', respuesta: '' });
        expect(parseDecision(null).decision).toBe('derivar');
        expect(isSafeReply('Abonás $18.900 al recibir y 4 cuotas de $7.900')).toBe(true);
        expect(isSafeReply('Son $ 50.500')).toBe(false);
        // Hablar de bajar de peso está bien, con los 10 kg del guion de Herbalis.
        expect(isSafeReply('Son gotas para bajar de peso de forma natural; el plan de 60 días es para bajar hasta 10 kg 💚')).toBe(true);
        expect(isSafeReply('Se toman 10 gotas al día, 30 minutos antes del almuerzo o la cena')).toBe(true);
    });
});

describe('texto de la promo', () => {
    test('las variantes cambian el texto pero nunca los montos ni el producto', () => {
        const seen = new Set();
        for (let i = 0; i < 500; i++) {
            const t = renderBaseMessage(DEFAULT_BASE_MESSAGE, i % 2 ? 'Ana' : null);
            expect(t).toContain('$18.900');
            expect(t).toContain('4 cuotas semanales de $7.900');
            expect(t).toContain('Gotas Herbalis por 60 días');
            expect(t).not.toMatch(/[{}|]/);   // ningún grupo sin resolver
            seen.add(t);
        }
        expect(seen.size).toBeGreaterThan(300);   // casi todos distintos
    });

    test('el mensaje por defecto lleva los montos nuevos y varía el saludo y el nombre', () => {
        const a = renderBaseMessage(DEFAULT_BASE_MESSAGE, 'MARÍA pérez', () => 0);
        expect(a.startsWith('¡Hola María! 👋')).toBe(true);
        expect(a).toContain('$18.900');
        expect(a).toContain('4 cuotas semanales de $7.900');
        expect(a).toContain('Gotas Herbalis por 60 días');
        const b = renderBaseMessage(DEFAULT_BASE_MESSAGE, '+54 9 341 555', () => 0.5);
        expect(b.startsWith('Buenas! 😊')).toBe(true);
    });
});
