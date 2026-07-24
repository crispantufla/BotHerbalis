const express = require('express');
const logger = require('../../utils/logger');
const { z } = require('zod');
const { _setStep } = require('../../flows/utils/flowHelpers');

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
                senaAmount: updatedOrder.senaAmount || null,
                senaPaid: !!updatedOrder.senaPaid,
                cashRemainder: updatedOrder.cashRemainder || null,
                paymentVerifiedAt: updatedOrder.paymentVerifiedAt ? updatedOrder.paymentVerifiedAt.toISOString() : null,
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
                        _setStep(ss.userState[targetPhone], 'completed');
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
                senaAmount: updatedOrder.senaAmount || null,
                senaPaid: !!updatedOrder.senaPaid,
                cashRemainder: updatedOrder.cashRemainder || null,
                paymentVerifiedAt: updatedOrder.paymentVerifiedAt ? updatedOrder.paymentVerifiedAt.toISOString() : null,
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
            // prisma se requiere ACÁ ARRIBA a propósito: antes era `const` a mitad
            // del handler (~L703) y el rescate desde ChatLog lo usaba antes de
            // declararse — por la temporal dead zone tiraba ReferenceError que el
            // try/catch se tragaba como "DB chatLog query failed" → el rescate desde
            // DB NUNCA funcionó (mismo patrón que el bug de phoneNumeric de abajo;
            // caso Pablo Martinez 23-jul).
            const { prisma } = require('../../../db');

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

            // phoneNumeric se declara ACÁ ARRIBA a propósito. Antes era `const` al
            // final (~L590) y el bloque de rescate desde ChatLog lo usaba antes de
            // declararse: por la temporal dead zone tiraba ReferenceError que el
            // try/catch se tragaba como "DB chatLog query failed" → el rescate desde
            // la DB NUNCA funcionaba (caso Nora Aguirre 06-jun).
            const phoneNumeric = chatId.split('@')[0];

            const userState = sellerSharedState?.userState;
            const state = userState?.[chatId];

            if (!state) {
                logger.info(`[MANUAL-COMPLETE] No state found for ${chatId}. Available keys sample:`, Object.keys(userState || {}).slice(0, 5));
                return res.status(404).json({ error: 'No hay estado de conversación para este chat' });
            }

            const cart = state.cart && state.cart.length ? state.cart : (state.pendingOrder?.cart || []);
            // Prefer pendingOrder (post Maps-validation, source of truth) over partialAddress.
            // partialAddress can get cleared by step transitions / globals while pendingOrder survives,
            // so reading partialAddress alone produced empty orders in production (caso Elvira 27/04/2026).
            const pending = state.pendingOrder || {};
            const partial = state.partialAddress || {};
            let addr = {
                nombre:        pending.nombre        || partial.nombre        || null,
                calle:         pending.calle         || partial.calle         || null,
                ciudad:        pending.ciudad        || partial.ciudad        || null,
                provincia:     pending.provincia     || partial.provincia     || null,
                cp:            pending.cp            || partial.cp            || null,
                calleOriginal: pending.calleOriginal || partial.calleOriginal || null,
            };

            // FALLBACK DATA RESCUE: el state se puede haber pausado/limpiado.
            // Buscamos mensajes del usuario en (a) state.history y (b) ChatLog en DB
            // como fuente de verdad. Esto es lo que evita que el manual-complete
            // cree ordenes con nombre/calle/ciudad=null cuando el bot pauso por
            // "La IA fallo en extraer la calle".
            if (!addr.nombre || !addr.calle || !addr.ciudad) {
                logger.info(`[MANUAL-COMPLETE] Datos de envío incompletos. Intentando rescatarlos para ${chatId}...`);

                // Combinar mensajes del state (memoria) + ChatLog (DB) — el state
                // se trunca cuando hay summary, ChatLog tiene todo el historial.
                const stateMsgs = (state.history || []).filter(m => m.role === 'user').map(m => m.content || '');
                let dbMsgs = [];
                try {
                    const dbLogs = await prisma.chatLog.findMany({
                        where: { userPhone: phoneNumeric, instanceId: INSTANCE_ID, role: 'user' },
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

                if (allMsgs.length > 0) {
                    const textToAnalyze = allMsgs.join(" | ");

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
                                cp: extracted.cp || addr.cp,
                                calleOriginal: addr.calleOriginal || extracted.calle || null
                            };

                            // Save rescued data to state
                            state.partialAddress = addr;
                        }
                    } catch (extError) {
                        logger.error(`[MANUAL-COMPLETE] Error en extracción AI de rescate:`, extError.message);
                    }
                }
            }

            // OVERRIDE MANUAL: el admin abrió el modal de entrada manual y nos
            // mandó los datos a mano. Estos pisan lo que se haya logrado extraer.
            const manualAddr = req.body?.manualAddr;
            if (manualAddr && typeof manualAddr === 'object') {
                addr = {
                    nombre:        manualAddr.nombre        || addr.nombre        || null,
                    calle:         manualAddr.calle         || addr.calle         || null,
                    ciudad:        manualAddr.ciudad        || addr.ciudad        || null,
                    provincia:     manualAddr.provincia     || addr.provincia     || null,
                    cp:            manualAddr.cp            || addr.cp            || null,
                    calleOriginal: manualAddr.calle         || addr.calleOriginal || null,
                };
                state.partialAddress = addr;
                logger.info(`[MANUAL-COMPLETE] Address override from admin form for ${chatId}: ${addr.nombre} / ${addr.calle}`);
            }

            // RETIRO EN SUCURSAL: no tiene calle (con localidad + CP el Correo
            // asigna la sucursal). Si no lo detectamos, el gate de abajo exige
            // calle y rechaza pedidos de retiro con datos completos (nombre +
            // localidad + CP) forzando carga manual. Caso real Nora Aguirre 06-jun:
            // dio nombre + "San Miguel de Tucumán" + CP 4000 y el botón no los tomó
            // porque "faltaba la calle".
            const _lc = (s) => (s || '').toLowerCase();
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
            // El admin puede forzar tipo de envío y método de pago desde el modal
            // de verificación; esos overrides pisan la detección automática.
            const shippingTypeReq = req.body?.shippingType;   // 'domicilio' | 'sucursal'
            const paymentMethodReq = req.body?.paymentMethod; // 'mercadopago' | 'transferencia' | 'contrarembolso'
            // Checkbox "vi el comprobante" del modal (solo aplica a transferencia).
            const paymentVerifiedReq = req.body?.paymentVerified === true;
            const detectedRetiro = retiroCommitted && !domicilioCommitted;
            const isRetiro = shippingTypeReq ? (shippingTypeReq === 'sucursal') : detectedRetiro;

            if (isRetiro) {
                // Retiro en sucursal: la calle no aplica. Conservamos la calle real
                // (si la había) en calleOriginal para referencia del admin.
                if (addr.calle && _lc(addr.calle) !== 'a sucursal' && !addr.calleOriginal) {
                    addr.calleOriginal = addr.calle;
                }
                addr.calle = 'A sucursal';
                state.partialAddress = addr;
            }

            // Método de pago: override explícito del modal, o default según envío.
            if (paymentMethodReq) {
                state.paymentMethod = paymentMethodReq;
            } else if (isRetiro && !state.paymentMethod) {
                state.paymentMethod = 'contrarembolso';
            }
            const paymentMethodDefault = state.paymentMethod || (isRetiro ? 'contrarembolso' : 'mercadopago');
            logger.info(`[MANUAL-COMPLETE] ${chatId} envío=${isRetiro ? 'sucursal' : 'domicilio'} pago=${paymentMethodDefault} (shippingTypeReq=${shippingTypeReq || 'auto'})`);

            // GATE: no creamos órdenes incompletas. Domicilio exige
            // nombre+calle+ciudad; retiro en sucursal exige nombre+ciudad+CP (la
            // calle no aplica). En modo preview NO bloqueamos: el modal de
            // verificación se abre igual con lo que se haya podido extraer.
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

            // El admin puede elegir producto+plan a mano desde el modal cuando el
            // bot no los detectó. En ese caso el precio sale de la lista oficial.
            const productTypeReq = req.body?.productType; // 'Cápsulas' | 'Gotas' | 'Semillas'
            const planReq = req.body?.plan;               // '60' | '120'

            const plan = planReq || state.selectedPlan || cart[0]?.plan || rescuedPlan || '60';
            // Prefer state.totalPrice (refleja el último cambio de plan).
            // Fall back to recalculating from cart only if totalPrice is missing.
            let total;
            if (productTypeReq) {
                const { _getPrice } = require('../../flows/utils/pricing');
                total = parseInt(String(_getPrice(productTypeReq, plan)).replace(/\./g, ''), 10) || 0;
            } else if (state.totalPrice) {
                total = parseInt(state.totalPrice.toString().replace(/\./g, '').replace(/[^\d]/g, '')) || 0;
            } else if (rescuedTotal) {
                total = rescuedTotal;
            } else {
                total = cart.reduce((sum, i) => sum + parseInt((i.price || '0').toString().replace(/\D/g, '')), 0);
            }

            // Descuento manual del admin: resta al total final. (El bot nunca
            // descuenta solo; esto es una acción manual desde el panel.)
            const discountReq = Math.max(0, parseInt(String(req.body?.discount || '0').replace(/[^\d]/g, ''), 10) || 0);
            if (discountReq > 0) {
                total = Math.max(0, total - discountReq);
                logger.info(`[MANUAL-COMPLETE] Descuento manual para ${chatId}: -$${discountReq} → total $${total}`);
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

            const rawProduct = productTypeReq || cart.map(i => i.product).join(' + ') || state.selectedProduct || rescuedProduct || 'Producto';
            const rawPlan = productTypeReq ? `${plan} días` : (cart.map(i => `${i.plan} días`).join(' + ') || `${plan} días`);
            const product = normalizeProductName(rawProduct, rawPlan, total);

            // PREVIEW: el panel SIEMPRE abre el modal de verificación antes de
            // confirmar (con mensaje o sin). Devolvemos lo detectado (datos + envío
            // + pago + producto) SIN crear la orden. La orden se crea recién cuando
            // el admin confirma el modal (request sin preview, con manualAddr +
            // shippingType + paymentMethod).
            if (preview) {
                const { _getPrices } = require('../../flows/utils/pricing');
                const productDetected = /Cápsulas|Gotas|Semillas/.test(product);
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
                        productDetected,
                        prices: _getPrices(),
                    }
                });
            }

            // phoneNumeric y prisma ya se declararon al inicio del handler (ver notas arriba).

            const seller = sellerClient?.info?.wid?.user || null;

            // Atomic transaction: upsert user + find/create order to prevent duplicates
            const order = await prisma.$transaction(async (tx) => {
                await tx.user.upsert({
                    where: { phone_instanceId: { phone: phoneNumeric, instanceId: INSTANCE_ID } },
                    update: { name: addr.nombre || null },
                    create: { phone: phoneNumeric, instanceId: INSTANCE_ID, name: addr.nombre || null }
                });

                // Idempotencia: si el admin doble-clickeo "Manual Complete" en pocos segundos,
                // ya hay un Confirmado fresco para este telefono. Devolvelo sin crear duplicado
                // (no se crea otra orden, asi nunca aparece ruido en el panel).
                const recentConfirmed = await tx.order.findFirst({
                    where: {
                        userPhone: phoneNumeric,
                        status: { in: ['Confirmado', 'Pendiente'] },
                        instanceId: INSTANCE_ID,
                        createdAt: { gte: new Date(Date.now() - 60 * 1000) }
                    },
                    orderBy: { createdAt: 'desc' }
                });
                if (recentConfirmed) {
                    logger.info(`[MANUAL-COMPLETE] Duplicate click detected — returning existing order ${recentConfirmed.id} (created ${Math.round((Date.now() - recentConfirmed.createdAt.getTime()) / 1000)}s ago, status=${recentConfirmed.status})`);
                    return recentConfirmed;
                }

                const existingOrder = await tx.order.findFirst({
                    where: { userPhone: phoneNumeric, status: 'Pendiente', instanceId: INSTANCE_ID },
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
                            paymentVerifiedAt: paymentVerifiedReq ? new Date() : null,
                            ...stateSena,
                        }
                    });
                }
            });



            // Set user state to completed
            if (state) {
                _setStep(state, 'completed');
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
                senaAmount: order.senaAmount || null,
                senaPaid: !!order.senaPaid,
                cashRemainder: order.cashRemainder || null,
                paymentVerifiedAt: order.paymentVerifiedAt ? order.paymentVerifiedAt.toISOString() : null,
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
