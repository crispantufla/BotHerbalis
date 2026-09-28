/**
 * manualComplete.js — los pasos de POST /orders/manual-complete.
 *
 * Esa ruta era una sola función de 463 líneas: la más larga del repo después de
 * handleAdminCommand. Es la carga manual de un pedido desde el panel, o sea el
 * camino por el que el admin rescata una venta que el bot no pudo cerrar solo,
 * así que acumuló capas de rescate de datos, detección de tipo de envío y
 * overrides del modal.
 *
 * Acá viven esos pasos, cada uno con su nombre; la ruta quedó como orquestador.
 * Los cuerpos se movieron tal cual — cada bloque arrastra los comentarios con
 * los casos reales que lo motivaron (Elvira 27-abr, Nora Aguirre 06-jun,
 * Pablo Martinez 23-jul, Romina 19-may), que son la única documentación de por
 * qué existen.
 *
 * OJO: varios de estos helpers MUTAN `state` a propósito (partialAddress,
 * paymentMethod). Eso ya era así y el panel depende de que el state quede
 * actualizado tras el rescate.
 */

const logger = require('../../utils/logger');

const _lc = (s) => (s || '').toLowerCase();

/** "549..." | "...@lid" | "...@c.us" → chatId canónico. */
async function resolveChatId(id, sellerClient) {
    if (!id) return id;
    if (id.includes('@lid')) {
        try {
            const c = await sellerClient?.getContactById(id);
            if (c?.number) return `${c.number}@c.us`;
        } catch (e) { /* ignore */ }
        return id;
    }
    if (!id.includes('@')) return `${id.replace(/\D/g, '')}@c.us`;
    return id;
}

/**
 * Dirección según el state. Prefiere pendingOrder (post-validación de Maps, la
 * fuente de verdad) sobre partialAddress: partialAddress se lo pueden limpiar
 * las transiciones de step o los globals mientras pendingOrder sobrevive, así
 * que leer solo partialAddress producía órdenes vacías en producción
 * (caso Elvira 27/04/2026).
 */
function collectAddress(state) {
    const pending = state.pendingOrder || {};
    const partial = state.partialAddress || {};
    return {
        nombre:        pending.nombre        || partial.nombre        || null,
        calle:         pending.calle         || partial.calle         || null,
        ciudad:        pending.ciudad        || partial.ciudad        || null,
        provincia:     pending.provincia     || partial.provincia     || null,
        cp:            pending.cp            || partial.cp            || null,
        calleOriginal: pending.calleOriginal || partial.calleOriginal || null,
    };
}

/**
 * FALLBACK DATA RESCUE: el state se puede haber pausado/limpiado. Buscamos
 * mensajes del usuario en (a) state.history y (b) ChatLog en DB como fuente de
 * verdad, y se los damos a la IA. Esto es lo que evita que el manual-complete
 * cree órdenes con nombre/calle/ciudad=null cuando el bot pausó por "La IA
 * falló en extraer la calle".
 *
 * Devuelve la dirección (rescatada o la original) y mutá `state.partialAddress`
 * si logró rescatar algo.
 */
async function rescueAddress({ addr, state, phoneNumeric, instanceId, prisma, chatId }) {
    if (addr.nombre && addr.calle && addr.ciudad) return addr;

    logger.info(`[MANUAL-COMPLETE] Datos de envío incompletos. Intentando rescatarlos para ${chatId}...`);

    // Combinar mensajes del state (memoria) + ChatLog (DB) — el state
    // se trunca cuando hay summary, ChatLog tiene todo el historial.
    const stateMsgs = (state.history || []).filter(m => m.role === 'user').map(m => m.content || '');
    let dbMsgs = [];
    try {
        const dbLogs = await prisma.chatLog.findMany({
            where: { userPhone: phoneNumeric, instanceId, role: 'user' },
            orderBy: { timestamp: 'desc' },
            take: 20,
            select: { content: true }
        });
        dbMsgs = dbLogs.map(l => l.content || '').reverse();
    } catch (e) {
        logger.warn('[MANUAL-COMPLETE] DB chatLog query failed:', e.message);
    }

    // Dedup conservando orden cronológico (DB tiene más historial)
    const seen = new Set();
    const allMsgs = [...dbMsgs, ...stateMsgs].filter(m => {
        if (!m || seen.has(m)) return false;
        seen.add(m);
        return true;
    }).slice(-15); // últimos 15 únicos

    if (allMsgs.length === 0) return addr;

    try {
        const { aiService } = require('../../services/ai');
        const extracted = await aiService.parseAddress(allMsgs.join(" | "));

        if (!extracted._error) {
            logger.info(`[MANUAL-COMPLETE] Extracción AI exitosa:`, extracted);
            const rescued = {
                nombre: extracted.nombre || addr.nombre,
                calle: extracted.calle || addr.calle,
                ciudad: extracted.ciudad || addr.ciudad,
                provincia: extracted.provincia || addr.provincia,
                cp: extracted.cp || addr.cp,
                calleOriginal: addr.calleOriginal || extracted.calle || null
            };
            state.partialAddress = rescued; // Save rescued data to state
            return rescued;
        }
    } catch (extError) {
        logger.error(`[MANUAL-COMPLETE] Error en extracción AI de rescate:`, extError.message);
    }
    return addr;
}

