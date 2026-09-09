/**
 * POST /orders/manual-complete es el camino por el que el admin rescata una
 * venta que el bot no pudo cerrar. Era una función de 463 líneas sin cobertura
 * real (order_flow.test.js verifica el mock de $transaction, no este código).
 *
 * Al partirla en pasos con nombre quedaron testeables, así que acá se fijan los
 * casos reales que los motivaron — que hasta ahora solo vivían como comentarios.
 */
require('dotenv').config();
const mc = require('../src/api/routes/manualComplete');

describe('collectAddress', () => {
    // Caso Elvira 27/04/2026: partialAddress se lo limpian las transiciones de
    // step mientras pendingOrder sobrevive. Leer partialAddress solo producía
    // órdenes vacías.
    test('pendingOrder le gana a partialAddress', () => {
        const state = {
            pendingOrder: { nombre: 'Elvira', calle: 'San Martín 123', ciudad: 'Rosario' },
            partialAddress: { nombre: 'viejo', calle: null, ciudad: null },
        };
        const addr = mc.collectAddress(state);
        expect(addr.nombre).toBe('Elvira');
        expect(addr.calle).toBe('San Martín 123');
        expect(addr.ciudad).toBe('Rosario');
    });

    test('cae a partialAddress cuando pendingOrder no tiene el campo', () => {
        const state = { pendingOrder: { nombre: 'Ana' }, partialAddress: { cp: '2000', ciudad: 'Rosario' } };
        const addr = mc.collectAddress(state);
        expect(addr.nombre).toBe('Ana');
        expect(addr.cp).toBe('2000');
    });

    test('state vacío devuelve todos los campos en null', () => {
        expect(Object.values(mc.collectAddress({}))).toEqual([null, null, null, null, null, null]);
    });
});

describe('detectRetiro', () => {
    const hist = (...msgs) => ({ history: msgs.map(content => ({ role: 'bot', content })) });

    // Caso Nora Aguirre 06-jun: el bot menciona el alias al EXPLICAR las opciones
    // aunque la clienta eligió retiro. Si eso contara como "domicilio
    // comprometido", el gate exigía calle y rechazaba un pedido de retiro con
    // datos completos.
    test('el bot explicando el alias NO alcanza para marcar domicilio', () => {
        const state = {
            ...hist('Podés pagar por transferencia al alias herbalis.tienda o retirar en sucursal',
                    'Dale, entonces vamos con retiro en sucursal 👍'),
        };
        expect(mc.detectRetiro({ state, addr: {} })).toBe(true);
    });

    test('domicilio comprometido gana sobre las señales de retiro', () => {
        const state = {
            paymentMethod: 'transferencia',
            ...hist('Dale, entonces vamos con retiro en sucursal'),
        };
        expect(mc.detectRetiro({ state, addr: {} })).toBe(false);
    });

    test('shippingChoice explícito del state', () => {
        expect(mc.detectRetiro({ state: { shippingChoice: 'retiro', history: [] }, addr: {} })).toBe(true);
        expect(mc.detectRetiro({ state: { shippingChoice: 'domicilio', history: [] }, addr: {} })).toBe(false);
    });

    test('link de MP vivo ⇒ domicilio', () => {
        const state = { mpPaymentLinkUrl: 'https://mp/x', ...hist('vamos con retiro en sucursal') };
        expect(mc.detectRetiro({ state, addr: {} })).toBe(false);
    });

    test('"sucursal" en la calle alcanza como señal', () => {
        expect(mc.detectRetiro({ state: { history: [] }, addr: { calle: 'A sucursal' } })).toBe(true);
    });

    test('sin señales de ningún lado ⇒ domicilio', () => {
        const state = hist('¡Hola! ¿Cuántos kilos querés bajar?');
        expect(mc.detectRetiro({ state, addr: {} })).toBe(false);
    });
});

describe('applyRetiroAddress', () => {
    test('guarda la calle real en calleOriginal y pone "A sucursal"', () => {
        const state = {};
        const addr = mc.applyRetiroAddress({ addr: { calle: 'Belgrano 450', calleOriginal: null }, state });
        expect(addr.calle).toBe('A sucursal');
        expect(addr.calleOriginal).toBe('Belgrano 450');
        expect(state.partialAddress).toBe(addr);
    });

    test('no pisa un calleOriginal que ya existía', () => {
        const addr = mc.applyRetiroAddress({ addr: { calle: 'X 1', calleOriginal: 'Original 9' }, state: {} });
        expect(addr.calleOriginal).toBe('Original 9');
    });
});

describe('applyManualOverride', () => {
    test('los datos del modal pisan lo extraído', () => {
        const state = {};
        const addr = mc.applyManualOverride({
            addr: { nombre: 'mal', calle: 'mal', ciudad: 'Rosario', cp: '2000' },
            manualAddr: { nombre: 'Correcto', calle: 'Mitre 100' },
            state, chatId: 'x@c.us',
        });
        expect(addr.nombre).toBe('Correcto');
        expect(addr.calle).toBe('Mitre 100');
        expect(addr.ciudad).toBe('Rosario');   // lo que el modal no manda se conserva
        expect(state.partialAddress).toBe(addr);
    });

    test('sin manualAddr devuelve la dirección intacta', () => {
        const original = { nombre: 'Ana' };
        expect(mc.applyManualOverride({ addr: original, manualAddr: undefined, state: {}, chatId: 'x' })).toBe(original);
    });
});

