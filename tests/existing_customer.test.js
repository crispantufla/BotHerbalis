/**
 * El cliente avisa que ya compró y lo está tomando: no se le vende.
 * Caso del 12-nov-2026: "No ya compre las gotas estoy tomándolas en cuanto se ve
 * el resultado" → el bot leyó "gotas" como elección y le pidió la localidad
 * cuatro veces.
 */
jest.mock('../db', () => ({ prisma: {} }));
jest.mock('../src/services/ai', () => ({ aiService: { chat: jest.fn() } }));

const knowledge = require('../knowledge_v7.json');
const { handleExistingCustomer } = require('../src/flows/globals/globalExistingCustomer');
const { aiService } = require('../src/services/ai');

const USER = '5493410000006@c.us';
const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

async function run(text, state) {
    const sent = [];
    const deps = { sendMessageWithDelay: jest.fn(async (_id, m) => { sent.push(m); return true; }), saveState: jest.fn(), aiService };
    const res = await handleExistingCustomer(USER, text, norm(text), state, knowledge, deps);
    return { res, sent };
}
const lead = (o = {}) => ({ step: 'waiting_weight', history: [], cart: [{ product: 'Gotas', plan: '60', price: '44.000' }], selectedPlan: '60', ...o });

beforeEach(() => aiService.chat.mockReset().mockResolvedValue({ response: 'Cada cuerpo tiene su ritmo 😊', goalMet: false, extractedData: null }));

describe('cliente que avisa que ya compró', () => {
    test.each([
        'No ya compre las gotas estoy tomándolas  en cuanto se ve el resultado',
        'Ya lo compre te decia',
        'hace una semana me lo trajeron los estoy tomando',
        'ya las tengo, gracias',
        'ya soy clienta',
    ])('"%s" → responde sin vender y queda como post-venta', async (text) => {
        const state = lead();
        const { res, sent } = await run(text, state);
        expect(res).toEqual({ matched: true });
        expect(sent).toEqual(['Cada cuerpo tiene su ritmo 😊']);
        expect(aiService.chat.mock.calls[0][1].goal).toMatch(/YA COMPRÓ/);
        expect(state.step).toBe('completed');
        expect(state.hasSoldBefore).toBe(true);
        expect(state.cart).toEqual([]);
    });

    test.each([
        'ya compre antes y quiero pedir de nuevo',
        'ya lo tengo decidido, las capsulas',
        'las gotas',
        'se me termino, necesito otro',
    ])('"%s" → no lo intercepta (es una venta o una elección)', async (text) => {
        const { res, sent } = await run(text, lead());
        expect(res).toBeNull();
        expect(sent).toEqual([]);
    });

    test('si la IA falla va una respuesta fija, igual sin vender', async () => {
        aiService.chat.mockRejectedValue(new Error('sin saldo'));
        const state = lead();
        const { sent } = await run('ya lo compre', state);
        expect(sent[0]).toMatch(/ya lo estás tomando/);
        expect(state.step).toBe('completed');
    });

    test('no actúa con el pedido ya en la toma de datos ni en una charla de campaña', async () => {
        expect((await run('ya lo compre', lead({ step: 'waiting_data' }))).res).toBeNull();
        expect((await run('ya lo compre', lead({ promo: { active: true } }))).res).toBeNull();
    });
});