/**
 * OVERRIDE MANUAL: el admin abrió el modal de entrada manual y nos mandó los
 * datos a mano. Estos pisan lo que se haya logrado extraer.
 */
function applyManualOverride({ addr, manualAddr, state, chatId }) {
    if (!manualAddr || typeof manualAddr !== 'object') return addr;
    const merged = {
        nombre:        manualAddr.nombre        || addr.nombre        || null,
        calle:         manualAddr.calle         || addr.calle         || null,
        ciudad:        manualAddr.ciudad        || addr.ciudad        || null,
        provincia:     manualAddr.provincia     || addr.provincia     || null,
        cp:            manualAddr.cp            || addr.cp            || null,
        calleOriginal: manualAddr.calle         || addr.calleOriginal || null,
    };
    state.partialAddress = merged;
    logger.info(`[MANUAL-COMPLETE] Address override from admin form for ${chatId}: ${merged.nombre} / ${merged.calle}`);
    return merged;
}

/**
 * RETIRO EN SUCURSAL: no tiene calle (con localidad + CP el Correo asigna la
 * sucursal). Si no lo detectamos, el gate de datos exige calle y rechaza pedidos
 * de retiro con datos completos (nombre + localidad + CP) forzando carga manual.
 * Caso real Nora Aguirre 06-jun: dio nombre + "San Miguel de Tucumán" + CP 4000
 * y el botón no los tomó porque "faltaba la calle".
 */
function detectRetiro({ state, addr }) {
    const botHistText = (state.history || [])
        .filter(m => m.role === 'bot' || m.role === 'admin')
        .map(m => _lc(m.content)).join(' ');

    // Domicilio ya comprometido (prepago) → NO es retiro. Excluye falsos
    // positivos: el menú menciona "retiro en sucursal" para TODOS.
    // OJO: frases de COMPROMISO, no de explicación. El bot menciona el
    // alias "herbalis.tienda" al explicar opciones aunque el cliente NO
    // elija transferencia (falso positivo real en el caso Nora Aguirre).
    const domicilioCommitted =
        state.shippingChoice === 'domicilio'
        || state.paymentMethod === 'mercadopago'
        || state.paymentMethod === 'transferencia'
        || !!state.mpPaymentLinkUrl
        || /lo mandamos a tu domicilio|para transferir us[áa] el alias|te dejo el link para pagar con mercado pago/.test(botHistText);

    // Retiro comprometido: frases de COMPROMISO del bot/admin (no la mera
    // línea de oferta del menú), o señales explícitas del state/dirección.
    const retiroCommitted =
        state.shippingChoice === 'retiro'
        || state.paymentMethod === 'contrarembolso'
        || /\bsucursal\b/.test(_lc(addr.calle))
        || /(dejamos|armamos|vamos con|entonces vamos|confirmamos).{0,80}retiro en sucursal/.test(botHistText)
        || /pag[áa]s? el total.{0,40}(al retirar|cuando lo retir)/.test(botHistText);

    return retiroCommitted && !domicilioCommitted;
}

/**
 * En retiro la calle no aplica. Conservamos la calle real (si la había) en
 * calleOriginal para referencia del admin.
 */
function applyRetiroAddress({ addr, state }) {
    if (addr.calle && _lc(addr.calle) !== 'a sucursal' && !addr.calleOriginal) {
        addr.calleOriginal = addr.calle;
    }
    addr.calle = 'A sucursal';
    state.partialAddress = addr;
    return addr;
}

