import logger from '../utils/logger';

/**
 * sistemaSync — empuja una venta del bot al panel de ventas (ventas-app),
 * el "sistema" donde se administran los pedidos de verdad.
 *
 * Lo dispara el botón "Enviar a sistema" de SalesView. El panel expone
 * POST /api/integraciones/pedidos con auth por bearer token; la traducción
 * del Order de Prisma al vocabulario del panel vive acá, no allá, porque el
 * que conoce esta forma de los datos es este repo.
 *
 * El panel es idempotente sobre (origen, externalId): reenviar la misma orden
 * devuelve la que ya se creó en vez de duplicarla. Por eso `externalId` es el
 * `Order.id` crudo y nunca se recalcula.
 */

export const ORIGEN = 'bot-whatsapp';

// Argentina es el único mercado del bot. El panel arrastra datos históricos de
// España, así que estos tres campos son los que lo separan de aquello.
const PAIS = 'Argentina';
const REGION = 'SUD AMERICA';
const MONEDA = 'ARS';

// Valores que ya existen en la config del panel (src/lib/constants.js allá).
const ESTADO_INICIAL = 'A CONFIRMAR';
const TIPO_PEDIDO = 'Whatsapp';
const CANAL_VENTA = 'VENTAS PROPIAS';

const MEDIO_PAGO: Record<string, string> = {
    mercadopago: 'MERCADOPAGO',
    transferencia: 'TRANSFERENCIA',
    contrarembolso: 'CONTRAREEMBOLSO',
};

const TIMEOUT_MS = 15000;

/**
 * `config/env` se carga por require y en demanda: valida TODO el entorno al
 * importarse, y `mapOrderToSistema` es una función pura que se testea sin nada
 * de eso montado.
 */
function sistemaEnv(): { SISTEMA_URL: string; SISTEMA_TOKEN: string } {
    return require('../config/env').env;
}

/**
 * Retiro en sucursal. El Order no tiene campo de tipo de envío: el flujo lo
 * marca poniendo `calle = "A sucursal"` (src/flows/utils/messages.ts), y esa es
 * la única señal confiable — mismo criterio que usa SalesView para el badge.
 */
function isSucursal(order: any): boolean {
    return String(order.calle || '').trim().toLowerCase() === 'a sucursal';
}

/**
 * El bot captura un nombre completo en un solo campo; el panel exige nombre y
 * apellido por separado. La primera palabra es el nombre y el resto el
 * apellido; si solo hay una, el apellido queda vacío y el panel pone '-'.
 */
function splitNombre(full?: string | null): { nombre: string; apellido: string } {
    const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { nombre: 'Sin nombre', apellido: '' };
    return { nombre: parts[0], apellido: parts.slice(1).join(' ') };
}

/**
 * Todo lo que el panel no tiene dónde guardar va a las notas del pedido, para
 * que no se pierda: la seña del COD, el postdatado, el método de pago tal cual
 * lo registró el bot y la dirección original del cliente antes de Maps.
 */
function buildNotas(order: any): string {
    const lines = [`Pedido del bot de WhatsApp (${order.id})`];

    if (order.instanceId) lines.push(`Vendedor bot: ${order.instanceId}`);
    if (order.seller) lines.push(`Número que vendió: ${order.seller}`);
    if (order.paymentMethod) lines.push(`Pago (bot): ${order.paymentMethod}`);

    if (order.senaPaid && order.senaAmount) {
        lines.push(`Seña cobrada: $${order.senaAmount}`);
        if (order.cashRemainder) lines.push(`Saldo a cobrar en efectivo: $${order.cashRemainder}`);
    }

    if (order.paymentVerifiedAt) {
        lines.push(`Transferencia verificada: ${new Date(order.paymentVerifiedAt).toISOString()}`);
    }

    const postdated = String(order.postdated || '').trim();
    if (postdated && !['no', 'false'].includes(postdated.toLowerCase())) {
        lines.push(`Postdatado: ${postdated}`);
    }

    if (order.calleOriginal && order.calleOriginal !== order.calle) {
        lines.push(`Dirección original del cliente: ${order.calleOriginal}`);
    }

    return lines.join('\n');
}

