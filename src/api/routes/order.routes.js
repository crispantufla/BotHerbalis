const express = require('express');
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('../../middleware/auth');

module.exports = (client, sharedState) => {
    const router = express.Router();
    const { io } = sharedState;

    const resolveChatId = async (id) => {
        if (!id) return id;
        // Handle @lid format
        if (id.includes('@lid')) {
            try {
                const contact = await client.getContactById(id);
                if (contact && contact.number) return `${contact.number}@c.us`;
            } catch (e) {
                console.error(`[LID-RESOLVE] API Error for ${id}:`, e.message);
            }
            return id;
        }
        // Normalize bare phone numbers to @c.us format
        if (!id.includes('@')) {
            return `${id.replace(/\D/g, '')}@c.us`;
        }
        return id;
    };

    // GET /orders (List orders from PostgreSQL with Pagination)
    router.get('/orders', authMiddleware, async (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 100;
            const skip = (page - 1) * limit;

            const { prisma } = require('../../../db');

            // Get total count for metadata
            const total = await prisma.order.count();

            const orders = await prisma.order.findMany({
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            });

            // Workaround for Prisma adapter-pg composite key bug with include: { user: true }
            const userPhones = [...new Set(orders.map(o => o.userPhone))];
            const instanceIds = [...new Set(orders.map(o => o.instanceId))];
            const users = await prisma.user.findMany({
                where: {
                    phone: { in: userPhones },
                    instanceId: { in: instanceIds }
                }
            });
            const userMap = new Map();
            users.forEach(u => userMap.set(`${u.phone}_${u.instanceId}`, u));

            // Map to legacy format expected by dashboard to avoid breaking frontend fields
            const legacyOrders = orders.map(o => {
                const user = userMap.get(`${o.userPhone}_${o.instanceId}`);
                return {
                    id: o.id,
                    cliente: o.userPhone,
                    status: o.status,
                    producto: o.products,
                    precio: Math.round(o.totalPrice).toLocaleString('es-AR'),
                    tracking: o.tracking || '',
                    postdatado: o.postdated || '',
                    nombre: o.nombre || user?.name || '',
                    calle: o.calle || '',
                    ciudad: o.ciudad || '',
                    provincia: o.provincia || '',
                    cp: o.cp || '',
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
            console.error('🔴 [ROUTES] Error fetching orders from DB:', error);
            res.status(500).json({ error: "Failed to fetch orders" });
        }
    });

    // PUT /orders/:id (Edit order details) - Authenticated
    router.put('/orders/:id', authMiddleware, async (req, res) => {
        const { id } = req.params;
        const { nombre, calle, ciudad, provincia, cp, producto, precio, tracking, status, postdatado } = req.body;

        try {
            const { prisma } = require('../../../db');

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
                ciudad: updatedOrder.ciudad || '',
                provincia: updatedOrder.provincia || '',
                cp: updatedOrder.cp || '',
                seller: updatedOrder.seller || '',
                createdAt: updatedOrder.createdAt.toISOString()
            };

            if (io) io.emit('order_update', legacyOrder);
            res.json({ success: true, order: legacyOrder });
        } catch (error) {
            console.error('🔴 [ROUTES] Error updating order:', error);
            res.status(500).json({ error: "Failed to update order" });
        }
    });

    // POST /orders/:id/status (Update status) - Authenticated
    router.post('/orders/:id/status', authMiddleware, async (req, res) => {
        const { id } = req.params;
        const { status, tracking } = req.body;

        try {
            const { prisma } = require('../../../db');

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
                console.log(`[ORDER-STATUS] El dashboard marcó la orden ${id} como Confirmado.`);

                // Extraemos solo los números por si vino mezclado o con @lid
                const rawPhone = updatedOrder.userPhone.replace(/\D/g, '');
                const targetPhone = `${rawPhone}@c.us`;

                const msg = "¡Excelente! Tu pedido ya fue ingresado 🚀\n\nTe vamos a avisar cuando lo despachemos con el número de seguimiento.\n\n¡Muchas gracias por confiar en Herbalis!";

                try {
                    console.log(`[ORDER-STATUS] Intentando enviar WhatsApp a ${targetPhone}...`);
                    await client.sendMessage(targetPhone, msg);
                    console.log(`[ORDER-STATUS] ✅ WhatsApp enviado exitosamente a ${targetPhone}`);

                    if (sharedState.userState && sharedState.userState[targetPhone]) {
                        sharedState.userState[targetPhone].step = 'completed';
                        sharedState.userState[targetPhone].history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                        if (sharedState.saveState) {
                            try { sharedState.saveState(targetPhone); } catch (e) { sharedState.saveState(); }
                        }
                    }
                    if (sharedState.logAndEmit) {
                        sharedState.logAndEmit(targetPhone, 'bot', msg, 'completed');
                    }
                } catch (e) {
                    console.error(`🔴 [ORDER-STATUS] FALLO AL ENVIAR WHATSAPP a ${targetPhone}. Motivo: ${e.message}`);
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
                ciudad: updatedOrder.ciudad || '',
                provincia: updatedOrder.provincia || '',
                cp: updatedOrder.cp || '',
                seller: updatedOrder.seller || '',
                createdAt: updatedOrder.createdAt.toISOString()
            };


            if (io) io.emit('order_update', legacyOrder);
            res.json({ success: true, order: legacyOrder });

        } catch (error) {
            console.error('🔴 [ROUTES] Error updating DB:', error);
            res.status(500).json({ error: "Failed to update order info" });
        }
    });

    // DELETE /orders/:id (Delete order) - Authenticated
    router.delete('/orders/:id', authMiddleware, async (req, res) => {
        const { id } = req.params;

        try {
            const { prisma } = require('../../../db');

            // 1. Delete from DB
            await prisma.order.delete({ where: { id } });

            // (Google Sheets fallback removed via DB migration)

            if (io) io.emit('order_delete', { id });
            res.json({ success: true, deleted: { id } });

        } catch (error) {
            console.error('🔴 [ROUTES] Error deleting from DB:', error);
            res.status(500).json({ error: "Failed to delete order" });
        }
    });

    // GET /orders/tracking/:code (Rastrear envío en Correo Argentino) - Authenticated
    router.get('/orders/tracking/:code', authMiddleware, async (req, res) => {
        const { code } = req.params;
        if (!code || code.length < 8) return res.status(400).json({ error: "Código inválido" });

        try {
            const { getTrackingNacional } = require('../../../bot/correoTracker');
            const result = await getTrackingNacional(code);
            res.json(result);
        } catch (e) {
            console.error('🔴 [ROUTES] Error consultando tracking:', e);
            res.status(500).json({ error: "Error interno rastreando el código." });
        }
    });

    // POST /orders/manual-complete — Admin manually completes a sale from the script panel
    router.post('/orders/manual-complete', authMiddleware, async (req, res) => {
        let { chatId } = req.body;
        if (!chatId) return res.status(400).json({ error: 'chatId es requerido' });

        try {
            chatId = await resolveChatId(chatId);
            console.log(`[MANUAL-COMPLETE] Resolved chatId: ${chatId}`);

            const { userState } = sharedState;
            const state = userState?.[chatId];

            if (!state) {
                console.log(`[MANUAL-COMPLETE] No state found for ${chatId}. Available keys sample:`, Object.keys(userState || {}).slice(0, 5));
                return res.status(404).json({ error: 'No hay estado de conversación para este chat' });
            }

            const cart = state.cart || [];
            const addr = state.partialAddress || {};
            const plan = state.selectedPlan || cart[0]?.plan || '60';
            const subtotal = cart.reduce((sum, i) => sum + parseInt((i.price || '0').toString().replace(/\D/g, '')), 0);
            const adicional = state.adicionalMAX || 0;
            const total = subtotal + adicional;

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

            const rawProduct = cart.map(i => i.product).join(' + ') || state.selectedProduct || 'Producto';
            const rawPlan = cart.map(i => `${i.plan} días`).join(' + ') || `${plan} días`;
            const product = normalizeProductName(rawProduct, rawPlan, total);

            const phoneNumeric = chatId.split('@')[0];

            const { prisma } = require('../../../db');
            const INSTANCE_ID = process.env.INSTANCE_ID || 'default';

            // Upsert user
            await prisma.user.upsert({
                where: { phone_instanceId: { phone: phoneNumeric, instanceId: INSTANCE_ID } },
                update: { name: addr.nombre || null },
                create: { phone: phoneNumeric, instanceId: INSTANCE_ID, name: addr.nombre || null }
            });

            const seller = client?.info?.wid?.user || null;

            // Check if there's already a Pendiente order for this user — update it instead of creating a duplicate
            const existingOrder = await prisma.order.findFirst({
                where: { userPhone: phoneNumeric, status: 'Pendiente', instanceId: INSTANCE_ID },
                orderBy: { createdAt: 'desc' }
            });

            let order;
            if (existingOrder) {
                console.log(`[MANUAL-COMPLETE] Found existing Pendiente order ${existingOrder.id}, updating to Confirmado...`);
                order = await prisma.order.update({
                    where: { id: existingOrder.id },
                    data: {
                        status: 'Confirmado',
                        seller: seller,
                        // Update address fields in case they were collected after the initial order
                        nombre: addr.nombre || existingOrder.nombre,
                        calle: addr.calle || existingOrder.calle,
                        ciudad: addr.ciudad || existingOrder.ciudad,
                        provincia: addr.provincia || existingOrder.provincia,
                        cp: addr.cp || existingOrder.cp,
                    }
                });
            } else {
                console.log(`[MANUAL-COMPLETE] No existing order found, creating new Confirmado order...`);
                order = await prisma.order.create({
                    data: {
                        instanceId: INSTANCE_ID,
                        userPhone: phoneNumeric,
                        status: 'Confirmado',
                        products: product,
                        totalPrice: total,
                        postdated: state.postdatado || null,
                        nombre: addr.nombre || null,
                        calle: addr.calle || null,
                        ciudad: addr.ciudad || null,
                        provincia: addr.provincia || null,
                        cp: addr.cp || null,
                        seller: seller,
                    }
                });
            }



            // Set user state to completed and send confirmation
            const msg = "¡Excelente! Tu pedido ya fue ingresado 🚀\n\nTe vamos a avisar cuando lo despachemos con el número de seguimiento.\n\n¡Muchas gracias por confiar en Herbalis!";

            try {
                const targetPhone = `${phoneNumeric}@c.us`;
                console.log(`[MANUAL-COMPLETE] Enviando WhatsApp de confirmación a ${targetPhone}...`);
                await client.sendMessage(targetPhone, msg);

                if (state) {
                    state.step = 'completed';
                    state.history = state.history || [];
                    state.history.push({ role: 'bot', content: msg, timestamp: Date.now() });
                    if (sharedState.saveState) {
                        try { sharedState.saveState(chatId); } catch (e) { sharedState.saveState(); }
                    }
                }
                if (sharedState.logAndEmit) {
                    sharedState.logAndEmit(chatId, 'bot', msg, 'completed');
                }
            } catch (e) {
                console.error(`🔴 [MANUAL-COMPLETE] Error enviando WhatsApp:`, e.message);
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
                ciudad: order.ciudad || '',
                provincia: order.provincia || '',
                cp: order.cp || '',
                createdAt: order.createdAt.toISOString()
            };

            // Emit socket event for real-time dashboard update
            if (io) {
                io.emit('order_update', { action: 'created', order: legacyOrder });
            }

            // Clear the alert from sessionAlerts so it doesn't reappear on reload
            const alertIndex = sharedState.sessionAlerts.findIndex(a => a.userPhone === phoneNumeric || a.userPhone === chatId);
            if (alertIndex !== -1) {
                sharedState.sessionAlerts.splice(alertIndex, 1);
                if (io) io.emit('alerts_updated', sharedState.sessionAlerts);
                console.log(`[MANUAL-COMPLETE] Alert cleared for ${phoneNumeric}`);
            }

            console.log(`✅ [MANUAL-COMPLETE] Order confirmed for ${phoneNumeric}: ${product} — $${total}`);
            res.json({ success: true, orderId: order.id });
        } catch (e) {
            console.error('🔴 [MANUAL-COMPLETE] Error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
