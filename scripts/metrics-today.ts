/**
 * Reporte completo de métricas del día (hora Argentina).
 * Uso: DATABASE_URL=<public-url> npx tsx scripts/metrics-today.ts
 */
const { prisma } = require('../db');

function startOfTodayAR(): Date {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Argentina/Buenos_Aires',
        year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const parts = fmt.formatToParts(new Date());
    const y = parts.find(p => p.type === 'year')!.value;
    const m = parts.find(p => p.type === 'month')!.value;
    const d = parts.find(p => p.type === 'day')!.value;
    return new Date(`${y}-${m}-${d}T03:00:00.000Z`);
}

function fmtMoney(n: number): string {
    return '$' + Math.round(n).toLocaleString('es-AR');
}

async function main() {
    const startOfDay = startOfTodayAR();
    const now = new Date();
    console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
    console.log(`║  Métricas — ${now.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })} (ART)`);
    console.log(`║  Ventana: desde ${startOfDay.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })} ART`);
    console.log(`╚══════════════════════════════════════════════════════════════════════╝\n`);

    // ── 1. ÓRDENES (todas, no canceladas, canceladas) ──────────────────────────
    const [allOrders, ordersByStatus, ordersBySeller, ordersByPayment] = await Promise.all([
        prisma.order.findMany({
            where: { createdAt: { gte: startOfDay } },
            select: {
                id: true, instanceId: true, status: true, paymentMethod: true,
                totalPrice: true, createdAt: true, products: true,
                userPhone: true,
            },
            orderBy: { createdAt: 'asc' },
        }),
        prisma.order.groupBy({
            by: ['status'],
            where: { createdAt: { gte: startOfDay } },
            _count: true,
        }),
        prisma.order.groupBy({
            by: ['instanceId'],
            where: { createdAt: { gte: startOfDay } },
            _count: true,
        }),
        prisma.order.groupBy({
            by: ['paymentMethod'],
            where: { createdAt: { gte: startOfDay }, status: { not: 'Cancelado' } },
            _count: true,
        }),
    ]);

    const nonCancelled = allOrders.filter(o => o.status !== 'Cancelado');
    const cancelled = allOrders.filter(o => o.status === 'Cancelado');

    const parsePrice = (p: any) => {
        if (typeof p === 'number') return p;
        if (!p) return 0;
        return parseFloat(String(p).replace(/\./g, '').replace(',', '.')) || 0;
    };
    const totalRevenue = nonCancelled.reduce((sum, o) => sum + parsePrice(o.totalPrice), 0);
    const aov = nonCancelled.length > 0 ? totalRevenue / nonCancelled.length : 0;

    console.log(`📦 ÓRDENES`);
    console.log(`   Total creadas hoy:       ${allOrders.length}`);
    console.log(`   No canceladas (válidas): ${nonCancelled.length}`);
    console.log(`   Canceladas:              ${cancelled.length}`);
    console.log(`   Revenue total (no canc): ${fmtMoney(totalRevenue)}`);
    console.log(`   Ticket promedio (AOV):   ${fmtMoney(aov)}`);
    console.log();
    console.log(`   Por status:`);
    ordersByStatus.forEach(s => console.log(`     ${(s.status || '(null)').padEnd(20)} ${s._count}`));
    console.log();
    console.log(`   Por método de pago (no canceladas):`);
    ordersByPayment.forEach(p => console.log(`     ${(p.paymentMethod || '(no informado)').padEnd(20)} ${p._count}`));
    console.log();
    console.log(`   Por vendedor:`);
    ordersBySeller.forEach(s => console.log(`     ${(s.instanceId || '(null)').padEnd(20)} ${s._count}`));

    // Plan breakdown — extract from products string ("Plan 60" / "Plan 120")
    const planCount: Record<string, number> = {};
    nonCancelled.forEach(o => {
        const m = String(o.products || '').match(/Plan\s*(\d+)/i);
        const plan = m ? `Plan ${m[1]}` : '(sin plan)';
        planCount[plan] = (planCount[plan] || 0) + 1;
    });
    console.log();
    console.log(`   Por plan (no canceladas):`);
    Object.entries(planCount).sort((a, b) => b[1] - a[1]).forEach(([p, c]) => {
        console.log(`     ${p.padEnd(20)} ${c}`);
    });

    // ── 2. USUARIOS NUEVOS ──────────────────────────────────────────────────────
    const [newUsersToday, newUsersBySeller] = await Promise.all([
        prisma.user.count({ where: { createdAt: { gte: startOfDay } } }),
        prisma.user.groupBy({
            by: ['instanceId'],
            where: { createdAt: { gte: startOfDay } },
            _count: true,
        }),
    ]);

    console.log(`\n👥 USUARIOS NUEVOS (chats nuevos hoy)`);
    console.log(`   Total:                   ${newUsersToday}`);
    if (newUsersBySeller.length > 0) {
        console.log(`   Por vendedor:`);
        newUsersBySeller.forEach(u => console.log(`     ${(u.instanceId || '(null)').padEnd(20)} ${u._count}`));
    }

    // ── 3. CONVERSIÓN ───────────────────────────────────────────────────────────
    const conversionRate = newUsersToday > 0
        ? Math.round((nonCancelled.length / newUsersToday) * 1000) / 10
        : 0;
    console.log(`\n📊 CONVERSIÓN`);
    console.log(`   Pedidos hoy / chats nuevos hoy: ${nonCancelled.length} / ${newUsersToday} = ${conversionRate}%`);

    // ── 4. FUNNEL EVENTS (transiciones de step hoy) ─────────────────────────────
    const funnelEvents = await prisma.funnelEvent.groupBy({
        by: ['stepTo'],
        where: { enteredAt: { gte: startOfDay } },
        _count: true,
    });
    if (funnelEvents.length > 0) {
        console.log(`\n🔀 EVENTOS DE FUNNEL (entradas a step)`);
        funnelEvents.sort((a, b) => b._count - a._count).forEach(f => {
            console.log(`     ${(f.stepTo || '(null)').padEnd(35)} ${f._count}`);
        });
    }

    // Drop-off por step (eventos con exitType='dropped')
    const drops = await prisma.funnelEvent.groupBy({
        by: ['stepTo'],
        where: { enteredAt: { gte: startOfDay }, exitType: 'dropped' },
        _count: true,
    });
    if (drops.length > 0) {
        console.log(`\n⚠️  ABANDONOS POR STEP (exitType=dropped)`);
        drops.sort((a, b) => b._count - a._count).forEach(d => {
            console.log(`     ${(d.stepTo || '(null)').padEnd(35)} ${d._count}`);
        });
    }

    // ── 5. MENSAJES + uso de IA ────────────────────────────────────────────────
    // Fuente para AI: FunnelEvent.aiCallCount (incrementado directo en ai.ts).
    const funnelAgg = await prisma.funnelEvent.groupBy({
        by: ['stepTo'],
        where: { enteredAt: { gte: startOfDay } },
        _sum: { messageCount: true, aiCallCount: true },
    });
    if (funnelAgg.length > 0) {
        console.log(`\n💬 MENSAJES POR STEP (con uso real de IA)`);
        let totalMsgs = 0, totalAi = 0;
        funnelAgg
            .map(r => ({
                step: r.stepTo || '(null)',
                msgs: r._sum.messageCount || 0,
                ai: r._sum.aiCallCount || 0,
            }))
            .sort((a, b) => b.msgs - a.msgs)
            .forEach(r => {
                totalMsgs += r.msgs;
                totalAi += r.ai;
                const pct = r.msgs > 0 ? Math.round((r.ai / r.msgs) * 1000) / 10 : 0;
                console.log(`     ${r.step.padEnd(35)} msgs: ${String(r.msgs).padStart(4)}   AI: ${String(r.ai).padStart(3)} (${pct}%)`);
            });
        const totalPct = totalMsgs > 0 ? Math.round((totalAi / totalMsgs) * 1000) / 10 : 0;
        console.log(`     ${'TOTAL'.padEnd(35)} msgs: ${String(totalMsgs).padStart(4)}   AI: ${String(totalAi).padStart(3)} (${totalPct}%)`);
    }

    // ── 6. CHATLOG (mensajes guardados) ────────────────────────────────────────
    const chatLogs = await prisma.chatLog.groupBy({
        by: ['role'],
        where: { timestamp: { gte: startOfDay } },
        _count: true,
    });
    if (chatLogs.length > 0) {
        console.log(`\n📝 CHAT LOGS (mensajes guardados)`);
        chatLogs.sort((a, b) => b._count - a._count).forEach(c => {
            console.log(`     ${(c.role || '(null)').padEnd(20)} ${c._count}`);
        });
    }

    // ── 7. PEDIDOS POR HORA ─────────────────────────────────────────────────────
    const byHour: Record<string, number> = {};
    nonCancelled.forEach(o => {
        const h = new Date(o.createdAt).toLocaleString('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
            hour: '2-digit', hour12: false,
        });
        byHour[h] = (byHour[h] || 0) + 1;
    });
    if (Object.keys(byHour).length > 0) {
        console.log(`\n⏰ PEDIDOS POR HORA (ART)`);
        Object.entries(byHour).sort().forEach(([h, c]) => {
            const bar = '█'.repeat(c);
            console.log(`     ${h}:00   ${bar} ${c}`);
        });
    }

    // ── 8. TIME SINCE LAST ORDER ────────────────────────────────────────────────
    if (nonCancelled.length > 0) {
        const last = nonCancelled[nonCancelled.length - 1];
        const minsSince = Math.round((now.getTime() - new Date(last.createdAt).getTime()) / 60000);
        console.log(`\n🕐 ÚLTIMO PEDIDO`);
        console.log(`     Hace ${minsSince} min — ${last.instanceId} — ${fmtMoney(parsePrice(last.totalPrice))}`);
    }

    console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
    console.log(`║  Fin del reporte`);
    console.log(`╚══════════════════════════════════════════════════════════════════════╝\n`);
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
