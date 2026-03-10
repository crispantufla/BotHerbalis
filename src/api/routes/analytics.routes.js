const express = require('express');
const { authMiddleware } = require('../../middleware/auth');
const logger = require('../../utils/logger');
const { prisma } = require('../../../db');

module.exports = (client, sharedState) => {
    const router = express.Router();

    // Helper: Get date objects for current and previous periods
    const getPeriods = (days) => {
        const now = new Date();

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
    router.get('/analytics/overview', authMiddleware, async (req, res) => {
        try {
            const days = parseInt(req.query.days) || 30;
            const instanceFilter = req.query.instance; // e.g. "current" or "all"
            const instanceId = req.query.instanceId || process.env.INSTANCE_ID || 'default';
            const { currentStart, previousStart, previousEnd } = getPeriods(days);

            const baseWhere = { status: { not: 'Cancelado' } };
            if (instanceFilter === 'current') {
                baseWhere.instanceId = instanceId;
            }

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
    router.get('/analytics/products', authMiddleware, async (req, res) => {
        try {
            const days = parseInt(req.query.days) || 30;
            const instanceFilter = req.query.instance;
            const instanceId = req.query.instanceId || process.env.INSTANCE_ID || 'default';
            const { currentStart } = getPeriods(days);

            const baseWhere = { status: { not: 'Cancelado' } };
            if (instanceFilter === 'current') {
                baseWhere.instanceId = instanceId;
            }

            const orders = await prisma.order.findMany({
                where: { ...baseWhere, createdAt: { gte: currentStart } },
                select: { products: true }
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
    router.get('/analytics/demographics', authMiddleware, async (req, res) => {
        try {
            const days = parseInt(req.query.days) || 30;
            const instanceFilter = req.query.instance;
            const instanceId = req.query.instanceId || process.env.INSTANCE_ID || 'default';
            const { currentStart } = getPeriods(days);

            const baseWhere = { status: { not: 'Cancelado' } };
            const baseUserWhere = {}; // Users table has no 'status' field

            if (instanceFilter === 'current') {
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
                    provincia: { not: null, not: '' }
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
                select: { createdAt: true }
            });

            // Daily new chats
            const users = await prisma.user.findMany({
                where: { ...baseUserWhere, createdAt: { gte: currentStart } },
                select: { createdAt: true }
            });

            const hourCounts = new Array(24).fill(0);
            orders.forEach(o => {
                // Adjust for Argentina timezone roughly (UTC-3)
                let hour = o.createdAt.getUTCHours() - 3;
                if (hour < 0) hour += 24;
                hourCounts[hour]++;
            });

            const heatmap = hourCounts.map((count, hour) => ({
                hour: `${hour.toString().padStart(2, '0')}:00`,
                count
            }));

            // Structure daily chats and daily orders into an array
            const dailyChatsMap = {};
            users.forEach(u => {
                // Approximate Argentina time
                const d = new Date(u.createdAt.getTime() - (3 * 60 * 60 * 1000));
                const dateRaw = d.toISOString().split('T')[0];
                dailyChatsMap[dateRaw] = (dailyChatsMap[dateRaw] || 0) + 1;
            });

            const dailyOrdersMap = {};
            orders.forEach(o => {
                // Approximate Argentina time
                const d = new Date(o.createdAt.getTime() - (3 * 60 * 60 * 1000));
                const dateRaw = d.toISOString().split('T')[0];
                dailyOrdersMap[dateRaw] = (dailyOrdersMap[dateRaw] || 0) + 1;
            });

            const dailyChats = [];
            let currentDate = new Date(currentStart);
            const now = new Date();
            while (currentDate <= now) {
                const ds = new Date(currentDate.getTime() - (3 * 60 * 60 * 1000)).toISOString().split('T')[0];

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

    // GET /analytics/funnel - Step-by-step funnel snapshot from DailyStats
    router.get('/analytics/funnel', authMiddleware, async (req, res) => {
        try {
            const days = parseInt(req.query.days) || 7;
            const instanceId = req.query.instanceId || process.env.INSTANCE_ID || 'default';
            const since = new Date();
            since.setDate(since.getDate() - days);
            since.setHours(0, 0, 0, 0);

            const snapshots = await prisma.dailyStats.findMany({
                where: { instanceId, date: { gte: since }, stepCounts: { not: null } },
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
            if (sharedState?.userState) {
                for (const state of Object.values(sharedState.userState)) {
                    if (state.step) liveStepCounts[state.step] = (liveStepCounts[state.step] || 0) + 1;
                }
            }

            res.json({ period: snapshots.map(s => ({ date: s.date, stepCounts: JSON.parse(s.stepCounts || '{}') })), aggregated, live: liveStepCounts });
        } catch (e) {
            logger.error("🔴 [ANALYTICS] Error in /funnel:", e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};
