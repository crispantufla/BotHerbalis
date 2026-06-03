// READ-ONLY: conversión de Horacio por día/semana desde DailyStats + Orders.
// Uso: node scripts/analyze-horacio-conversion.js
// Borrar tras usar — es un script de análisis ad-hoc.
require('dotenv').config();
const { prisma, pool } = require('../db');

async function main() {
    // 1) Resolver sellerId de Horacio
    const accounts = await prisma.account.findMany({
        where: { name: { contains: 'horac', mode: 'insensitive' } },
        select: { name: true, sellerId: true, isActive: true, createdAt: true }
    });
    console.log('=== Cuentas que matchean "horac" ===');
    console.table(accounts.map(a => ({ name: a.name, sellerId: a.sellerId, active: a.isActive })));

    const horacio = accounts.find(a => a.sellerId);
    if (!horacio) { console.log('No encontré sellerId de Horacio.'); return; }
    const sid = horacio.sellerId;
    console.log(`\n>>> Usando sellerId = "${sid}" (${horacio.name})\n`);

    // 2) DailyStats por día (conversión = completedOrders / totalChats)
    const daily = await prisma.dailyStats.findMany({
        where: { instanceId: sid },
        orderBy: { date: 'asc' },
        select: { date: true, totalChats: true, completedOrders: true, totalRevenue: true }
    });
    console.log(`=== DailyStats: ${daily.length} días registrados ===`);
    if (daily.length) {
        const first = daily[0].date, last = daily[daily.length - 1].date;
        console.log(`Rango: ${first.toISOString().slice(0,10)} → ${last.toISOString().slice(0,10)}\n`);
    }

    // 3) Agregar por SEMANA ISO para suavizar ruido diario
    const byWeek = new Map();
    for (const d of daily) {
        const dt = new Date(d.date);
        // semana = lunes de esa semana
        const day = (dt.getUTCDay() + 6) % 7; // 0 = lunes
        const monday = new Date(dt); monday.setUTCDate(dt.getUTCDate() - day);
        const key = monday.toISOString().slice(0, 10);
        const w = byWeek.get(key) || { week: key, chats: 0, orders: 0, revenue: 0, days: 0 };
        w.chats += d.totalChats || 0;
        w.orders += d.completedOrders || 0;
        w.revenue += d.totalRevenue || 0;
        w.days += 1;
        byWeek.set(key, w);
    }
    const weeks = [...byWeek.values()].map(w => ({
        semana: w.week,
        dias: w.days,
        chats: w.chats,
        ordenes: w.orders,
        conv_pct: w.chats > 0 ? +(100 * w.orders / w.chats).toFixed(2) : 0,
        revenue: Math.round(w.revenue)
    }));
    console.log('=== Conversión por SEMANA (DailyStats) ===');
    console.table(weeks);

    // 4) Pico de conversión (semanas con ≥ 30 chats para evitar ruido de muestras chicas)
    const solid = weeks.filter(w => w.chats >= 30).sort((a, b) => b.conv_pct - a.conv_pct);
    console.log('\n=== TOP 5 semanas por conversión (≥30 chats) ===');
    console.table(solid.slice(0, 5));

    // 5) Cross-check con Orders reales confirmados por semana (status no-cancelado)
    const orders = await prisma.order.findMany({
        where: { instanceId: sid },
        select: { createdAt: true, status: true, totalPrice: true }
    });
    const okStatuses = /confirm|envi|complet|entreg|pag/i;
    const ordersByWeek = new Map();
    for (const o of orders) {
        const dt = new Date(o.createdAt);
        const day = (dt.getUTCDay() + 6) % 7;
        const monday = new Date(dt); monday.setUTCDate(dt.getUTCDate() - day);
        const key = monday.toISOString().slice(0, 10);
        const w = ordersByWeek.get(key) || { semana: key, total: 0, confirmados: 0 };
        w.total += 1;
        if (okStatuses.test(o.status)) w.confirmados += 1;
        ordersByWeek.set(key, w);
    }
    console.log('\n=== Orders reales por semana (cross-check) ===');
    console.table([...ordersByWeek.values()].sort((a,b)=>a.semana.localeCompare(b.semana)));
    console.log(`\nTotal orders: ${orders.length}. Estados distintos:`, [...new Set(orders.map(o=>o.status))]);
}

main()
    .catch(e => console.error('ERROR:', e))
    .finally(async () => { await prisma.$disconnect(); await pool.end(); });
