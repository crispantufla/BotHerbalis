/**
 * F2 (26 charlas): la confirmación no debe salir con plan/precio incoherentes
 * (caso 3446661083: "Plan: 120 días / Total: $44.900"). Si el cart de un solo ítem
 * tiene un precio que no coincide con _getPrice(producto, plan), el bot pausa en vez
 * de confirmar. Y el armado normal del cart usa _getPrice (precio siempre coherente).
 */
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../db', () => ({
    prisma: {
        user: { upsert: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        order: { create: jest.fn().mockResolvedValue({ id: 'o1' }), findFirst: jest.fn().mockResolvedValue(null) },
    },
}));
jest.mock('../src/services/funnelLogger', () => ({
    logStepTransition: jest.fn(), markExit: jest.fn().mockResolvedValue(undefined), logMessage: jest.fn().mockResolvedValue(undefined),
}));

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const { handleWaitingData } = require('../src/flows/steps/stepWaitingData');
const { _getPrice } = require('../src/flows/utils/pricing');

const makeDeps = () => {
    const sent = [];
    return {
        sent,
        sendMessageWithDelay: async (_id, m) => { sent.push(m); },
        saveState: jest.fn(),
        aiService: {},
        notifyAdmin: jest.fn().mockResolvedValue(undefined),
        sharedState: { pausedUsers: new Set(), io: null },
    };
};

describe('F2 — coherencia plan/precio en la confirmación', () => {
    test('cart con plan 120 a precio de 60 → pausa, NO confirma', async () => {
        const deps = makeDeps();
        const state = {
            step: 'waiting_data', shippingChoice: 'retiro', paymentMethod: 'contrarembolso',
            selectedProduct: 'Cápsulas de nuez de la india', selectedPlan: '120',
            partialAddress: { calle: 'A sucursal', nombre: 'Maria Jose', ciudad: 'Merlo', cp: '1716' },
            cart: [{ product: 'Cápsulas de nuez de la india', plan: '120', price: '44.900' }], // ✗ 120 a precio de 60
            history: [],
        };
        const res = await handleWaitingData('f2a@c.us', 'listo', norm('listo'), state, { flow: {} }, deps);
        expect(res.matched).toBe(true);
        expect(state.step).not.toBe('waiting_final_confirmation');
        expect(deps.sharedState.pausedUsers.has('f2a@c.us')).toBe(true);
        expect(deps.sent.join(' ')).not.toMatch(/CONFIRMACIÓN DE PEDIDO|CONFIRMACIÓN DE ENVÍO/);
    });

    test('cart armado por el flujo usa _getPrice → confirma coherente', async () => {
        const deps = makeDeps();
        const state = {
            step: 'waiting_data', shippingChoice: 'retiro', paymentMethod: 'contrarembolso',
            selectedProduct: 'Cápsulas de nuez de la india', selectedPlan: '120',
            partialAddress: { calle: 'A sucursal', nombre: 'Maria Jose', ciudad: 'Merlo', cp: '1716' },
            cart: [], history: [], // sin cart → el flujo lo arma con _getPrice
        };
        const res = await handleWaitingData('f2b@c.us', 'listo', norm('listo'), state, { flow: {} }, deps);
        expect(res.matched).toBe(true);
        // El bot cierra la venta solo: coherente → cierra directo (no espera "sí" ni admin).
        expect(state.step).toBe('completed');
        expect(state.cart[0].price).toBe(_getPrice('Cápsulas de nuez de la india', '120'));
        expect(deps.sharedState.pausedUsers.has('f2b@c.us')).toBe(false);
    });
});
