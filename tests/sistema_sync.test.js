require('dotenv').config();
const { mapOrderToSistema, ORIGEN } = require('../src/services/sistemaSync');

/**
 * mapOrderToSistema traduce un Order de Prisma al vocabulario del panel de
 * ventas (ventas-app), que es otro repo con otro modelo de datos. Es el único
 * punto donde las dos formas se tocan, así que lo que se cuida acá es:
 *
 *  - los valores que manda tienen que existir en la config del panel
 *    (ORDER_STATUSES, ORDER_TYPES, SHIPPING_TYPES, PAYMENT_METHODS, CURRENCIES);
 *    uno inventado lo rechaza el Zod del endpoint con un 422;
 *  - externalId tiene que ser el Order.id crudo — es la mitad de la clave de
 *    idempotencia del panel, si cambia se duplica la venta;
 *  - nada de lo que el panel no tiene dónde guardar (seña, postdatado, método
 *    de pago del bot) puede perderse en el camino.
 */

const baseOrder = {
    id: '3f7b1a54-0c1e-4a2b-9d33-2b6f9e4c1a77',
    instanceId: 'gonza',
    userPhone: '5491122334455',
    nombre: 'Maria Elina Gomez Perez',
    products: 'Plan 60 dias - Nuez de la India',
    totalPrice: 48000,
    paymentMethod: 'mercadopago',
    calle: 'Av. Rivadavia 1234',
    ciudad: 'Rosario',
    provincia: 'Santa Fe',
    cp: '2000',
    seller: '5493411234567',
    tracking: null,
    postdated: null,
    senaPaid: false,
    senaAmount: null,
    cashRemainder: null,
    paymentVerifiedAt: null,
    calleOriginal: null,
    email: null,
    createdAt: new Date('2026-09-09T12:00:00.000Z'),
};

describe('mapOrderToSistema', () => {

    test('manda solo valores que el panel tiene en su config', () => {
        const payload = mapOrderToSistema(baseOrder);

        expect(payload.origen).toBe(ORIGEN);
        expect(payload.pedido.estado).toBe('A CONFIRMAR');       // ORDER_STATUSES
        expect(payload.pedido.tipoPedido).toBe('Whatsapp');      // ORDER_TYPES
        expect(payload.pedido.moneda).toBe('ARS');               // CURRENCIES
        expect(payload.pedido.canalVenta).toBe('VENTAS PROPIAS'); // SALES_CHANNELS
        expect(payload.pedido.region).toBe('SUD AMERICA');       // COUNTRIES_BY_REGION
        expect(payload.pedido.medioPago).toBe('MERCADOPAGO');    // PAYMENT_METHODS
        expect(payload.pedido.envio.tipoEnvio).toBe('Estandar'); // SHIPPING_TYPES
    });

    test('externalId es el Order.id crudo — es la clave de idempotencia', () => {
        expect(mapOrderToSistema(baseOrder).externalId).toBe(baseOrder.id);
    });

    test('parte el nombre completo en nombre + apellido', () => {
        const { cliente } = mapOrderToSistema(baseOrder);
        expect(cliente.nombre).toBe('Maria');
        expect(cliente.apellido).toBe('Elina Gomez Perez');
    });

    test('un nombre de una sola palabra deja el apellido vacío', () => {
        const { cliente } = mapOrderToSistema({ ...baseOrder, nombre: 'Horacio' });
        expect(cliente.nombre).toBe('Horacio');
        expect(cliente.apellido).toBe('');
    });

    test('el teléfono va sin formato — el panel matchea por dígitos', () => {
        const { cliente } = mapOrderToSistema({ ...baseOrder, userPhone: '+54 9 11 2233-4455' });
        expect(cliente.telefono).toBe('5491122334455');
    });

    test('retiro en sucursal se detecta por calle === "A sucursal"', () => {
        const { pedido } = mapOrderToSistema({ ...baseOrder, calle: 'A sucursal', paymentMethod: 'contrarembolso' });
        expect(pedido.envio.tipoEnvio).toBe('Retiro en Sucursal');
        expect(pedido.envio.sucursalCorreo).toBe(true);
    });

    test('contrarembolso a domicilio es Contra Reembolso, no sucursal', () => {
        const { pedido } = mapOrderToSistema({ ...baseOrder, paymentMethod: 'contrarembolso' });
        expect(pedido.envio.tipoEnvio).toBe('Contra Reembolso');
        expect(pedido.envio.sucursalCorreo).toBe(false);
    });

    test('un método de pago desconocido queda vacío en vez de inventar un código', () => {
        const { pedido } = mapOrderToSistema({ ...baseOrder, paymentMethod: 'cripto' });
        expect(pedido.medioPago).toBeUndefined();
        // Pero no se pierde: queda escrito en las notas.
        expect(pedido.notas).toContain('cripto');
    });

    test('la seña del COD y el postdatado sobreviven en las notas', () => {
        const { pedido } = mapOrderToSistema({
            ...baseOrder,
            paymentMethod: 'contrarembolso',
            senaPaid: true,
            senaAmount: 10000,
            cashRemainder: 38000,
            postdated: '2026-09-20',
        });

        expect(pedido.notas).toContain('Seña cobrada: $10000');
        expect(pedido.notas).toContain('Saldo a cobrar en efectivo: $38000');
        expect(pedido.notas).toContain('Postdatado: 2026-09-20');
    });

    test('"no" como postdatado no ensucia las notas', () => {
        const { pedido } = mapOrderToSistema({ ...baseOrder, postdated: 'no' });
        expect(pedido.notas).not.toContain('Postdatado');
    });

    test('la dirección original del cliente se guarda cuando Maps la reescribió', () => {
        const { pedido } = mapOrderToSistema({ ...baseOrder, calleOriginal: 'rivadavia mil doscientos treinta y cuatro' });
        expect(pedido.notas).toContain('rivadavia mil doscientos treinta y cuatro');
    });

    test('el total va como bruto y neto, y como única línea de detalle', () => {
        const { pedido } = mapOrderToSistema(baseOrder);
        expect(pedido.bruto).toBe(48000);
        expect(pedido.netoFinal).toBe(48000);
        expect(pedido.detalles).toEqual([{
            producto: 'Plan 60 dias - Nuez de la India',
            cantidad: 1,
            precioUnitario: 48000,
            descuentos: 0,
            totalLinea: 48000,
        }]);
    });

    test('un pedido sin producto no rompe la validación del panel', () => {
        const { pedido } = mapOrderToSistema({ ...baseOrder, products: '' });
        // `producto` es min(1) del lado del panel: un string vacío daría 422.
        expect(pedido.detalles[0].producto).toBe('Sin detalle');
    });
});