/**
 * Traduce un `Order` de Prisma al payload que espera el panel.
 * Función pura — no toca DB ni red, así que se testea sola.
 */
export function mapOrderToSistema(order: any) {
    const { nombre, apellido } = splitNombre(order.nombre);
    const sucursal = isSucursal(order);
    const total = Number(order.totalPrice) || 0;
    const producto = String(order.products || '').trim() || 'Sin detalle';

    const tipoEnvio = sucursal
        ? 'Retiro en Sucursal'
        : order.paymentMethod === 'contrarembolso'
            ? 'Contra Reembolso'
            : 'Estandar';

    return {
        origen: ORIGEN,
        externalId: order.id,

        cliente: {
            telefono: String(order.userPhone || '').replace(/\D/g, ''),
            nombre,
            apellido,
            email: order.email || undefined,
            pais: PAIS,
            region: REGION,
        },

        direccion: {
            detalle: order.calle || undefined,
            ciudad: order.ciudad || undefined,
            provincia: order.provincia || undefined,
            cp: order.cp || undefined,
            pais: PAIS,
        },

        pedido: {
            fechaPedido: order.createdAt ? new Date(order.createdAt).toISOString() : undefined,
            estado: ESTADO_INICIAL,
            tipoPedido: TIPO_PEDIDO,
            moneda: MONEDA,
            pais: PAIS,
            region: REGION,

            bruto: total,
            descuentos: 0,
            cargos: 0,
            netoFinal: total,

            medioPago: MEDIO_PAGO[order.paymentMethod] || undefined,
            canalVenta: CANAL_VENTA,
            vendedor: order.instanceId || undefined,
            notas: buildNotas(order),

            envio: {
                tipoEnvio,
                numeroEnvio: order.tracking || undefined,
                sucursalCorreo: sucursal,
            },

            // El bot vende un plan por pedido, así que siempre es una sola
            // línea. El panel igual acepta varias.
            detalles: [{
                producto,
                cantidad: 1,
                precioUnitario: total,
                descuentos: 0,
                totalLinea: total,
            }],
        },
    };
}

export function isSistemaConfigured(): boolean {
    const env = sistemaEnv();
    return Boolean(env.SISTEMA_URL && env.SISTEMA_TOKEN);
}

export interface SistemaResult {
    orderId: number;
    pedidoId: string;
    duplicate: boolean;
}

/**
 * Manda la orden al panel. Devuelve el número de pedido que asignó el panel.
 * Lanza con un mensaje en castellano listo para mostrar en el dashboard.
 */
export async function pushOrderToSistema(order: any): Promise<SistemaResult> {
    if (!isSistemaConfigured()) {
        throw new Error('El panel de ventas no está configurado (falta SISTEMA_URL o SISTEMA_TOKEN)');
    }

    const env = sistemaEnv();
    const url = `${env.SISTEMA_URL.replace(/\/+$/, '')}/api/integraciones/pedidos`;
    const payload = mapOrderToSistema(order);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: Response;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${env.SISTEMA_TOKEN}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
    } catch (e: any) {
        const reason = e?.name === 'AbortError' ? 'el panel no respondió a tiempo' : e?.message;
        logger.error(`[SISTEMA] Falló el POST de la orden ${order.id}: ${reason}`);
        throw new Error(`No se pudo contactar al panel de ventas: ${reason}`);
    } finally {
        clearTimeout(timer);
    }

    const body: any = await res.json().catch(() => ({}));

    if (!res.ok) {
        const detail = body?.message || `HTTP ${res.status}`;
        logger.error(`[SISTEMA] El panel rechazó la orden ${order.id}: ${detail}`);
        throw new Error(`El panel de ventas rechazó el pedido: ${detail}`);
    }

    logger.info(
        `[SISTEMA] Orden ${order.id} ${body.duplicate ? 'ya estaba cargada' : 'cargada'} ` +
        `en el panel como pedido #${body.orderId}`
    );

    return {
        orderId: body.orderId,
        pedidoId: body.pedidoId,
        duplicate: Boolean(body.duplicate),
    };
}
