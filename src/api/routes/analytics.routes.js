const express = require('express');
const logger = require('../../utils/logger');
const { prisma } = require('../../../db');
const { toZonedTime } = require('date-fns-tz');

const AR_TZ = 'America/Argentina/Buenos_Aires';

module.exports = (clientPool) => {
    const router = express.Router();
    const { withSeller, getInstanceId } = require('./routeHelpers');
    const { jwtOrApiToken } = require('../../middleware/apiTokenAuth');
    const { sellerContext } = require('../../middleware/sellerContext');

    // Analytics endpoints accept either a regular session JWT or an API token
    // with the "analytics:read" scope. Lets external tools (e.g. another Claude
    // Code instance) read aggregated metrics without needing a user account.
    const withAnalyticsAuth = (pool) => [jwtOrApiToken('analytics:read'), sellerContext(pool)];

    // Helper: Get date objects for current and previous periods
    const getPeriods = (days) => {
        const now = new Date();
        days = Math.min(days, 365); // Cap at 1 year to prevent full-table scans

        const currentStart = new Date();
        currentStart.setDate(now.getDate() - days);
        currentStart.setHours(0, 0, 0, 0);

        const previousStart = new Date(currentStart);
        previousStart.setDate(currentStart.getDate() - days);

        const previousEnd = new Date(currentStart);
        previousEnd.setMilliseconds(-1);

        return { currentStart, previousStart, previousEnd, now };
    };

    // Calculate percentage growth
    const calculateGrowth = (current, previous) => {
        if (previous === 0) return current > 0 ? 100 : 0;
        return Math.round(((current - previous) / previous) * 100);
    };

    // GET /analytics/overview - High-level financial metrics and performance
    router.get('/analytics/overview', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const days = parseInt(req.query.days) || 30;
            const instanceId = getInstanceId(req);
            const { currentStart, previousStart, previousEnd } = getPeriods(days);

            const baseWhere = { status: { not: 'Cancelado' } };
            if (instanceId) baseWhere.instanceId = instanceId;

            // Fetch current period data
            const currentAgg = await prisma.order.aggregate({
                _count: { id: true },
                _sum: { totalPrice: true },
                where: { ...baseWhere, createdAt: { gte: currentStart } }
            });

            // Fetch previous period data
            const previousAgg = await prisma.order.aggregate({
                _count: { id: true },
                _sum: { totalPrice: true },
                where: { ...baseWhere, createdAt: { gte: previousStart, lte: previousEnd } }
            });

            const currentRevenue = currentAgg._sum.totalPrice || 0;
            const previousRevenue = previousAgg._sum.totalPrice || 0;
            const currentOrders = currentAgg._count.id;
            const previousOrders = previousAgg._count.id;

            const currentAOV = currentOrders > 0 ? Math.round(currentRevenue / currentOrders) : 0;
            const previousAOV = previousOrders > 0 ? Math.round(previousRevenue / previousOrders) : 0;

            res.json({
                revenue: {
                    value: currentRevenue,
                    growth: calculateGrowth(currentRevenue, previousRevenue)
                },
                orders: {
                    value: currentOrders,
                    growth: calculateGrowth(currentOrders, previousOrders)
                },
                aov: {
                    value: currentAOV,
                    growth: calculateGrowth(currentAOV, previousAOV)
                }
            });

        } catch (e) {
            logger.error("🔴 [ANALYTICS] Error in /overview:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /analytics/products - Product Popularity and Duration metrics
    router.get('/analytics/products', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const days = parseInt(req.query.days) || 30;
            const instanceId = getInstanceId(req);
            const { currentStart } = getPeriods(days);

            const baseWhere = { status: { not: 'Cancelado' } };
            if (instanceId) baseWhere.instanceId = instanceId;

            const orders = await prisma.order.findMany({
                where: { ...baseWhere, createdAt: { gte: currentStart } },
                select: { products: true },
                take: 10000 // Safety limit to prevent unbounded memory usage
            });

            const popularity = {
                capsulas: 0,
                gotas: 0,
                combos: 0,
                semillas: 0
            };

            const duration = {
                '30 días': 0,
                '60 días': 0,
                '90 días': 0,
                '120 días': 0,
                'desconocido': 0
            };

            orders.forEach(order => {
                const prodStr = (order.products || '').toLowerCase();

                // Popularity
                if (prodStr.includes('combo') || (prodStr.includes('capsul') && prodStr.includes('gota'))) {
                    popularity.combos++;
                } else if (prodStr.includes('capsul') || prodStr.includes('cápsul')) {
                    popularity.capsulas++;
                } else if (prodStr.includes('gota')) {
                    popularity.gotas++;
                } else {
                    popularity.semillas++;
                }

                // Duration
                if (prodStr.includes('30 d') || prodStr.includes('1 mes') || prodStr.includes('1 f') || prodStr.includes('1 u')) {
                    duration['30 días']++;
                } else if (prodStr.includes('60 d') || prodStr.includes('2 mes') || prodStr.includes('2 f') || prodStr.includes('2 u')) {
                    duration['60 días']++;
                } else if (prodStr.includes('90 d') || prodStr.includes('3 mes') || prodStr.includes('3 f') || prodStr.includes('3 u')) {
                    duration['90 días']++;
                } else if (prodStr.includes('120 d') || prodStr.includes('4 mes') || prodStr.includes('4 f') || prodStr.includes('4 u')) {
                    duration['120 días']++;
                } else {
                    if (/\b30\b/.test(prodStr)) duration['30 días']++;
                    else if (/\b60\b/.test(prodStr)) duration['60 días']++;
                    else if (/\b90\b/.test(prodStr)) duration['90 días']++;
                    else if (/\b120\b/.test(prodStr)) duration['120 días']++;
                    else duration['desconocido']++;
                }
            });

            // Format for Recharts Pie
            const formatForPie = (obj) => {
                return Object.entries(obj)
                    .filter(([_, count]) => count > 0)
                    .map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value }));
            };

            res.json({
                popularity: formatForPie(popularity),
                duration: formatForPie(duration)
            });

        } catch (e) {
            logger.error("🔴 [ANALYTICS] Error in /products:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /analytics/demographics - Heatmap/Geography data
    router.get('/analytics/demographics', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const days = parseInt(req.query.days) || 30;
            const instanceId = getInstanceId(req);
            const { currentStart } = getPeriods(days);

            const baseWhere = { status: { not: 'Cancelado' } };
            const baseUserWhere = {};

            if (instanceId) {
                baseWhere.instanceId = instanceId;
                baseUserWhere.instanceId = instanceId;
            }

            // Top provinces
            const provinces = await prisma.order.groupBy({
                by: ['provincia'],
                _count: { id: true },
                _sum: { totalPrice: true },
                where: {
                    ...baseWhere,
                    createdAt: { gte: currentStart },
                    provincia: { not: null, notIn: [''] }
                },
                orderBy: { _count: { id: 'desc' } },
                take: 10
            });

            const formattedProvinces = provinces.map(p => ({
                name: p.provincia,
                orders: p._count.id,
                revenue: p._sum.totalPrice || 0
            }));

            // Heatmap: Orders by Hour of Day
            const orders = await prisma.order.findMany({
                where: { ...baseWhere, createdAt: { gte: currentStart } },
                select: { createdAt: true },
                take: 10000 // Safety limit
            });

            // Daily new chats
            const users = await prisma.user.findMany({
                where: { ...baseUserWhere, createdAt: { gte: currentStart } },
                select: { createdAt: true },
                take: 10000 // Safety limit
            });

            const hourCounts = new Array(24).fill(0);
            orders.forEach(o => {
                const arDate = toZonedTime(o.createdAt, AR_TZ);
                hourCounts[arDate.getHours()]++;
            });

            const heatmap = hourCounts.map((count, hour) => ({
                hour: `${hour.toString().padStart(2, '0')}:00`,
                count
            }));

            // Structure daily chats and daily orders into an array
            const dailyChatsMap = {};
            users.forEach(u => {
                const arDate = toZonedTime(u.createdAt, AR_TZ);
                const dateRaw = arDate.toISOString().split('T')[0];
                dailyChatsMap[dateRaw] = (dailyChatsMap[dateRaw] || 0) + 1;
            });

            const dailyOrdersMap = {};
            orders.forEach(o => {
                const arDate = toZonedTime(o.createdAt, AR_TZ);
                const dateRaw = arDate.toISOString().split('T')[0];
                dailyOrdersMap[dateRaw] = (dailyOrdersMap[dateRaw] || 0) + 1;
            });

            const dailyChats = [];
            let currentDate = new Date(currentStart);
            const now = new Date();
            while (currentDate <= now) {
                const ds = toZonedTime(currentDate, AR_TZ).toISOString().split('T')[0];

                const chatsCount = dailyChatsMap[ds] || 0;
                const ordersCount = dailyOrdersMap[ds] || 0;
                const conversionRate = chatsCount > 0 ? ((ordersCount / chatsCount) * 100).toFixed(1) : 0;

                dailyChats.push({
                    date: ds,
                    chats: chatsCount,
                    orders: ordersCount,
                    rate: parseFloat(conversionRate)
                });
                currentDate.setDate(currentDate.getDate() + 1);
            }

            res.json({
                provinces: formattedProvinces,
                heatmap,
                dailyChats
            });

        } catch (e) {
            logger.error("🔴 [ANALYTICS] Error in /demographics:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /analytics/funnel-snapshot - Step-by-step funnel snapshot from DailyStats.
    // Renombrado de /analytics/funnel para no colisionar con el endpoint nuevo
    // basado en FunnelEvent (que es el que consume FunnelAnalyticsView.jsx).
    router.get('/analytics/funnel-snapshot', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const days = parseInt(req.query.days) || 7;
            const instanceId = getInstanceId(req);
            const since = new Date();
            since.setDate(since.getDate() - days);
            since.setHours(0, 0, 0, 0);

            const whereBase = instanceId ? { instanceId } : {};

            const snapshots = await prisma.dailyStats.findMany({
                where: { ...whereBase, date: { gte: since }, stepCounts: { not: null } },
                select: { date: true, stepCounts: true },
                orderBy: { date: 'asc' }
            });

            // Aggregate step counts across the period
            const aggregated = {};
            for (const snap of snapshots) {
                try {
                    const counts = JSON.parse(snap.stepCounts);
                    for (const [step, count] of Object.entries(counts)) {
                        aggregated[step] = (aggregated[step] || 0) + count;
                    }
                } catch {}
            }

            // Also include live snapshot from current in-memory state
            const liveStepCounts = {};
            const ss = req.sellerInstance?.sharedState;
            if (ss?.userState) {
                for (const state of Object.values(ss.userState)) {
                    if (state.step) liveStepCounts[state.step] = (liveStepCounts[state.step] || 0) + 1;
                }
            }

            res.json({
                period: snapshots.map(s => {
                    let stepCounts = {};
                    try { stepCounts = JSON.parse(s.stepCounts || '{}'); } catch {}
                    return { date: s.date, stepCounts };
                }),
                aggregated,
                live: liveStepCounts
            });
        } catch (e) {
            logger.error("🔴 [ANALYTICS] Error in /funnel:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /analytics/ad-performance - Funnel breakdown by ad source
    router.get('/analytics/ad-performance', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const days = parseInt(req.query.days) || 30;
            const instanceId = getInstanceId(req);
            const since = new Date();
            since.setDate(since.getDate() - days);
            since.setHours(0, 0, 0, 0);

            const whereBase = instanceId ? { instanceId } : {};

            // Fetch users with profileData to extract adSource
            const users = await prisma.user.findMany({
                where: { ...whereBase, createdAt: { gte: since } },
                select: { phone: true, profileData: true, createdAt: true }
            });

            // Fetch orders in the same period
            const orders = await prisma.order.findMany({
                where: { ...whereBase, createdAt: { gte: since }, status: { not: 'Cancelado' } },
                select: { userPhone: true, totalPrice: true, createdAt: true }
            });
            const ordersByPhone = {};
            orders.forEach(o => {
                if (!ordersByPhone[o.userPhone]) ordersByPhone[o.userPhone] = [];
                ordersByPhone[o.userPhone].push(o);
            });

            // Define funnel steps in order
            const FUNNEL_STEPS = [
                'greeting', 'waiting_weight', 'waiting_preference',
                'waiting_plan_choice', 'waiting_ok', 'waiting_data',
                'waiting_final_confirmation', 'waiting_admin_ok', 'completed'
            ];

            // Aggregate by adSource
            const adStats = {}; // { [adSource]: { total, steps: {}, orders, revenue, daily: {} } }

            for (const user of users) {
                let adSource = null;
                let currentStep = null;

                try {
                    const data = JSON.parse(user.profileData || '{}');
                    adSource = data.adSource || null;
                    currentStep = data.step || null;
                } catch {}

                const key = adSource || 'orgánico';
                if (!adStats[key]) {
                    adStats[key] = { total: 0, steps: {}, orders: 0, revenue: 0, daily: {} };
                }

                adStats[key].total++;

                // Count which step each user reached (at minimum)
                if (currentStep) {
                    const reachedIdx = FUNNEL_STEPS.indexOf(currentStep);
                    // If user is at step X, they passed through all previous steps
                    for (let i = 0; i <= Math.max(reachedIdx, 0); i++) {
                        const s = FUNNEL_STEPS[i];
                        adStats[key].steps[s] = (adStats[key].steps[s] || 0) + 1;
                    }
                    // Also count the current step if it's not in the standard list
                    if (reachedIdx < 0) {
                        adStats[key].steps[currentStep] = (adStats[key].steps[currentStep] || 0) + 1;
                    }
                }

                // Count orders for this user
                const userOrders = ordersByPhone[user.phone] || [];
                if (userOrders.length > 0) {
                    adStats[key].orders += userOrders.length;
                    adStats[key].revenue += userOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
                }

                // Daily breakdown
                const arDate = toZonedTime(user.createdAt, AR_TZ);
                const dateStr = arDate.toISOString().split('T')[0];
                if (!adStats[key].daily[dateStr]) adStats[key].daily[dateStr] = { chats: 0, orders: 0 };
                adStats[key].daily[dateStr].chats++;
                if (userOrders.length > 0) {
                    adStats[key].daily[dateStr].orders += userOrders.length;
                }
            }

            // Format output
            const result = Object.entries(adStats).map(([source, stats]) => ({
                source,
                total: stats.total,
                orders: stats.orders,
                revenue: Math.round(stats.revenue),
                conversionRate: stats.total > 0 ? parseFloat(((stats.orders / stats.total) * 100).toFixed(1)) : 0,
                funnel: FUNNEL_STEPS.map(step => ({
                    step,
                    count: stats.steps[step] || 0,
                    rate: stats.total > 0 ? parseFloat(((( stats.steps[step] || 0) / stats.total) * 100).toFixed(1)) : 0
                })),
                daily: Object.entries(stats.daily)
                    .map(([date, d]) => ({ date, chats: d.chats, orders: d.orders, rate: d.chats > 0 ? parseFloat(((d.orders / d.chats) * 100).toFixed(1)) : 0 }))
                    .sort((a, b) => a.date.localeCompare(b.date))
            }));

            res.json(result);
        } catch (e) {
            logger.error("🔴 [ANALYTICS] Error in /ad-performance:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // ════════════════════════════════════════════════════════════════
    // FUNNEL ANALYTICS — se alimenta de FunnelEvent
    // ════════════════════════════════════════════════════════════════

    // Helper común: rango [from, to) a partir de query params.
    // Default: últimos 7 días, AR timezone.
    function parseDateRange(req) {
        const now = new Date();
        const to = req.query.to ? new Date(req.query.to) : now;
        const daysBack = Math.min(parseInt(req.query.days) || 7, 365);
        const from = req.query.from
            ? new Date(req.query.from)
            : new Date(now.getTime() - daysBack * 24 * 3600 * 1000);
        return { from, to };
    }

    // GET /analytics/funnel — métricas 1 (drop-off por step)
    router.get('/analytics/funnel', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const { from, to } = parseDateRange(req);
            const instanceId = getInstanceId(req);
            const where = { enteredAt: { gte: from, lte: to } };
            if (instanceId) where.sellerId = instanceId;

            const events = await prisma.funnelEvent.findMany({
                where,
                select: { stepTo: true, exitType: true, enteredAt: true, exitedAt: true },
            });

            // Agregar por stepTo
            const byStep = new Map();
            for (const e of events) {
                const s = e.stepTo;
                if (!byStep.has(s)) {
                    byStep.set(s, { step: s, entered: 0, advanced: 0, back: 0, paused: 0, dropped: 0, completed: 0, open: 0, durations: [] });
                }
                const g = byStep.get(s);
                g.entered++;
                if (!e.exitType) g.open++;
                else g[e.exitType] = (g[e.exitType] || 0) + 1;
                if (e.exitedAt && e.enteredAt) {
                    g.durations.push((new Date(e.exitedAt).getTime() - new Date(e.enteredAt).getTime()) / 1000);
                }
            }

            const median = (arr) => {
                if (!arr.length) return 0;
                const sorted = [...arr].sort((a, b) => a - b);
                return Math.round(sorted[Math.floor(sorted.length / 2)]);
            };
            const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

            const result = Array.from(byStep.values()).map(g => ({
                step: g.step,
                entered: g.entered,
                advanced: g.advanced || 0,
                back: g.back || 0,
                paused: g.paused || 0,
                dropped: g.dropped || 0,
                completed: g.completed || 0,
                stillOpen: g.open,
                dropRate: g.entered ? parseFloat((((g.paused + g.dropped) / g.entered) * 100).toFixed(1)) : 0,
                medianTimeSec: median(g.durations),
                avgTimeSec: avg(g.durations),
            }));

            res.json({ from, to, steps: result });
        } catch (e) {
            logger.error('🔴 [ANALYTICS] funnel:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /analytics/pause-alerts — métrica 3
    router.get('/analytics/pause-alerts', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const { from, to } = parseDateRange(req);
            const instanceId = getInstanceId(req);
            const where = { exitType: 'paused', exitedAt: { gte: from, lte: to } };
            if (instanceId) where.sellerId = instanceId;

            const rows = await prisma.funnelEvent.groupBy({
                by: ['stepTo'],
                where,
                _count: { _all: true },
            });

            res.json({
                from, to,
                byStep: rows.map(r => ({ step: r.stepTo, count: r._count._all })).sort((a, b) => b.count - a.count),
            });
        } catch (e) {
            logger.error('🔴 [ANALYTICS] pause-alerts:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /analytics/time-to-close — métrica 5
    // Para cada (sellerId, phone) que alcanzó 'completed' en el rango: sum
    // de duraciones de todos sus FunnelEvents ≤ el de 'completed'.
    router.get('/analytics/time-to-close', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const { from, to } = parseDateRange(req);
            const instanceId = getInstanceId(req);

            const completedWhere = { stepTo: 'completed', enteredAt: { gte: from, lte: to } };
            if (instanceId) completedWhere.sellerId = instanceId;
            const completions = await prisma.funnelEvent.findMany({
                where: completedWhere,
                select: { sellerId: true, phone: true, enteredAt: true },
            });

            // Antes acá había una query por completion (N+1). Ahora hacemos UNA
            // sola query por todos los (sellerId, phone) involucrados, agrupada
            // por (seller, phone) con min(enteredAt) — el primer evento del cliente.
            const phoneKeys = completions.map(c => ({ sellerId: c.sellerId, phone: c.phone }));
            const firstEvents = phoneKeys.length === 0 ? [] : await prisma.funnelEvent.groupBy({
                by: ['sellerId', 'phone'],
                where: {
                    OR: phoneKeys.map(k => ({ sellerId: k.sellerId, phone: k.phone })),
                },
                _min: { enteredAt: true },
            });
            const firstByKey = new Map();
            for (const f of firstEvents) {
                firstByKey.set(`${f.sellerId}|${f.phone}`, f._min.enteredAt);
            }

            const durations = [];
            for (const c of completions) {
                const firstAt = firstByKey.get(`${c.sellerId}|${c.phone}`);
                if (firstAt) {
                    const sec = (new Date(c.enteredAt).getTime() - new Date(firstAt).getTime()) / 1000;
                    if (sec > 0) durations.push(sec);
                }
            }
            durations.sort((a, b) => a - b);
            const pct = (p) => durations.length ? Math.round(durations[Math.floor(durations.length * p)]) : 0;

            // Histograma por bucket (0-5min, 5-15m, 15-60m, 1-4h, 4-24h, >24h)
            const buckets = [
                { label: '< 5m', max: 5 * 60, count: 0 },
                { label: '5-15m', max: 15 * 60, count: 0 },
                { label: '15-60m', max: 60 * 60, count: 0 },
                { label: '1-4h', max: 4 * 3600, count: 0 },
                { label: '4-24h', max: 24 * 3600, count: 0 },
                { label: '> 24h', max: Infinity, count: 0 },
            ];
            for (const d of durations) {
                const b = buckets.find(x => d <= x.max);
                if (b) b.count++;
            }

            res.json({
                from, to,
                total: durations.length,
                p50: pct(0.5),
                p90: pct(0.9),
                p99: pct(0.99),
                histogram: buckets,
            });
        } catch (e) {
            logger.error('🔴 [ANALYTICS] time-to-close:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /analytics/retries — métrica 2 (histograma de retryIndex por step)
    // Computa retryIndex al leer (no al escribir) con un scan ordenado y
    // conteo en memoria. Esto ahorra 1 query por cada mensaje del usuario
    // que el bot procesa.
    router.get('/analytics/retries', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const { from, to } = parseDateRange(req);
            const instanceId = getInstanceId(req);
            const where = { at: { gte: from, lte: to } };
            if (instanceId) where.sellerId = instanceId;

            const events = await prisma.messageEvent.findMany({
                where,
                select: { phone: true, step: true },
                orderBy: { at: 'asc' },
            });

            // Para cada (phone, step) en orden temporal, asignar posición:
            // 0 = primer intento, 1 = re-pregunta, etc.
            const positions = new Map();
            const byStep = new Map();
            for (const e of events) {
                const key = `${e.phone}|${e.step}`;
                const pos = positions.get(key) || 0;
                positions.set(key, pos + 1);

                if (!byStep.has(e.step)) {
                    byStep.set(e.step, { step: e.step, b0: 0, b1: 0, b2_3: 0, b4plus: 0, total: 0 });
                }
                const g = byStep.get(e.step);
                g.total++;
                if (pos === 0) g.b0++;
                else if (pos === 1) g.b1++;
                else if (pos <= 3) g.b2_3++;
                else g.b4plus++;
            }

            res.json({
                from, to,
                byStep: Array.from(byStep.values()).map(g => ({
                    ...g,
                    retryRate: g.total > 0 ? parseFloat((((g.total - g.b0) / g.total) * 100).toFixed(1)) : 0,
                })).sort((a, b) => b.retryRate - a.retryRate),
            });
        } catch (e) {
            logger.error('🔴 [ANALYTICS] retries:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /analytics/ai-fallback — métrica 4 (aiCallCount / messageCount por step)
    router.get('/analytics/ai-fallback', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const { from, to } = parseDateRange(req);
            const instanceId = getInstanceId(req);
            const where = { enteredAt: { gte: from, lte: to } };
            if (instanceId) where.sellerId = instanceId;

            const rows = await prisma.funnelEvent.groupBy({
                by: ['stepTo'],
                where,
                _sum: { messageCount: true, aiCallCount: true },
            });

            res.json({
                from, to,
                byStep: rows.map(r => {
                    const msgs = r._sum.messageCount || 0;
                    const aiCalls = r._sum.aiCallCount || 0;
                    return {
                        step: r.stepTo,
                        messageCount: msgs,
                        aiCallCount: aiCalls,
                        aiFallbackRate: msgs > 0 ? parseFloat(((aiCalls / msgs) * 100).toFixed(1)) : 0,
                    };
                }).sort((a, b) => b.aiFallbackRate - a.aiFallbackRate),
            });
        } catch (e) {
            logger.error('🔴 [ANALYTICS] ai-fallback:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /analytics/price-objections — métrica 6
    router.get('/analytics/price-objections', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const { from, to } = parseDateRange(req);
            const instanceId = getInstanceId(req);
            const where = { priceObjection: true, at: { gte: from, lte: to } };
            if (instanceId) where.sellerId = instanceId;

            const rows = await prisma.messageEvent.groupBy({
                by: ['step'],
                where,
                _count: { _all: true },
            });

            // Total de mensajes por step en el mismo rango (para el %)
            const totalWhere = { at: { gte: from, lte: to } };
            if (instanceId) totalWhere.sellerId = instanceId;
            const totalRows = await prisma.messageEvent.groupBy({
                by: ['step'],
                where: totalWhere,
                _count: { _all: true },
            });
            const totalMap = Object.fromEntries(totalRows.map(r => [r.step, r._count._all]));

            res.json({
                from, to,
                byStep: rows.map(r => {
                    const total = totalMap[r.step] || 0;
                    return {
                        step: r.step,
                        objectionCount: r._count._all,
                        totalMessages: total,
                        rate: total > 0 ? parseFloat(((r._count._all / total) * 100).toFixed(1)) : 0,
                    };
                }).sort((a, b) => b.objectionCount - a.objectionCount),
            });
        } catch (e) {
            logger.error('🔴 [ANALYTICS] price-objections:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /analytics/abandonment-by-hour — métrica 7
    // Por cada FunnelEvent con exitType='dropped', tomar la hora (AR) de
    // enteredAt y agrupar 24h.
    router.get('/analytics/abandonment-by-hour', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const { from, to } = parseDateRange(req);
            const instanceId = getInstanceId(req);
            const where = { exitType: 'dropped', exitedAt: { gte: from, lte: to } };
            if (instanceId) where.sellerId = instanceId;

            const events = await prisma.funnelEvent.findMany({
                where,
                select: { enteredAt: true },
            });

            const hourly = Array(24).fill(0);
            for (const e of events) {
                // Convertir UTC → AR (UTC-3, Argentina no tiene DST)
                const arHour = (new Date(e.enteredAt).getUTCHours() - 3 + 24) % 24;
                hourly[arHour]++;
            }

            res.json({
                from, to,
                total: events.length,
                byHour: hourly.map((count, hour) => ({ hour, count })),
            });
        } catch (e) {
            logger.error('🔴 [ANALYTICS] abandonment-by-hour:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /analytics/product-mix — métrica 8
    // Lee Order (no cancelada), parsea producto+plan desde el string "Cápsulas (60 días)".
    router.get('/analytics/product-mix', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const { from, to } = parseDateRange(req);
            const instanceId = getInstanceId(req);
            const where = { createdAt: { gte: from, lte: to }, status: { not: 'Cancelado' } };
            if (instanceId) where.instanceId = instanceId;

            const orders = await prisma.order.findMany({
                where,
                select: { products: true, totalPrice: true, paymentMethod: true },
            });

            const parseProduct = (s) => {
                if (!s) return { product: 'Desconocido', plan: '?' };
                const m = s.match(/^(C[áa]psulas|Gotas|Semillas)\s*\((\d+)\s*d[íi]as?\)/i);
                if (!m) return { product: s, plan: '?' };
                return { product: m[1].replace('á', 'á'), plan: `${m[2]}d` };
            };

            const normPayment = (p) => {
                if (!p) return 'contrarembolso';
                if (p === 'efectivo') return 'contrarembolso';
                return p;
            };

            const agg = new Map();
            for (const o of orders) {
                const { product, plan } = parseProduct(o.products);
                const pay = normPayment(o.paymentMethod);
                const key = `${product}|${plan}|${pay}`;
                if (!agg.has(key)) {
                    agg.set(key, { product, plan, paymentMethod: pay, count: 0, revenue: 0 });
                }
                const g = agg.get(key);
                g.count++;
                g.revenue += o.totalPrice || 0;
            }

            const total = orders.length;
            res.json({
                from, to, total,
                mix: Array.from(agg.values())
                    .map(g => ({
                        ...g,
                        share: total > 0 ? parseFloat(((g.count / total) * 100).toFixed(1)) : 0,
                        avgTicket: g.count > 0 ? Math.round(g.revenue / g.count) : 0,
                    }))
                    .sort((a, b) => b.count - a.count),
            });
        } catch (e) {
            logger.error('🔴 [ANALYTICS] product-mix:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /analytics/cache-hits — métrica 9
    // Suma hits de AiSemanticCache por step y lo cruza con messageCount
    // total del mismo step en el rango. El cache es global (no por seller),
    // así que este endpoint ignora sellerId en la parte de cache.
    router.get('/analytics/cache-hits', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const { from, to } = parseDateRange(req);
            const instanceId = getInstanceId(req);

            // Cache hits: nota que `hits` es acumulativo y no tiene timestamp de cada hit,
            // así que devolvemos el total actual + lastHit para contexto.
            const cacheRows = await prisma.aiSemanticCache.groupBy({
                by: ['step'],
                _sum: { hits: true },
                _count: { _all: true },
            });

            const msgWhere = { at: { gte: from, lte: to } };
            if (instanceId) msgWhere.sellerId = instanceId;
            const msgRows = await prisma.messageEvent.groupBy({
                by: ['step'],
                where: msgWhere,
                _count: { _all: true },
            });
            const msgMap = Object.fromEntries(msgRows.map(r => [r.step, r._count._all]));

            const allSteps = new Set([
                ...cacheRows.map(r => r.step),
                ...msgRows.map(r => r.step),
            ]);

            const byStep = [...allSteps].map(step => {
                const hits = cacheRows.find(r => r.step === step)?._sum?.hits || 0;
                const cached = cacheRows.find(r => r.step === step)?._count?._all || 0;
                const msgs = msgMap[step] || 0;
                return {
                    step,
                    cachedEntries: cached,
                    totalHits: hits,
                    messagesInRange: msgs,
                    // Es un proxy — el `hits` es histórico (todo el tiempo),
                    // no solo del rango. Se muestra como referencia.
                    avgHitsPerEntry: cached > 0 ? parseFloat((hits / cached).toFixed(2)) : 0,
                };
            }).sort((a, b) => b.totalHits - a.totalHits);

            res.json({ from, to, byStep });
        } catch (e) {
            logger.error('🔴 [ANALYTICS] cache-hits:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /analytics/reentries — métrica 10
    router.get('/analytics/reentries', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const { from, to } = parseDateRange(req);
            const instanceId = getInstanceId(req);
            const where = { exitType: 'back', enteredAt: { gte: from, lte: to } };
            if (instanceId) where.sellerId = instanceId;

            const rows = await prisma.funnelEvent.groupBy({
                by: ['stepFrom', 'stepTo'],
                where,
                _count: { _all: true },
            });
            // El stepFrom/stepTo acá representa "vino de" → "fue a"
            // Pero cerramos con exitType='back' en el row anterior; así que
            // buscamos eventos cuyo propio exitType fue 'back'.
            res.json({
                from, to,
                transitions: rows
                    .map(r => ({ from: r.stepFrom, to: r.stepTo, count: r._count._all }))
                    .sort((a, b) => b.count - a.count),
            });
        } catch (e) {
            logger.error('🔴 [ANALYTICS] reentries:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /analytics/greeting-ab — compara conversión por variante de greeting.
    // Lee profileData.greetingVariant de cada User en el rango y cruza con orders.
    router.get('/analytics/greeting-ab', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const days = Math.min(parseInt(req.query.days) || 14, 90);
            const instanceId = getInstanceId(req);
            const since = new Date();
            since.setDate(since.getDate() - days);
            since.setHours(0, 0, 0, 0);

            const userWhere = { createdAt: { gte: since } };
            if (instanceId) userWhere.instanceId = instanceId;
            const users = await prisma.user.findMany({
                where: userWhere,
                select: { phone: true, profileData: true, createdAt: true },
            });

            const orderWhere = { createdAt: { gte: since }, status: { not: 'Cancelado' } };
            if (instanceId) orderWhere.instanceId = instanceId;
            const orders = await prisma.order.findMany({
                where: orderWhere,
                select: { userPhone: true, totalPrice: true },
            });
            const ordersByPhone = {};
            orders.forEach(o => {
                if (!ordersByPhone[o.userPhone]) ordersByPhone[o.userPhone] = [];
                ordersByPhone[o.userPhone].push(o);
            });

            // Agregar por variante
            const byVariant = {};
            let unassigned = 0;
            for (const u of users) {
                let variant = null;
                let lastStep = null;
                try {
                    const pd = JSON.parse(u.profileData || '{}');
                    variant = pd.greetingVariant || null;
                    lastStep = pd.step || null;
                } catch {}

                if (!variant) {
                    unassigned++;
                    continue;
                }

                if (!byVariant[variant]) {
                    byVariant[variant] = {
                        variant,
                        users: 0,
                        orders: 0,
                        revenue: 0,
                        completedFunnel: 0,
                        avgOrderValue: 0,
                    };
                }
                const g = byVariant[variant];
                g.users++;

                const userOrders = ordersByPhone[u.phone] || [];
                if (userOrders.length > 0) {
                    g.orders += userOrders.length;
                    g.revenue += userOrders.reduce((sum, o) => sum + (o.totalPrice || 0), 0);
                }
                // Solo contamos clientes con step 'completed' como funnel completado.
                // Antes incluíamos 'waiting_admin_validation' (transient — el admin
                // todavía puede rechazar el pedido), inflando la métrica de variantes
                // que llevaban gente al panel de validación incluso si no cerraban.
                if (lastStep === 'completed') {
                    g.completedFunnel++;
                }
            }

            const result = Object.values(byVariant).map(g => ({
                ...g,
                conversionRate: g.users > 0 ? parseFloat(((g.orders / g.users) * 100).toFixed(2)) : 0,
                funnelCompletionRate: g.users > 0 ? parseFloat(((g.completedFunnel / g.users) * 100).toFixed(2)) : 0,
                avgOrderValue: g.orders > 0 ? Math.round(g.revenue / g.orders) : 0,
            })).sort((a, b) => b.conversionRate - a.conversionRate);

            // Significancia estadística básica (test z de proporciones, control = primera variante)
            // Ojo: requiere n>30 por variante para ser confiable.
            let significance = null;
            if (result.length >= 2) {
                const control = result.find(r => r.variant === 'A') || result[result.length - 1];
                const challenger = result[0];
                if (control && challenger && control.variant !== challenger.variant && control.users > 30 && challenger.users > 30) {
                    const p1 = challenger.orders / challenger.users;
                    const p2 = control.orders / control.users;
                    const p = (challenger.orders + control.orders) / (challenger.users + control.users);
                    const se = Math.sqrt(p * (1 - p) * (1 / challenger.users + 1 / control.users));
                    const z = se > 0 ? (p1 - p2) / se : 0;
                    significance = {
                        challenger: challenger.variant,
                        control: control.variant,
                        zScore: parseFloat(z.toFixed(2)),
                        confidenceLevel: Math.abs(z) >= 1.96 ? '95%' : Math.abs(z) >= 1.645 ? '90%' : 'no significativa',
                        liftPct: parseFloat((((p1 - p2) / p2) * 100).toFixed(1)),
                    };
                }
            }

            res.json({
                from: since.toISOString(),
                days,
                totalUsers: users.length,
                unassigned,
                variants: result,
                significance,
            });
        } catch (e) {
            logger.error('🔴 [ANALYTICS] greeting-ab:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // GET /analytics/rescue-queue — leads atascados ordenados por proximidad al cierre.
    // Toma userState en memoria del seller (live), filtra los que están en mid-funnel sin
    // actividad reciente y no pausados. Ranking: step más avanzado primero, luego inactividad.
    router.get('/analytics/rescue-queue', ...withAnalyticsAuth(clientPool), async (req, res) => {
        try {
            const sellerInstance = req.sellerInstance;
            if (!sellerInstance?.sharedState?.userState) {
                return res.json({ leads: [], total: 0 });
            }
            const { userState, pausedUsers } = sellerInstance.sharedState;

            // Step rank: cuanto más cerca de "completed", más alta la prioridad de rescate
            const STEP_RANK = {
                'waiting_admin_validation': 100,
                'waiting_final_confirmation': 90,
                'waiting_maps_confirmation': 80,
                'waiting_data': 70,
                'waiting_transfer_confirmation': 65,
                'waiting_mp_payment': 60,
                'waiting_payment_method': 55,
                'waiting_plan_choice': 40,
                'waiting_ok': 35,
                'waiting_preference': 30,
                'waiting_weight': 20,
            };

            const minMinutesIdle = parseInt(req.query.minMinutesIdle) || 60;
            const maxMinutesIdle = parseInt(req.query.maxMinutesIdle) || 60 * 24 * 7; // 7 días
            const now = Date.now();

            const leads = [];
            for (const [userId, state] of Object.entries(userState)) {
                if (!state || !state.step) continue;
                if (!(state.step in STEP_RANK)) continue;
                if (pausedUsers && pausedUsers.has(userId)) continue;

                const lastActivityRaw = state.lastActivityAt || state.stepEnteredAt;
                if (!lastActivityRaw) continue;
                // Normalizar — puede venir como número (memoria) o ISO string (DB hydrate)
                const lastActivity = typeof lastActivityRaw === 'number'
                    ? lastActivityRaw
                    : new Date(lastActivityRaw).getTime();
                if (!Number.isFinite(lastActivity)) continue;

                const minsIdle = Math.floor((now - lastActivity) / 60000);
                if (minsIdle < minMinutesIdle || minsIdle > maxMinutesIdle) continue;

                leads.push({
                    phone: userId.replace(/@.*/, ''),
                    name: state.userName || state.partialAddress?.nombre || null,
                    step: state.step,
                    stepRank: STEP_RANK[state.step],
                    minutesIdle: minsIdle,
                    selectedProduct: state.selectedProduct || null,
                    selectedPlan: state.selectedPlan || null,
                    weightGoal: state.weightGoal || null,
                    paymentMethod: state.paymentMethod || null,
                    cartTotal: state.totalPrice || null,
                    reengagementSent: !!state.reengagementSent,
                    secondFollowUpSent: !!state.secondFollowUpSent,
                });
            }

            // Orden: stepRank desc (más cerca del cierre primero), luego menos idle (más fresco primero)
            leads.sort((a, b) => b.stepRank - a.stepRank || a.minutesIdle - b.minutesIdle);

            res.json({
                total: leads.length,
                leads: leads.slice(0, 100),
                generatedAt: new Date().toISOString(),
            });
        } catch (e) {
            logger.error('🔴 [ANALYTICS] rescue-queue:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