/**
 * FALLBACK PRODUCT/PLAN/PRICE RESCUE: escanea los mensajes del bot buscando el
 * template de confirmación. Cubre las conversaciones manejadas a mano, donde el
 * flujo del bot nunca seteó cart/selectedProduct.
 */
function rescueProductFromHistory({ state, cart }) {
    const empty = { rescuedProduct: null, rescuedPlan: null, rescuedTotal: null };
    if (cart.length > 0 || state.selectedProduct) return empty;

    const botMessages = (state.history || []).filter(m => m.role === 'bot').map(m => m.content || '').join('\n');
    // "Producto: Cápsulas de Nuez de la India"
    const productMatch = botMessages.match(/Producto:\s*(.+?)(?:\n|Plan:|$)/i);
    // "Plan: 60 días" / "Plan: 120 días"
    const planMatch = botMessages.match(/Plan:\s*(\d+)/i);
    // "Total a pagar al recibir:\n$46.900" / "Total a abonar al recibir: $36.900"
    const totalMatch = botMessages.match(/[Tt]otal[^:]*:\s*\$?\s*([\d.,]+)/);

    const out = {
        rescuedProduct: productMatch ? productMatch[1].trim() : null,
        rescuedPlan: planMatch ? planMatch[1] : null,
        rescuedTotal: totalMatch ? (parseInt(totalMatch[1].replace(/\./g, '').replace(',', '')) || null) : null,
    };
    if (out.rescuedProduct || out.rescuedTotal) {
        logger.info(`[MANUAL-COMPLETE] Rescate de producto desde historial: ${out.rescuedProduct} / ${out.rescuedPlan} días / $${out.rescuedTotal}`);
    }
    return out;
}

/**
 * Producto, plan y total finales. El admin puede elegir producto+plan a mano
 * desde el modal cuando el bot no los detectó; en ese caso el precio sale de la
 * lista oficial (pricing.ts), nunca del state.
 */
function resolveProductAndTotal({ body, state, cart, rescued, chatId }) {
    const { _getPrice, _normalizeProductName } = require('../../flows/utils/pricing');
    const productTypeReq = body?.productType; // 'Cápsulas' | 'Gotas' | 'Semillas'
    const planReq = body?.plan;               // '60' | '120'

    const plan = planReq || state.selectedPlan || cart[0]?.plan || rescued.rescuedPlan || '60';

    // Prefer state.totalPrice (refleja el último cambio de plan).
    // Fall back to recalculating from cart only if totalPrice is missing.
    let total;
    if (productTypeReq) {
        total = parseInt(String(_getPrice(productTypeReq, plan)).replace(/\./g, ''), 10) || 0;
    } else if (state.totalPrice) {
        total = parseInt(state.totalPrice.toString().replace(/\./g, '').replace(/[^\d]/g, '')) || 0;
    } else if (rescued.rescuedTotal) {
        total = rescued.rescuedTotal;
    } else {
        total = cart.reduce((sum, i) => sum + parseInt((i.price || '0').toString().replace(/\D/g, '')), 0);
    }

    // Descuento manual del admin: resta al total final. (El bot nunca
    // descuenta solo; esto es una acción manual desde el panel.)
    const discountReq = Math.max(0, parseInt(String(body?.discount || '0').replace(/[^\d]/g, ''), 10) || 0);
    if (discountReq > 0) {
        total = Math.max(0, total - discountReq);
        logger.info(`[MANUAL-COMPLETE] Descuento manual para ${chatId}: -$${discountReq} → total $${total}`);
    }

    const rawProduct = productTypeReq || cart.map(i => i.product).join(' + ') || state.selectedProduct || rescued.rescuedProduct || 'Producto';
    const rawPlan = productTypeReq ? `${plan} días` : (cart.map(i => `${i.plan} días`).join(' + ') || `${plan} días`);

    return { plan, total, product: _normalizeProductName(rawProduct, rawPlan, total) };
}

/**
 * Crea o confirma la orden en una transacción: upsert del user, guard de
 * idempotencia y update-or-create. Devuelve la orden.
 */
