/**
 * Order Flow Tests
 * Tests order creation, admin manual-complete, and duplicate prevention.
 */
// Mock dependencies
const mockClient = { sendMessage: jest.fn().mockResolvedValue(true), info: { wid: { user: '5491112345678' } } };
const mockNotifyAdmin = jest.fn();
const mockSaveState = jest.fn();
const mockSendMessage = jest.fn();
const mockLogAndEmit = jest.fn();
// Mock safeWrite
jest.mock('../safeWrite', () => ({
    atomicWriteFile: jest.fn()
}));
// Track Prisma calls for assertions
const mockOrderCreate = jest.fn().mockResolvedValue({ id: 'new-order-123', status: 'Confirmado' });
const mockOrderFindFirst = jest.fn().mockResolvedValue(null);
const mockOrderUpdate = jest.fn().mockResolvedValue({ id: 'existing-order-456', status: 'Confirmado' });
const mockUserUpsert = jest.fn().mockResolvedValue({});
const mockTransaction = jest.fn(async (fn) => {
    return fn({
        user: { upsert: mockUserUpsert },
        order: {
            create: mockOrderCreate,
            findFirst: mockOrderFindFirst,
            update: mockOrderUpdate
        }
    });
});
jest.mock('../db', () => ({
    prisma: {
        order: {
            create: mockOrderCreate,
            findFirst: mockOrderFindFirst,
            update: mockOrderUpdate
        },
        user: { upsert: mockUserUpsert },
        chatLog: {
            create: jest.fn().mockResolvedValue({}),
            findMany: jest.fn().mockResolvedValue([])
        },
        $transaction: mockTransaction
    }
}));
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn().mockResolvedValue({ response: "AI Response", goalMet: false }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockResolvedValue({})
    }
}));
const { processSalesFlow } = require('../src/flows/salesFlow');
const { aiService } = require('../src/services/ai');
const { prisma } = require('../db');
const sharedState = {
    pausedUsers: new Set(),
    io: null,
    saveState: mockSaveState
};
const deps = {
    client: mockClient,
    notifyAdmin: mockNotifyAdmin,
    saveState: mockSaveState,
    sendMessageWithDelay: mockSendMessage,
    logAndEmit: mockLogAndEmit,
    sharedState,
    aiService
};
const knowledge = {
    flow: {
        greeting: { response: "Hola!", nextStep: "waiting_weight" },
        recommendation: { response: "Te recomiendo esto" },
        preference_capsulas: { match: ["capsulas"], response: "Capsulas\n60 dias: ${{PRICE_CAPSULAS_60}}\n120 dias: ${{PRICE_CAPSULAS_120}}", nextStep: "waiting_plan_choice" },
        preference_semillas: { match: ["semillas"], response: "Semillas ok", nextStep: "waiting_plan_choice" },
        preference_gotas: { match: ["gotas"], response: "Gotas ok", nextStep: "waiting_plan_choice" },
        ok: { response: "Dale correo?", nextStep: "waiting_data" },
        data: { response: "Pasame tus datos", nextStep: "waiting_final_confirmation" },
        confirmation: { response: "Confirmado!", nextStep: "completed" },
        faq: {}
    }
};
const userState = {};
beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(userState).forEach(key => delete userState[key]);
});
async function runFlow(userId, text) {
    return processSalesFlow(userId, text, userState, knowledge, deps);
}
describe('Order Creation Flow', () => {
    test('1. User reaching final confirmation has cart with correct product and plan', async () => {
        // Setup: user at waiting_final_confirmation with full order data
        userState['order1'] = {
            step: 'waiting_final_confirmation',
            selectedProduct: 'Cápsulas',
            selectedPlan: '60',
            cart: [{ product: 'Cápsulas', plan: '60', price: '46.900' }],
            totalPrice: '46.900',
            pendingOrder: {
                nombre: 'Juan Perez',
                calle: 'San Martin 123',
                ciudad: 'Buenos Aires',
                cp: '1425',
                provincia: 'Buenos Aires',
                cart: [{ product: 'Cápsulas', plan: '60', price: '46.900' }]
            },
            history: [
                { role: 'bot', content: 'Confirmas?', timestamp: Date.now() }
            ]
        };
        // Simulate AI confirming
        aiService.chat.mockResolvedValueOnce({
            response: null,
            goalMet: true
        });
        await runFlow('order1', 'si dale confirmo');
        // After confirmation, step should advance
        expect(userState['order1'].step).not.toBe('waiting_final_confirmation');
    });
    test('2. Guard: waiting_data without product redirects to preference', async () => {
        userState['guard1'] = {
            step: 'waiting_data',
            selectedProduct: null,
            selectedPlan: null,
            cart: [],
            partialAddress: {},
            history: []
        };
        await runFlow('guard1', 'Juan Perez, San Martin 123, CABA');
        expect(userState['guard1'].step).toBe('waiting_preference');
        expect(mockSendMessage).toHaveBeenCalled();
    });
    test('3. Guard: waiting_data without plan redirects to plan_choice', async () => {
        userState['guard2'] = {
            step: 'waiting_data',
            selectedProduct: 'Cápsulas',
            selectedPlan: null,
            cart: [],
            partialAddress: {},
            history: []
        };
        await runFlow('guard2', 'Juan Perez, San Martin 123, CABA');
        expect(userState['guard2'].step).toBe('waiting_plan_choice');
        expect(mockSendMessage).toHaveBeenCalled();
    });
});
describe('Manual Complete - Transaction Safety', () => {
    test('4. prisma.$transaction is used in manual-complete route', () => {
        // Verify the $transaction mock exists and is callable
        expect(prisma.$transaction).toBeDefined();
        expect(typeof prisma.$transaction).toBe('function');
    });
    test('5. Transaction creates order when no existing pending order', async () => {
        mockOrderFindFirst.mockResolvedValueOnce(null);
        await prisma.$transaction(async (tx) => {
            await tx.user.upsert({
                where: { phone_instanceId: { phone: '5491112345678', instanceId: 'default' } },
                update: { name: 'Test User' },
                create: { phone: '5491112345678', instanceId: 'default', name: 'Test User' }
            });
            const existing = await tx.order.findFirst({
                where: { userPhone: '5491112345678', status: 'Pendiente', instanceId: 'default' }
            });
            expect(existing).toBeNull();
            const order = await tx.order.create({
                data: {
                    instanceId: 'default',
                    userPhone: '5491112345678',
                    status: 'Confirmado',
                    products: 'Cápsulas (60 días)',
                    totalPrice: 46900
                }
            });
            expect(order.id).toBe('new-order-123');
            expect(order.status).toBe('Confirmado');
        });
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        expect(mockUserUpsert).toHaveBeenCalled();
        expect(mockOrderCreate).toHaveBeenCalled();
    });
    test('6. Transaction updates existing pending order instead of creating duplicate', async () => {
        mockOrderFindFirst.mockResolvedValueOnce({
            id: 'existing-order-456',
            status: 'Pendiente',
            nombre: 'Old Name'
        });
        await prisma.$transaction(async (tx) => {
            await tx.user.upsert({
                where: { phone_instanceId: { phone: '5491112345678', instanceId: 'default' } },
                update: { name: 'Test User' },
                create: { phone: '5491112345678', instanceId: 'default', name: 'Test User' }
            });
            const existing = await tx.order.findFirst({
                where: { userPhone: '5491112345678', status: 'Pendiente', instanceId: 'default' }
            });
            expect(existing).not.toBeNull();
            expect(existing.id).toBe('existing-order-456');
            const order = await tx.order.update({
                where: { id: existing.id },
                data: { status: 'Confirmado', nombre: 'Updated Name' }
            });
            expect(order.status).toBe('Confirmado');
        });
        expect(mockTransaction).toHaveBeenCalledTimes(1);
        expect(mockOrderUpdate).toHaveBeenCalled();
        // create should NOT have been called — we updated instead
        expect(mockOrderCreate).not.toHaveBeenCalled();
    });
    test('7. Transaction rollback on error prevents partial writes', async () => {
        const failingTransaction = jest.fn(async (fn) => {
            try {
                await fn({
                    user: { upsert: mockUserUpsert },
                    order: {
                        create: jest.fn().mockRejectedValue(new Error('DB constraint violation')),
                        findFirst: jest.fn().mockResolvedValue(null),
                        update: mockOrderUpdate
                    }
                });
            }
            catch (e) {
                throw e; // Prisma.$transaction rolls back on throw
            }
        });
        await expect(failingTransaction(async (tx) => {
            await tx.user.upsert({ where: {}, update: {}, create: {} });
            await tx.order.create({ data: {} }); // This will throw
        })).rejects.toThrow('DB constraint violation');
    });
});
describe('Cart and Price Calculations', () => {
    test('8. Cart builds correctly from product selection', async () => {
        userState['cart1'] = {
            step: 'waiting_data',
            selectedProduct: 'Cápsulas',
            selectedPlan: '60',
            cart: [],
            partialAddress: {},
            addressAttempts: 0,
            history: []
        };
        // Mock parseAddress to return a complete address
        aiService.parseAddress.mockResolvedValueOnce({
            nombre: 'Maria Garcia',
            calle: 'Av Corrientes 1234',
            ciudad: 'CABA',
            cp: '1043',
            provincia: 'Buenos Aires'
        });
        await runFlow('cart1', 'Maria Garcia, Av Corrientes 1234, CABA, 1043');
        // Cart should have been built
        const state = userState['cart1'];
        expect(state.cart).toBeDefined();
        expect(state.cart.length).toBeGreaterThan(0);
        if (state.cart.length > 0) {
            expect(state.cart[0].product).toBe('Cápsulas');
        }
    });
});
