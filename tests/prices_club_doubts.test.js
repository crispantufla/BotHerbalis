/**
 * Guion por zona: después del saludo ("¿Te paso los precios?") el paso mandaba
 * la lista de precios a CUALQUIER respuesta. Revisión de charlas del 12-nov-2026:
 * "Quita el apetito?", "Tengo los triglicéridos alto y diabetes", "Ablame de esta
 * medicación" y un audio con cinco preguntas recibieron solo los precios.
 * Ahora la duda la contesta la IA y después va la lista.
 */
jest.mock('../db', () => ({ prisma: {} }));
jest.mock('../src/services/ai', () => ({
    aiService: { chat: jest.fn(), checkAndSummarize: jest.fn(), parseAddress: jest.fn() },
}));

const knowledge = require('../knowledge_v7.json');
const { handleWaitingWeight } = require('../src/flows/steps/stepWaitingWeight');
const { aiService } = require('../src/services/ai');

const USER = '5493410000004@c.us';
const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

async function run(text) {
    const sent = [];
    const state = { step: 'waiting_weight', history: [], cart: [] };
    const deps = {
        sendMessageWithDelay: jest.fn(async (_id, msg) => { sent.push(msg); return true; }),
        saveState: jest.fn(),
        aiService,
        config: {},
        sharedState: { pausedUsers: new Set(), config: {} },
    };
    await handleWaitingWeight(USER, text, norm(text), state, knowledge, deps);
    return { sent, state };
}

beforeEach(() => {
    aiService.chat.mockReset().mockResolvedValue({ response: 'RESPUESTA A LA DUDA. Te paso los precios 👇', goalMet: false, extractedData: null });
});

describe('respuesta al saludo en el guion por zona', () => {
    test.each([
        'Quita el apetito?',
        'Tengo los triglicéridos alto y diabetes',
        'Ablame de esta medicación',
        'Pásame el precio y como tengo que tomarlo gracias slds',
        'Hola, buen día. Si yo necesito bajar varios kilos arriba de 10 y quería saber qué tal estaba este producto y qué efecto te hace. Te ayuda con la ansiedad',
    ])('"%s" → primero responde la IA, después la lista de precios', async (text) => {
        const { sent, state } = await run(text);
        expect(aiService.chat).toHaveBeenCalledTimes(1);
        expect(aiService.chat.mock.calls[0][1].goal).toMatch(/NO escribas precios/);
        expect(sent).toHaveLength(2);
        expect(sent[0]).toMatch(/RESPUESTA A LA DUDA/);
        expect(sent[1]).toMatch(/Estos son los precios/);
        expect(state.step).toBe('waiting_preference');
    });

    test.each(['Si', 'Ok.', 'dale', 'Q sale', 'precio', 'Hasta 10 kilos...', 'Menos 6kg', '12k'])(
        '"%s" → la lista de precios sola, sin gastar IA', async (text) => {
            const { sent, state } = await run(text);
            expect(aiService.chat).not.toHaveBeenCalled();
            expect(sent).toHaveLength(1);
            expect(sent[0]).toMatch(/Estos son los precios/);
            expect(state.step).toBe('waiting_preference');
        });

    test('si la IA falla, igual sale la lista de precios', async () => {
        aiService.chat.mockRejectedValue(new Error('sin saldo'));
        const { sent } = await run('Quita el apetito?');
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatch(/Estos son los precios/);
    });

    test('una imagen que llega como texto en base64 no se manda a la IA', async () => {
        const { sent } = await run('/9j/4AAQSkZJRgABAgAAAQABAAD' + 'A'.repeat(400));
        expect(aiService.chat).not.toHaveBeenCalled();
        expect(sent).toHaveLength(1);
    });
});