async function persistOrder({ prisma, phoneNumeric, instanceId, addr, state, product, total, seller, paymentVerifiedReq }) {
    return await prisma.$transaction(async (tx) => {
        await tx.user.upsert({
            where: { phone_instanceId: { phone: phoneNumeric, instanceId } },
            update: { name: addr.nombre || null },
            create: { phone: phoneNumeric, instanceId, name: addr.nombre || null }
        });

        // Idempotencia: si el admin doble-clickeó "Manual Complete" en pocos segundos,
        // ya hay un Confirmado fresco para este teléfono. Devolvelo sin crear duplicado
        // (no se crea otra orden, así nunca aparece ruido en el panel).
        const recentConfirmed = await tx.order.findFirst({
            where: {
                userPhone: phoneNumeric,
                status: { in: ['Confirmado', 'Pendiente'] },
                instanceId,
                createdAt: { gte: new Date(Date.now() - 60 * 1000) }
            },
            orderBy: { createdAt: 'desc' }
        });
        if (recentConfirmed) {
            logger.info(`[MANUAL-COMPLETE] Duplicate click detected — returning existing order ${recentConfirmed.id} (created ${Math.round((Date.now() - recentConfirmed.createdAt.getTime()) / 1000)}s ago, status=${recentConfirmed.status})`);
            return recentConfirmed;
        }

        const existingOrder = await tx.order.findFirst({
            where: { userPhone: phoneNumeric, status: 'Pendiente', instanceId },
            orderBy: { createdAt: 'desc' }
        });

        // Campos de seña (flujo COD con anticipo): si el state los tiene,
        // los persistimos. Sin esto, la confirmación manual desde panel
        // perdía la info de seña ya cobrada (caso real Romina 19-may:
        // pagó $10k MP pero la orden quedó con totalPrice=$46.900 COD).
        const stateSena = state && state.senaAmount && state.senaAmount > 0
            ? {
                senaAmount: state.senaAmount,
                senaPaid: !!state.senaPaid,
                cashRemainder: Math.max(0, (total || 0) - state.senaAmount),
            }
            : {};

        if (existingOrder) {
            logger.info(`[MANUAL-COMPLETE] Found existing Pendiente order ${existingOrder.id}, updating to Confirmado...`);
            // Also patch products/totalPrice if the existing order has placeholder values
            const needsProductPatch = product !== 'Desconocido' && (!existingOrder.products || existingOrder.products === 'Producto' || existingOrder.products === 'Desconocido');
            const needsPricePatch = total > 0 && (!existingOrder.totalPrice || existingOrder.totalPrice === 0);
            return await tx.order.update({
                where: { id: existingOrder.id },
                data: {
                    status: 'Confirmado',
                    seller: seller,
                    nombre: addr.nombre || existingOrder.nombre,
                    calle: addr.calle || existingOrder.calle,
                    calleOriginal: addr.calleOriginal || existingOrder.calleOriginal || addr.calle || existingOrder.calle,
                    ciudad: addr.ciudad || existingOrder.ciudad,
                    provincia: addr.provincia || existingOrder.provincia,
                    cp: addr.cp || existingOrder.cp,
                    ...(needsProductPatch && { products: product }),
                    ...(needsPricePatch && { totalPrice: total }),
                    paymentMethod: state.paymentMethod || existingOrder.paymentMethod || null,
                    ...(paymentVerifiedReq && { paymentVerifiedAt: new Date() }),
                    ...stateSena,
                }
            });
        }

        logger.info(`[MANUAL-COMPLETE] No existing order found, creating new Confirmado order...`);
        return await tx.order.create({
            data: {
                instanceId,
                userPhone: phoneNumeric,
                status: 'Confirmado',
                products: product,
                totalPrice: total,
                postdated: state.postdatado || null,
                nombre: addr.nombre || null,
                calle: addr.calle || null,
                calleOriginal: addr.calleOriginal || addr.calle || null,
                ciudad: addr.ciudad || null,
                provincia: addr.provincia || null,
                cp: addr.cp || null,
                seller: seller,
                paymentMethod: state.paymentMethod || null,
                paymentVerifiedAt: paymentVerifiedReq ? new Date() : null,
                ...stateSena,
            }
        });
    });
}

module.exports = {
    resolveChatId,
    collectAddress,
    rescueAddress,
    applyManualOverride,
    detectRetiro,
    applyRetiroAddress,
    rescueProductFromHistory,
    resolveProductAndTotal,
    persistOrder,
};
