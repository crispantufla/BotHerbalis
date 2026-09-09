const express = require('express');
const logger = require('../../utils/logger');
const { z } = require('zod');
const { _setStep, _pushHistory } = require('../../flows/utils/flowHelpers');
const mc = require('./manualComplete');

// --- Input validation schemas ---
const uuidSchema = z.string().uuid('ID de orden inválido');

const orderUpdateSchema = z.object({
    nombre: z.string().max(200).optional(),
    calle: z.string().max(500).optional(),
    ciudad: z.string().max(200).optional(),
    provincia: z.string().max(100).optional(),
    cp: z.string().max(20).optional(),
    producto: z.string().max(500).optional(),
    precio: z.union([z.string(), z.number()]).optional(),
    tracking: z.string().max(200).optional(),
    status: z.enum(['Pendiente', 'Confirmado', 'En sistema', 'Enviado', 'Entregado', 'Cancelado']).optional(),
    postdatado: z.string().max(200).optional()
}).strict();

const statusUpdateSchema = z.object({
    status: z.enum(['Pendiente', 'Confirmado', 'En sistema', 'Enviado', 'Entregado', 'Cancelado']).optional(),
    tracking: z.string().max(200).optional()
}).strict();

module.exports = (clientPool) => {
    const router = express.Router();
    const { withSeller, getInstanceId, isOwnerOrAdmin, toLegacyOrder } = require('./routeHelpers');
    const { requireAdmin } = require('../../middleware/jwtAuth');

    // Access io dynamically via the seller's sharedState
    const io = (req) => req.sellerInstance?.sharedState?.io || null;

    // Emit an event scoped to this seller's room + the admin room, so events
    // do not leak across tenants. Includes `sellerId` on admin payloads so
    // admin dashboards can route the event to the correct seller context.
    const emitScoped = (req, event, payload) => {
        const socket = io(req);
        if (!socket) return;
        const sellerId = req.sellerId;
        if (sellerId) socket.to(sellerId).emit(event, payload);
        socket.to('admin').emit(event, sellerId ? { ...payload, sellerId } : payload);
    };

    // GET /orders/sellers — distinct instanceIds present in Order table.
    // Used by Logística filter to include "ghost" sellers (accounts deleted
    // but with preserved orders, e.g. denis post-hard-delete).
    // Excluimos namespaces "no-seller" (default + __legacy_import__).
    // Admin-only: lista instanceIds de TODOS los tenants (solo lo consume
    // SalesView en vista admin) — un seller no tiene por qué verlos.
    router.get('/orders/sellers', ...withSeller(clientPool), requireAdmin, async (req, res) => {
        try {
            const { prisma } = require('../../../db');
            const rows = await prisma.order.findMany({
                where: { instanceId: { notIn: ['default', '__legacy_import__'] } },
                select: { instanceId: true },
                distinct: ['instanceId'],
            });
            const ids = rows.map(r => r.instanceId).filter(Boolean).sort();
            res.json({ instanceIds: ids });
        } catch (e) {
            logger.error('[ORDERS] Error listing seller instanceIds:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /orders (List orders from PostgreSQL with Pagination)
    router.get('/orders', ...withSeller(clientPool), async (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = Math.min(parseInt(req.query.limit) || 100, 500);
            const skip = (page - 1) * limit;
            const instanceIdFromCtx = getInstanceId(req);
            const search = (req.query.search || '').toString().trim();
            const status = (req.query.status || '').toString().trim();
            // Admin puede filtrar por un seller específico via query param
            // (independiente del SellerContext global). Sellers no-admin
            // ignoran este param — su instanceId siempre viene del JWT.
            const requestedInstanceId = (req.query.instanceId || '').toString().trim();
            const isAdmin = req.account?.role === 'admin';

            const { prisma } = require('../../../db');

            // Filtro base de instanceId:
            //   - Sellers (no admin): siempre el del contexto (no overrideable)
            //   - Admin con seller global seleccionado: el del contexto
            //   - Admin sin seller global pero con ?instanceId=X: usa X
            //   - Admin sin nada: ve todos
            const effectiveInstanceId = isAdmin
                ? (instanceIdFromCtx || requestedInstanceId || null)
                : instanceIdFromCtx;
            // Vista agregada sin seller específico: excluimos namespaces "no-seller"
            // (__legacy_import__ tiene los 21k clientes históricos de Argentina —
            // están en DB solo para el gate de detección, no son pedidos reales).
            const where = effectiveInstanceId
                ? { instanceId: effectiveInstanceId }
                : { instanceId: { notIn: ['__legacy_import__'] } };

            // Filtro de status server-side. Antes era client-side sobre la página
            // actual, así que filtrar "Pendiente" mostraba solo los pending de
            // las 50 órdenes cargadas (3-5 por página) en vez de todos juntos.
            if (status && status !== 'Todos') {
                where.status = status;
            }

            // Búsqueda libre contra DB — match case-insensitive en nombre,
            // userPhone (cliente), seller (teléfono del bot), tracking, calle
            // y ciudad. Esto evita el bug previo de que el buscador solo
            // encontraba clientes en la página actual.
            if (search) {
                where.OR = [
                    { nombre: { contains: search, mode: 'insensitive' } },
                    { userPhone: { contains: search } },   // teléfono del cliente
                    { seller: { contains: search } },      // teléfono del bot/vendedor
                    { tracking: { contains: search, mode: 'insensitive' } },
                    { calle: { contains: search, mode: 'insensitive' } },
                    { ciudad: { contains: search, mode: 'insensitive' } },
                ];
            }

            // Run count + findMany in parallel (independent queries)
            const [total, orders] = await Promise.all([
                prisma.order.count({ where }),
                prisma.order.findMany({
                    where,
                    orderBy: { createdAt: 'desc' },
                    skip,
                    take: limit
                })
            ]);

            // Workaround for Prisma adapter-pg composite key bug with include: { user: true }
            const userPhones = [...new Set(orders.map(o => o.userPhone).filter(Boolean))];
            const instanceIds = [...new Set(orders.map(o => o.instanceId).filter(Boolean))];

            let users = [];
            if (userPhones.length > 0 && instanceIds.length > 0) {
                users = await prisma.user.findMany({
                    where: {
                        OR: userPhones.map(phone => ({
                            phone,
                            instanceId: { in: instanceIds }
                        }))
                    }
                });
            }

            const userMap = new Map();
            users.forEach(u => userMap.set(`${u.phone}_${u.instanceId}`, u));

            // Map to legacy format expected by dashboard to avoid breaking frontend fields.
            // Campos de seña expuestos al frontend para que el cartero vea el saldo
            // a cobrar en efectivo en lugar del totalPrice (caso COD con anticipo).
            const legacyOrders = orders.map(o => {
                const user = userMap.get(`${o.userPhone}_${o.instanceId}`);
                return {
                    id: o.id,
                    instanceId: o.instanceId,
                    cliente: o.userPhone,
                    status: o.status,
                    producto: o.products,
                    precio: Math.round(o.totalPrice).toLocaleString('es-AR'),
                    tracking: o.tracking || '',
                    postdatado: o.postdated || '',
                    nombre: o.nombre || user?.name || '',
                    calle: o.calle || '',
                    calleOriginal: o.calleOriginal || '',
                    ciudad: o.ciudad || '',
                    provincia: o.provincia || '',
                    cp: o.cp || '',
                    paymentMethod: o.paymentMethod || null,
                    seller: o.seller || '',
                    senaAmount: o.senaAmount || null,
                    senaPaid: !!o.senaPaid,
                    cashRemainder: o.cashRemainder || null,
                    paymentVerifiedAt: o.paymentVerifiedAt ? o.paymentVerifiedAt.toISOString() : null,
                    createdAt: o.createdAt.toISOString()
                };
            });

            res.json({
                data: legacyOrders,
                pagination: {
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit)
                }
            });
        } catch (error) {
            logger.error('[ROUTES] Error fetching orders from DB:', error);
            res.status(500).json({ error: "Failed to fetch orders" });
        }
    });

    // PUT /orders/:id (Edit order details) - Authenticated
    router.put('/orders/:id', ...withSeller(clientPool), async (req, res) => {
        const idResult = uuidSchema.safeParse(req.params.id);
        if (!idResult.success) return res.status(400).json({ error: idResult.error.issues[0].message });
        const id = idResult.data;

        const bodyResult = orderUpdateSchema.safeParse(req.body);
        if (!bodyResult.success) return res.status(400).json({ error: 'Datos inválidos', details: bodyResult.error.issues });
        const { nombre, calle, ciudad, provincia, cp, producto, precio, tracking, status, postdatado } = bodyResult.data;

        try {
            const { prisma } = require('../../../db');

            // Verify order belongs to this seller
            const existing = await prisma.order.findUnique({ where: { id }, select: { instanceId: true } });
            if (!existing) return res.status(404).json({ error: 'Orden no encontrada' });
            if (!isOwnerOrAdmin(req, existing.instanceId)) return res.status(403).json({ error: 'No autorizado' });

            const dataToUpdate = {};
            if (nombre !== undefined) dataToUpdate.nombre = nombre;
            if (calle !== undefined) dataToUpdate.calle = calle;
            if (ciudad !== undefined) dataToUpdate.ciudad = ciudad;
            if (provincia !== undefined) dataToUpdate.provincia = provincia;
            if (cp !== undefined) dataToUpdate.cp = cp;
            if (producto !== undefined) dataToUpdate.products = producto;
            if (precio !== undefined) {
                const parsed = parseInt(precio.toString().replace(/\./g, '').replace(/[^\d]/g, ''), 10);
                dataToUpdate.totalPrice = isNaN(parsed) ? 0 : parsed;
            }
            if (tracking !== undefined) dataToUpdate.tracking = tracking;
            if (status !== undefined) dataToUpdate.status = status;
            if (postdatado !== undefined) dataToUpdate.postdated = postdatado;

            const updatedOrder = await prisma.order.update({
                where: { id },
                data: dataToUpdate
            });

            const legacyOrder = toLegacyOrder(updatedOrder);

            emitScoped(req, 'order_update', legacyOrder);
            res.json({ success: true, order: legacyOrder });
        } catch (error) {
            logger.error('[ROUTES] Error updating order:', error);
            res.status(500).json({ error: "Failed to update order" });
        }
    });

    // POST /orders/:id/status (Update status) - Authenticated
    router.post('/orders/:id/status', ...withSeller(clientPool), async (req, res) => {
        const idResult = uuidSchema.safeParse(req.params.id);
        if (!idResult.success) return res.status(400).json({ error: idResult.error.issues[0].message });
        const id = idResult.data;

        const bodyResult = statusUpdateSchema.safeParse(req.body);
        if (!bodyResult.success) return res.status(400).json({ error: 'Datos inválidos', details: bodyResult.error.issues });
        const { status, tracking } = bodyResult.data;

        try {
            const { prisma } = require('../../../db');

            // Verify order belongs to this seller
            const existing = await prisma.order.findUnique({ where: { id }, select: { instanceId: true } });
            if (!existing) return res.status(404).json({ error: 'Orden no encontrada' });
            if (!isOwnerOrAdmin(req, existing.instanceId)) return res.status(403).json({ error: 'No autorizado' });

            // 1. Update DB
            const dataToUpdate = {};
            if (status) dataToUpdate.status = status;
            if (tracking !== undefined) dataToUpdate.tracking = tracking;

            const updatedOrder = await prisma.order.update({
                where: { id },
                data: dataToUpdate
            });

            // Trigger confirmation message if marked as confirmed
            if (status && status.toLowerCase() === 'confirmado') {
                logger.info(`[ORDER-STATUS] El dashboard marcó la orden ${id} como Confirmado.`);

                // Extraemos solo los números por si vino mezclado o con @lid
                const rawPhone = updatedOrder.userPhone.replace(/\D/g, '');
                const targetPhone = `${rawPhone}@c.us`;

                const msg = "Pedido confirmado ✅\n\n¡Muchas gracias por confiar en Herbalis 🌱!\n\nApenas tengamos el código de seguimiento te lo pasamos.";

                // Skip if user already received confirmation (step already 'completed')
                const ss = req.sellerInstance?.sharedState;
                const cl = req.sellerInstance?.client;
                if (ss?.userState && ss.userState[targetPhone]?.step === 'completed') {
                    logger.info(`[ORDER-STATUS] Skipping confirmation for ${targetPhone} — already completed`);
                } else if (cl) try {
                    const { sendWithRetry } = require('../../utils/retry');
                    logger.info(`[ORDER-STATUS] Intentando enviar WhatsApp a ${targetPhone}...`);
                    await sendWithRetry(cl, targetPhone, msg);
                    logger.info(`[ORDER-STATUS] WhatsApp enviado exitosamente a ${targetPhone}`);

                    if (ss?.userState && ss.userState[targetPhone]) {
                        _setStep(ss.userState[targetPhone], 'completed');
                        ss.userState[targetPhone].history = ss.userState[targetPhone].history || [];
                        _pushHistory(ss.userState[targetPhone], { role: 'bot', content: msg });
                        if (ss.saveState) { try { ss.saveState(targetPhone); } catch (e) { ss.saveState(); } }
                    }
                    if (ss?.logAndEmit) ss.logAndEmit(targetPhone, 'bot', msg, 'completed');
                } catch (e) {
                    logger.error(`[ORDER-STATUS] FALLO AL ENVIAR WHATSAPP a ${targetPhone}. Motivo: ${e.message}`);
                }
            }

            // Format for dashboard and Sheets
            const legacyOrder = toLegacyOrder(updatedOrder);


            emitScoped(req, 'order_update', legacyOrder);
            res.json({ success: true, order: legacyOrder });

        } catch (error) {
            logger.error('[ROUTES] Error updating DB:', error);
            res.status(500).json({ error: "Failed to update order info" });
        }
    });

    // DELETE /orders/:id (Delete order) - Authenticated
    router.delete('/orders/:id', ...withSeller(clientPool), async (req, res) => {
        const idResult = uuidSchema.safeParse(req.params.id);
        if (!idResult.success) return res.status(400).json({ error: idResult.error.issues[0].message });
        const id = idResult.data;

        try {
            const { prisma } = require('../../../db');

            // Verify order belongs to this seller
            const existing = await prisma.order.findUnique({ where: { id }, select: { instanceId: true } });
            if (!existing) return res.status(404).json({ error: 'Orden no encontrada' });
            if (!isOwnerOrAdmin(req, existing.instanceId)) return res.status(403).json({ error: 'No autorizado' });

            // 1. Delete from DB
            await prisma.order.delete({ where: { id } });

            // (Google Sheets fallback removed via DB migration)

            emitScoped(req, 'order_delete', { id });
            res.json({ success: true, deleted: { id } });

        } catch (error) {
            logger.error('[ROUTES] Error deleting from DB:', error);
            res.status(500).json({ error: "Failed to delete order" });
        }
    });

    // GET /orders/tracking/:code (Rastrear envío en Correo Argentino) - Authenticated
    router.get('/orders/tracking/:code', ...withSeller(clientPool), async (req, res) => {
        const { code } = req.params;
        if (!code || code.length < 8) return res.status(400).json({ error: "Código inválido" });

        try {
            const { getTrackingNacional } = require('../../../bot/correoTracker');
            const result = await getTrackingNacional(code);
            res.json(result);
        } catch (e) {
            logger.error('[ROUTES] Error consultando tracking:', e);
            res.status(500).json({ error: "Error interno rastreando el código." });
        }
    });

    // POST /orders/manual-complete — Admin manually completes a sale from the script panel
    router.post('/orders/manual-complete', ...withSeller(clientPool), async (req, res) => {
        let { chatId, silent } = req.body;
        if (!chatId) return res.status(400).json({ error: 'chatId es requerido' });

        try {
            const sellerClient = req.sellerInstance?.client;
            const sellerSharedState = req.sellerInstance?.sharedState;
            const INSTANCE_ID = getInstanceId(req);
            // prisma se requiere ACÁ ARRIBA a propósito: antes era `const` a mitad
            // del handler y el rescate desde ChatLog lo usaba antes de declararse —
            // por la temporal dead zone tiraba ReferenceError que el try/catch se
            // tragaba como "DB chatLog query failed" → el rescate desde DB NUNCA
            // funcionó (caso Pablo Martinez 23-jul).
            const { prisma } = require('../../../db');

            chatId = await mc.resolveChatId(chatId, sellerClient);
            logger.info(`[MANUAL-COMPLETE] Resolved chatId: ${chatId}`);
            const phoneNumeric = chatId.split('@')[0];

            const state = sellerSharedState?.userState?.[chatId];
            if (!state) {
                const keys = Object.keys(sellerSharedState?.userState || {}).slice(0, 5);
                logger.info(`[MANUAL-COMPLETE] No state found for ${chatId}. Available keys sample:`, keys);
                return res.status(404).json({ error: 'No hay estado de conversación para este chat' });
            }

            const cart = state.cart && state.cart.length ? state.cart : (state.pendingOrder?.cart || []);

            // 1. Dirección: state → rescate por IA si falta algo → override del modal.
            let addr = mc.collectAddress(state);
            addr = await mc.rescueAddress({ addr, state, phoneNumeric, instanceId: INSTANCE_ID, prisma, chatId });
            const manualAddr = req.body?.manualAddr;
            addr = mc.applyManualOverride({ addr, manualAddr, state, chatId });

            // 2. Tipo de envío: detección automática, salvo override del modal.
            const shippingTypeReq = req.body?.shippingType;   // 'domicilio' | 'sucursal'
            const paymentMethodReq = req.body?.paymentMethod; // 'mercadopago' | 'transferencia' | 'contrarembolso'
            const paymentVerifiedReq = req.body?.paymentVerified === true; // checkbox "vi el comprobante"
            const isRetiro = shippingTypeReq ? (shippingTypeReq === 'sucursal') : mc.detectRetiro({ state, addr });
            if (isRetiro) addr = mc.applyRetiroAddress({ addr, state });

            // 3. Método de pago: override explícito del modal, o default según envío.
            if (paymentMethodReq) {
                state.paymentMethod = paymentMethodReq;
            } else if (isRetiro && !state.paymentMethod) {
                state.paymentMethod = 'contrarembolso';
            }
            const paymentMethodDefault = state.paymentMethod || (isRetiro ? 'contrarembolso' : 'mercadopago');
            logger.info(`[MANUAL-COMPLETE] ${chatId} envío=${isRetiro ? 'sucursal' : 'domicilio'} pago=${paymentMethodDefault} (shippingTypeReq=${shippingTypeReq || 'auto'})`);

            // 4. GATE: no creamos órdenes incompletas. Domicilio exige
            // nombre+calle+ciudad; retiro exige nombre+ciudad+CP (la calle no
            // aplica). En preview NO bloqueamos: el modal se abre igual con lo
            // que se haya podido extraer.
            const preview = req.body?.preview === true;
            const allowEmpty = req.body?.allowEmpty === true;
            const missingEssential = isRetiro
                ? (!addr.nombre || !addr.ciudad || !addr.cp)
                : (!addr.nombre || !addr.calle || !addr.ciudad);
            if (!preview && !allowEmpty && !manualAddr && missingEssential) {
                logger.warn(`[MANUAL-COMPLETE] Datos incompletos para ${chatId} (retiro=${isRetiro}): nombre=${!!addr.nombre} calle=${!!addr.calle} ciudad=${!!addr.ciudad} cp=${!!addr.cp}. Asking admin for manual entry.`);
                return res.status(422).json({
                    error: 'Faltan datos de envío del cliente.',
                    detail: 'Completá los datos faltantes.',
                    needsManualEntry: true,
                    extracted: addr  // pre-rellena el modal con lo que sí pudimos extraer
                });
            }

            // 5. Producto, plan y total.
            const rescued = mc.rescueProductFromHistory({ state, cart });
            const { plan, total, product } = mc.resolveProductAndTotal({ body: req.body, state, cart, rescued, chatId });

            // 6. PREVIEW: el panel SIEMPRE abre el modal de verificación antes de
            // confirmar (con mensaje o sin). Devolvemos lo detectado SIN crear la
            // orden; se crea recién cuando el admin confirma el modal (request sin
            // preview, con manualAddr + shippingType + paymentMethod).
            if (preview) {
                const { _getPrices } = require('../../flows/utils/pricing');
                return res.json({
                    preview: true,
                    prefill: {
                        nombre: addr.nombre || '',
                        // Mostramos la calle real (calleOriginal si es retiro) para que,
                        // si el admin cambia a domicilio, el campo venga pre-cargado.
                        calle: isRetiro ? (addr.calleOriginal || '') : (addr.calle || ''),
                        ciudad: addr.ciudad || '',
                        provincia: addr.provincia || '',
                        cp: addr.cp || '',
                        shippingType: isRetiro ? 'sucursal' : 'domicilio',
                        paymentMethod: paymentMethodDefault,
                        product,
                        plan: String(plan),
                        total,
                        productDetected: /Cápsulas|Gotas|Semillas/.test(product),
                        prices: _getPrices(),
                    }
                });
            }

            // 7. Crear/confirmar la orden.
            const order = await mc.persistOrder({
                prisma, phoneNumeric, instanceId: INSTANCE_ID, addr, state, product, total,
                seller: sellerClient?.info?.wid?.user || null,
                paymentVerifiedReq,
            });

            _setStep(state, 'completed');

            // 8. Avisarle al cliente, salvo modo silencioso.
            if (!silent) {
                const msg = "Pedido confirmado ✅\n\n¡Muchas gracias por confiar en Herbalis 🌱!\n\nApenas tengamos el código de seguimiento te lo pasamos.";
                try {
                    const targetPhone = `${phoneNumeric}@c.us`;
                    logger.info(`[MANUAL-COMPLETE] Enviando WhatsApp de confirmación a ${targetPhone}...`);
                    if (sellerClient) await sellerClient.sendMessage(targetPhone, msg);
                    // Envío directo (no pasa por sendMessageWithDelay), así que el
                    // history se anota acá — ver la convención en CLAUDE.md.
                    _pushHistory(state, { role: 'bot', content: msg });
                    if (sellerSharedState?.logAndEmit) sellerSharedState.logAndEmit(chatId, 'bot', msg, 'completed');
                } catch (e) {
                    logger.error(`[MANUAL-COMPLETE] Error enviando WhatsApp:`, e.message);
                }
            } else {
                logger.info(`[MANUAL-COMPLETE] silent=true, omitiendo mensaje de confirmación a ${phoneNumeric}`);
            }

            if (sellerSharedState?.saveState) {
                try { sellerSharedState.saveState(chatId); } catch (e) { sellerSharedState.saveState(); }
            }

            // 9. Avisar al panel y sacar la alerta de la cola.
            emitScoped(req, 'order_update', { action: 'created', order: toLegacyOrder(order) });

            const alerts = sellerSharedState?.sessionAlerts;
            if (alerts) {
                const alertIndex = alerts.findIndex(a => a.userPhone === phoneNumeric || a.userPhone === chatId);
                if (alertIndex !== -1) {
                    alerts.splice(alertIndex, 1);
                    emitScoped(req, 'alerts_updated', alerts);
                    logger.info(`[MANUAL-COMPLETE] Alert cleared for ${phoneNumeric}`);
                }
            }

            logger.info(`[MANUAL-COMPLETE] Order confirmed for ${phoneNumeric}: ${product} — $${total}`);
            res.json({ success: true, orderId: order.id });
        } catch (e) {
            logger.error('[MANUAL-COMPLETE] Error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
