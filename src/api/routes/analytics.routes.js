const express = require('express');
const logger = require('../../utils/logger');
const { prisma } = require('../../../db');
const { toZonedTime } = require('date-fns-tz');

const AR_TZ = 'America/Argentina/Buenos_Aires';

module.exports = (clientPool) => {
    const router = express.Router();
    const { withSeller, getInstanceId } = require('./routeHelpers');

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
    router.get('/analytics/overview', ...withSeller(clientPool), async (req, res) => {
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
    router.get('/analytics/products', ...withSeller(clientPool), async (req, res) => {
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
    router.get('/analytics/demographics', ...withSeller(clientPool), async (req, res) => {
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

    // GET /analytics/funnel - Step-by-step funnel snapshot from DailyStats
    router.get('/analytics/funnel', ...withSeller(clientPool), async (req, res) => {
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
    router.get('/analytics/ad-performance', ...withSeller(clientPool), async (req, res) => {
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

    return router;
};