describe('rescueProductFromHistory', () => {
    test('parsea producto, plan y total del template de confirmación', () => {
        const state = {
            history: [{ role: 'bot', content: 'Producto: Cápsulas de Nuez de la India\nPlan: 120 días\nTotal a pagar al recibir: $68.900' }],
        };
        const r = mc.rescueProductFromHistory({ state, cart: [] });
        expect(r.rescuedProduct).toBe('Cápsulas de Nuez de la India');
        expect(r.rescuedPlan).toBe('120');
        expect(r.rescuedTotal).toBe(68900);
    });

    test('no rescata nada si ya hay cart', () => {
        const state = { history: [{ role: 'bot', content: 'Producto: Gotas\nPlan: 60' }] };
        expect(mc.rescueProductFromHistory({ state, cart: [{ product: 'Gotas' }] }).rescuedProduct).toBeNull();
    });

    test('no rescata nada si ya hay selectedProduct', () => {
        const state = { selectedProduct: 'Semillas', history: [{ role: 'bot', content: 'Producto: Gotas' }] };
        expect(mc.rescueProductFromHistory({ state, cart: [] }).rescuedProduct).toBeNull();
    });
});

describe('resolveProductAndTotal', () => {
    const base = { state: {}, cart: [], rescued: { rescuedProduct: null, rescuedPlan: null, rescuedTotal: null }, chatId: 'x' };

    test('si el admin elige producto+plan, el precio sale de la lista oficial', () => {
        const r = mc.resolveProductAndTotal({ ...base, body: { productType: 'Cápsulas', plan: '120' } });
        expect(r.total).toBe(68900);
        expect(r.plan).toBe('120');
        expect(r.product).toBe('Cápsulas (120 días)');
    });

    test('el descuento manual se resta del total', () => {
        const r = mc.resolveProductAndTotal({ ...base, body: { productType: 'Semillas', plan: '60', discount: '5000' } });
        expect(r.total).toBe(36900 - 5000);
    });

    test('el descuento nunca deja el total negativo', () => {
        const r = mc.resolveProductAndTotal({ ...base, body: { productType: 'Semillas', plan: '60', discount: '999999' } });
        expect(r.total).toBe(0);
    });

    test('sin override del admin manda state.totalPrice', () => {
        const r = mc.resolveProductAndTotal({ ...base, state: { totalPrice: '46.900', selectedProduct: 'Cápsulas', selectedPlan: '60' }, body: {} });
        expect(r.total).toBe(46900);
    });

    test('cae al total rescatado del historial', () => {
        const r = mc.resolveProductAndTotal({
            ...base, body: {},
            rescued: { rescuedProduct: 'Gotas', rescuedPlan: '120', rescuedTotal: 68900 },
        });
        expect(r.total).toBe(68900);
        expect(r.product).toBe('Gotas (120 días)');
    });

    test('sin nada, suma el carrito', () => {
        const r = mc.resolveProductAndTotal({ ...base, body: {}, cart: [{ product: 'Cápsulas', plan: '60', price: '54.900' }] });
        expect(r.total).toBe(54900);
    });
});

describe('resolveChatId', () => {
    test('un teléfono pelado se convierte en chatId', async () => {
        expect(await mc.resolveChatId('549 11 5555-1234', null)).toBe('5491155551234@c.us');
    });

    test('un chatId ya formado se devuelve igual', async () => {
        expect(await mc.resolveChatId('5491155551234@c.us', null)).toBe('5491155551234@c.us');
    });

    test('un @lid se resuelve contra el contacto', async () => {
        const client = { getContactById: async () => ({ number: '5491155551234' }) };
        expect(await mc.resolveChatId('99887766@lid', client)).toBe('5491155551234@c.us');
    });

    test('si el @lid no resuelve, se devuelve tal cual', async () => {
        const client = { getContactById: async () => { throw new Error('no existe'); } };
        expect(await mc.resolveChatId('99887766@lid', client)).toBe('99887766@lid');
    });
});

describe('rescueAddress', () => {
    test('con la dirección completa no toca la DB ni la IA', async () => {
        const prisma = { chatLog: { findMany: jest.fn() } };
        const addr = { nombre: 'Ana', calle: 'Mitre 1', ciudad: 'Rosario' };
        const out = await mc.rescueAddress({ addr, state: {}, phoneNumeric: '549', instanceId: 'x', prisma, chatId: 'x@c.us' });
        expect(out).toBe(addr);
        expect(prisma.chatLog.findMany).not.toHaveBeenCalled();
    });

    // Sin mensajes del usuario corta antes de llamar a la IA, así el test no
    // gasta una request de API en cada corrida de la suite.
    test('si la DB falla y no hay nada que analizar, devuelve lo que tenía sin romper', async () => {
        const prisma = { chatLog: { findMany: jest.fn().mockRejectedValue(new Error('DB caída')) } };
        const addr = { nombre: 'Ana', calle: null, ciudad: null };
        const out = await mc.rescueAddress({ addr, state: { history: [] }, phoneNumeric: '549', instanceId: 'x', prisma, chatId: 'x@c.us' });
        expect(prisma.chatLog.findMany).toHaveBeenCalled();
        expect(out).toBe(addr);   // no tira, no pierde lo que ya tenía
    });
});
