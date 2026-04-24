const express = require('express');
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('../../middleware/auth');
const logger = require('../../utils/logger');
const { z } = require('zod');

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
    const { withSeller, getInstanceId, isOwnerOrAdmin } = require('./routeHelpers');

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

    // GET /orders (List orders from PostgreSQL with Pagination)
    router.get('/orders', ...withSeller(clientPool), async (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = Math.min(parseInt(req.query.limit) || 100, 500);
            const skip = (page - 1) * limit;
            const instanceId = getInstanceId(req);

            const { prisma } = require('../../../db');

            const where = instanceId ? { instanceId } : {};

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

            // Map to legacy format expected by dashboard to avoid breaking frontend fields
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

            const legacyOrder = {
                id: updatedOrder.id,
                cliente: updatedOrder.userPhone,
                status: updatedOrder.status,
                producto: updatedOrder.products,
                precio: Math.round(updatedOrder.totalPrice).toLocaleString('es-AR'),
                tracking: updatedOrder.tracking || '',
                postdatado: updatedOrder.postdated || '',
                nombre: updatedOrder.nombre || '',
                calle: updatedOrder.calle || '',
                calleOriginal: updatedOrder.calleOriginal || '',
                ciudad: updatedOrder.ciudad || '',
                provincia: updatedOrder.provincia || '',
                cp: updatedOrder.cp || '',
                paymentMethod: updatedOrder.paymentMethod || null,
                seller: updatedOrder.seller || '',
                createdAt: updatedOrder.createdAt.toISOString()
            };

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
                        ss.userState[targetPhone].step = 'completed';
                        ss.userState[targetPhone].history = ss.userState[targetPhone].history || [];
                        ss.userState[targetPhone].history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                        if (ss.saveState) { try { ss.saveState(targetPhone); } catch (e) { ss.saveState(); } }
                    }
                    if (ss?.logAndEmit) ss.logAndEmit(targetPhone, 'bot', msg, 'completed');
                } catch (e) {
                    logger.error(`[ORDER-STATUS] FALLO AL ENVIAR WHATSAPP a ${targetPhone}. Motivo: ${e.message}`);
                }
            }

            // Format for dashboard and Sheets
            const legacyOrder = {
                id: updatedOrder.id,
                cliente: updatedOrder.userPhone,
                status: updatedOrder.status,
                producto: updatedOrder.products,
                precio: Math.round(updatedOrder.totalPrice).toLocaleString('es-AR'),
                tracking: updatedOrder.tracking || '',
                postdatado: updatedOrder.postdated || '',
                nombre: updatedOrder.nombre || '',
                calle: updatedOrder.calle || '',
                calleOriginal: updatedOrder.calleOriginal || '',
                ciudad: updatedOrder.ciudad || '',
                provincia: updatedOrder.provincia || '',
                cp: updatedOrder.cp || '',
                paymentMethod: updatedOrder.paymentMethod || null,
                seller: updatedOrder.seller || '',
                createdAt: updatedOrder.createdAt.toISOString()
            };


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

            const resolveChatIdLocal = async (id) => {
                if (!id) return id;
                if (id.includes('@lid')) {
                    try { const c = await sellerClient?.getContactById(id); if (c?.number) return `${c.number}@c.us`; } catch (e) { /* ignore */ }
                    return id;
                }
                if (!id.includes('@')) return `${id.replace(/\D/g, '')}@c.us`;
                return id;
            };

            chatId = await resolveChatIdLocal(chatId);
            logger.info(`[MANUAL-COMPLETE] Resolved chatId: ${chatId}`);

            const userState = sellerSharedState?.userState;
            const state = userState?.[chatId];

            if (!state) {
                logger.info(`[MANUAL-COMPLETE] No state found for ${chatId}. Available keys sample:`, Object.keys(userState || {}).slice(0, 5));
                return res.status(404).json({ error: 'No hay estado de conversación para este chat' });
            }

            const cart = state.cart || [];
            let addr = state.partialAddress || {};

            // FALLBACK DATA RESCUE: If admin clicks "Manual Complete" and the bot hasn't extracted the address yet
            // (e.g. because they paused the bot or the bot failed to parse), we run a quick AI extraction over the last few user messages.
            if (!addr.nombre || !addr.calle || !addr.ciudad) {
                logger.info(`[MANUAL-COMPLETE] Datos de envío incompletos. Intentando rescatarlos del historial para ${chatId}...`);
                const history = state.history || [];
                // Get the last 10 messages from the user only
                const recentUserMessages = history.filter(m => m.role === 'user').slice(-10);
                if (recentUserMessages.length > 0) {
                    const textToAnalyze = recentUserMessages.map(m => m.content).join(" | ");

                    try {
                        const { aiService } = require('../../services/ai');
                        const extracted = await aiService.parseAddress(textToAnalyze);

                        if (!extracted._error) {
                            logger.info(`[MANUAL-COMPLETE] Extracción AI exitosa:`, extracted);
                            addr = {
                                nombre: extracted.nombre || addr.nombre,
                                calle: extracted.calle || addr.calle,
                                ciudad: extracted.ciudad || addr.ciudad,
                                provincia: extracted.provincia || addr.provincia,
                                cp: extracted.cp || addr.cp
                            };

                            // Save rescued data to state
                            state.partialAddress = addr;
                        }
                    } catch (extError) {
                        logger.error(`[MANUAL-COMPLETE] Error en extracción AI de rescate:`, extError.message);
                    }
                }
            }
            // FALLBACK PRODUCT/PLAN/PRICE RESCUE: scan bot messages in history for the confirmation template
            // This handles manually-managed conversations where the bot flow never set cart/selectedProduct.
            let rescuedProduct = null, rescuedPlan = null, rescuedTotal = null;
            if (cart.length === 0 && !state.selectedProduct) {
                const history = state.history || [];
                const botMessages = history.filter(m => m.role === 'bot').map(m => m.content || '').join('\n');
                // Match "Producto: Cápsulas de Nuez de la India" style lines
                const productMatch = botMessages.match(/Producto:\s*(.+?)(?:\n|Plan:|$)/i);
                if (productMatch) rescuedProduct = productMatch[1].trim();
                // Match "Plan: 60 días" or "Plan: 120 días"
                const planMatch = botMessages.match(/Plan:\s*(\d+)/i);
                if (planMatch) rescuedPlan = planMatch[1];
                // Match "Total a pagar al recibir:\n$46.900" or "Total a abonar al recibir: $36.900"
                const totalMatch = botMessages.match(/[Tt]otal[^:]*:\s*\$?\s*([\d.,]+)/);
                if (totalMatch) rescuedTotal = parseInt(totalMatch[1].replace(/\./g, '').replace(',', '')) || null;
                if (rescuedProduct || rescuedTotal) {
                    logger.info(`[MANUAL-COMPLETE] Rescate de producto desde historial: ${rescuedProduct} / ${rescuedPlan} días / $${rescuedTotal}`);
                }
            }

            const plan = state.selectedPlan || cart[0]?.plan || rescuedPlan || '60';
            // Prefer state.totalPrice (already includes adicionalMAX and reflects latest plan change)
            // Fall back to recalculating from cart only if totalPrice is missing.
            let total;
            if (state.totalPrice) {
                total = parseInt(state.totalPrice.toString().replace(/\./g, '').replace(/[^\d]/g, '')) || 0;
            } else if (rescuedTotal) {
                total = rescuedTotal;
            } else {
                const subtotal = cart.reduce((sum, i) => sum + parseInt((i.price || '0').toString().replace(/\D/g, '')), 0);
                const adicional = state.adicionalMAX || 0;
                total = subtotal + adicional;
            }

            // Normalize product name to standard format: "Cápsulas (120 días)"
            const normalizeProductName = (rawProduct, rawPlan, price) => {
                const lower = (rawProduct || '').toLowerCase();
                let baseType = '';
                if (lower.includes('capsul') || lower.includes('cápsul')) baseType = 'Cápsulas';
                else if (lower.includes('gota')) baseType = 'Gotas';
                else if (lower.includes('semilla')) baseType = 'Semillas';
                if (!baseType) return rawProduct || 'Desconocido';
                const planMatch = (rawPlan || '').match(/(\d+)/);
                let duration = planMatch ? parseInt(planMatch[1]) : 0;
                if (!duration || duration % 60 !== 0) {
                    if (baseType === 'Cápsulas') duration = price >= 66900 ? 120 : 60;
                    else if (baseType === 'Gotas') duration = price >= 68900 ? 120 : 60;
                    else if (baseType === 'Semillas') duration = price >= 49900 ? 120 : 60;
                }
                return `${baseType} (${duration} días)`;
            };

            const rawProduct = cart.map(i => i.product).join(' + ') || state.selectedProduct || rescuedProduct || 'Producto';
            const rawPlan = cart.map(i => `${i.plan} días`).join(' + ') || `${plan} días`;
            const product = normalizeProductName(rawProduct, rawPlan, total);

            const phoneNumeric = chatId.split('@')[0];

            const { prisma } = require('../../../db');

            const seller = sellerClient?.info?.wid?.user || null;

            // Atomic transaction: upsert user + find/create order to prevent duplicates
            const order = await prisma.$transaction(async (tx) => {
                await tx.user.upsert({
                    where: { phone_instanceId: { phone: phoneNumeric, instanceId: INSTANCE_ID } },
                    update: { name: addr.nombre || null },
                    create: { phone: phoneNumeric, instanceId: INSTANCE_ID, name: addr.nombre || null }
                });

                const existingOrder = await tx.order.findFirst({
                    where: { userPhone: phoneNumeric, status: 'Pendiente', instanceId: INSTANCE_ID },
                    orderBy: { createdAt: 'desc' }
                });

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
                        }
                    });
                } else {
                    logger.info(`[MANUAL-COMPLETE] No existing order found, creating new Confirmado order...`);
                    return await tx.order.create({
                        data: {
                            instanceId: INSTANCE_ID,
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
                        }
                    });
                }
            });



            // Set user state to completed
            if (state) {
                state.step = 'completed';
            }

            // Send confirmation message unless silent mode
            if (!silent) {
                const msg = "Pedido confirmado ✅\n\n¡Muchas gracias por confiar en Herbalis 🌱!\n\nApenas tengamos el código de seguimiento te lo pasamos.";
                try {
                    const targetPhone = `${phoneNumeric}@c.us`;
                    logger.info(`[MANUAL-COMPLETE] Enviando WhatsApp de confirmación a ${targetPhone}...`);
                    if (sellerClient) await sellerClient.sendMessage(targetPhone, msg);

                    if (state) {
                        state.history = state.history || [];
                        state.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                    }
                    if (sellerSharedState?.logAndEmit) sellerSharedState.logAndEmit(chatId, 'bot', msg, 'completed');
                } catch (e) {
                    logger.error(`[MANUAL-COMPLETE] Error enviando WhatsApp:`, e.message);
                }
            } else {
                logger.info(`[MANUAL-COMPLETE] silent=true, omitiendo mensaje de confirmación a ${phoneNumeric}`);
            }

            if (state && sellerSharedState?.saveState) {
                try { sellerSharedState.saveState(chatId); } catch (e) { sellerSharedState.saveState(); }
            }

            const legacyOrder = {
                id: order.id,
                cliente: order.userPhone,
                status: order.status,
                producto: order.products,
                precio: Math.round(order.totalPrice).toLocaleString('es-AR'),
                tracking: order.tracking || '',
                postdatado: order.postdated || '',
                nombre: order.nombre || '',
                calle: order.calle || '',
                calleOriginal: order.calleOriginal || '',
                ciudad: order.ciudad || '',
                provincia: order.provincia || '',
                cp: order.cp || '',
                paymentMethod: order.paymentMethod || null,
                createdAt: order.createdAt.toISOString()
            };

            // Emit socket event for real-time dashboard update
            emitScoped(req, 'order_update', { action: 'created', order: legacyOrder });

            // Clear the alert from sessionAlerts so it doesn't reappear on reload
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
