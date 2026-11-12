/**
 * Global "cambiar el pedido" (globalSystem, punto 4).
 *
 * Caso del 12-nov-2026: una clienta de 73 años mandó un audio con
 * cinco dudas — "son de Herbalife o es otra cosa? tengo miedo que me haga mal,
 * decime cómo se toma..." — y el bot contestó "Volvamos a elegir", porque "otra
 * cosa" contaba como pedido de cambio aunque no había elegido nada.
 */
jest.mock('../db', () => ({ prisma: {} }));

const { handleSystemGlobals } = require('../src/flows/globals/globalSystem');

const USER = '5493410000002@c.us';
const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function run(text, state) {
    const sent = [];
    const deps = {
        sendMessageWithDelay: jest.fn(async (_id, msg) => { sent.push(msg); return true; }),
        saveState: jest.fn(),
        aiService: {},
    };
    return handleSystemGlobals(USER, text, norm(text), state, deps).then((res) => ({ res, sent }));
}

const AUDIO = 'Explicame, son de Herbalice o es otra cosa? Y decime, o sea yo creo que tengo miedo que me hagan mal Decime como se toma y si eso quita el apetito, hay que hacer una dieta de comida, explicame algo';

describe('global de cambio de pedido', () => {
    test('un audio con dudas que dice "es otra cosa" NO reinicia la elección', async () => {
        const state = { step: 'waiting_preference', history: [], cart: [], selectedProduct: null };
        const { res, sent } = await run(AUDIO, state);
        expect(sent.join(' ')).not.toMatch(/Volvamos a elegir/);
        expect(res?.matched).not.toBe(true);
    });

    test('con producto elegido, "es otra cosa?" como duda tampoco borra el pedido', async () => {
        const state = { step: 'waiting_plan_choice', history: [], cart: [{ product: 'Cápsulas', plan: '60', price: '47.000' }], selectedProduct: 'Cápsulas' };
        const { sent } = await run(AUDIO, state);
        expect(sent.join(' ')).not.toMatch(/Volvamos a elegir/);
        expect(state.selectedProduct).toBe('Cápsulas');
    });

    test.each(['quiero cambiar el producto', 'mejor otra cosa', 'en vez de cápsulas quiero gotas'])(
        'con producto elegido, "%s" sí vuelve a la elección', async (text) => {
            const state = { step: 'waiting_plan_choice', history: [], cart: [{ product: 'Cápsulas', plan: '60', price: '47.000' }], selectedProduct: 'Cápsulas' };
            const { res, sent } = await run(text, state);
            expect(sent.join(' ')).toMatch(/Volvamos a elegir/);
            expect(res).toEqual({ matched: true });
            expect(state.step).toBe('waiting_preference');
        });

    test('sin nada elegido, "quiero cambiar" no hace nada acá (lo maneja el paso)', async () => {
        const state = { step: 'waiting_preference', history: [], cart: [], selectedProduct: null };
        const { sent } = await run('quiero cambiar', state);
        expect(sent.join(' ')).not.toMatch(/Volvamos a elegir/);
    });
});
