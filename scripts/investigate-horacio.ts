/**
 * Análisis enfocado SOLO en horacio: era el único vendedor activo en marzo,
 * comparado con su propia evolución hasta ahora.
 *
 * Uso: DATABASE_URL=<url> npx tsx scripts/investigate-horacio.ts
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000, max: 5 });

const SELLER = 'horacio';

function arDay(dateStr: string, endOfDay = false): Date {
    const base = `${dateStr}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}-03:00`;
    return new Date(base);
}

interface Window { label: string; from: Date; to: Date; }

const windows: Window[] = [
    { label: 'Mar 8-14',   from: arDay('2026-03-08'), to: arDay('2026-03-14', true) },
    { label: 'Mar 15-21',  from: arDay('2026-03-15'), to: arDay('2026-03-21', true) },
    { label: 'Mar 22-28 ★',from: arDay('2026-03-22'), to: arDay('2026-03-28', true) },
    { label: 'Mar 29-Abr 4',from: arDay('2026-03-29'), to: arDay('2026-04-04', true) },
    { label: 'Abr 5-11',   from: arDay('2026-04-05'), to: arDay('2026-04-11', true) },
    { label: 'Abr 12-17 (último)', from: arDay('2026-04-12'), to: arDay('2026-04-17', true) },
];

async function q(sql: string, params: any[] = []) {
    const r = await pool.query(sql, params);
    return r.rows;
}

async function metricsFor(w: Window) {
    const [users] = await q(
        `SELECT COUNT(*)::int AS c FROM "User"
         WHERE "instanceId"=$1 AND "createdAt" BETWEEN $2 AND $3`,
        [SELLER, w.from, w.to]
    );
    const [ordersAll] = await q(
        `SELECT COUNT(*)::int AS c FROM "Order"
         WHERE "instanceId"=$1 AND "createdAt" BETWEEN $2 AND $3`,
        [SELLER, w.from, w.to]
    );
    const [ordersOk] = await q(
        `SELECT COUNT(*)::int AS c FROM "Order"
         WHERE "instanceId"=$1 AND "createdAt" BETWEEN $2 AND $3 AND status != 'Cancelado'`,
        [SELLER, w.from, w.to]
    );
    const ordersByPayment = await q(
        `SELECT COALESCE("paymentMethod",'(null)') AS pm, COUNT(*)::int AS c
         FROM "Order"
         WHERE "instanceId"=$1 AND "createdAt" BETWEEN $2 AND $3 AND status != 'Cancelado'
         GROUP BY pm ORDER BY c DESC`,
        [SELLER, w.from, w.to]
    );
    const ordersByStatus = await q(
        `SELECT COALESCE(status,'(null)') AS s, COUNT(*)::int AS c
         FROM "Order"
         WHERE "instanceId"=$1 AND "createdAt" BETWEEN $2 AND $3
         GROUP BY s ORDER BY c DESC`,
        [SELLER, w.from, w.to]
    );
    const [revenue] = await q(
        `SELECT COALESCE(SUM("totalPrice"),0)::float AS sum, COALESCE(AVG("totalPrice"),0)::float AS aov
         FROM "Order"
         WHERE "instanceId"=$1 AND "createdAt" BETWEEN $2 AND $3 AND status != 'Cancelado'`,
        [SELLER, w.from, w.to]
    );
    // Plan breakdown desde products
    const plans = await q(
        `SELECT
            CASE
                WHEN products ILIKE '%plan 60%' OR products ILIKE '%plan 2 mes%' THEN 'Plan 60'
                WHEN products ILIKE '%plan 120%' OR products ILIKE '%plan 4 mes%' THEN 'Plan 120'
                ELSE '(otro)'
            END AS plan,
            COUNT(*)::int AS c
         FROM "Order"
         WHERE "instanceId"=$1 AND "createdAt" BETWEEN $2 AND $3 AND status != 'Cancelado'
         GROUP BY plan ORDER BY c DESC`,
        [SELLER, w.from, w.to]
    );
    // Producto (cápsulas, gotas, semillas)
    const products = await q(
        `SELECT
            CASE
                WHEN products ILIKE '%c%psula%' OR products ILIKE '%capsula%' THEN 'Cápsulas'
                WHEN products ILIKE '%gota%' THEN 'Gotas'
                WHEN products ILIKE '%semilla%' OR products ILIKE '%infusi%' THEN 'Semillas'
                ELSE '(otro)'
            END AS prod,
            COUNT(*)::int AS c
         FROM "Order"
         WHERE "instanceId"=$1 AND "createdAt" BETWEEN $2 AND $3 AND status != 'Cancelado'
         GROUP BY prod ORDER BY c DESC`,
        [SELLER, w.from, w.to]
    );
    // Largo medio del bot
    const [botLen] = await q(
        `SELECT COUNT(*)::int AS cnt, COALESCE(AVG(LENGTH(content)),0)::float AS avg
         FROM "ChatLog"
         WHERE "instanceId"=$1 AND "timestamp" BETWEEN $2 AND $3 AND role='bot'`,
        [SELLER, w.from, w.to]
    );

    const newUsers = users.c;
    const ordersNonCancelled = ordersOk.c;
    const conversion = newUsers > 0 ? (ordersNonCancelled / newUsers) * 100 : 0;

    return {
        w, newUsers,
        ordersAll: ordersAll.c, ordersNonCancelled,
        conversion,
        ordersByPayment, ordersByStatus,
        revenue: revenue.sum, aov: revenue.aov,
        plans, products,
        botMsgCount: botLen.cnt, avgBotLen: botLen.avg,
    };
}

function fmtPct(n: number): string { return n.toFixed(1) + '%'; }
function fmtMoney(n: number): string { return '$' + Math.round(n).toLocaleString('es-AR'); }

async function main() {
    console.log(`\n╔════════════════════════════════════════════════════════════════════════╗`);
    console.log(`║  HORACIO — Evolución de conversión (único vendedor en marzo)`);
    console.log(`║  ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })} ART`);
    console.log(`╚════════════════════════════════════════════════════════════════════════╝\n`);

    const results = [];
    for (const w of windows) results.push(await metricsFor(w));

    console.log(`📊 CONVERSIÓN POR SEMANA (sólo horacio)`);
    console.log(`   ${'Ventana'.padEnd(28)}  ${'Chats'.padStart(7)}  ${'Pedidos'.padStart(8)}  ${'Conv%'.padStart(8)}  ${'Revenue'.padStart(13)}  ${'AOV'.padStart(10)}`);
    console.log(`   ${'─'.repeat(28)}  ${'─'.repeat(7)}  ${'─'.repeat(8)}  ${'─'.repeat(8)}  ${'─'.repeat(13)}  ${'─'.repeat(10)}`);
    results.forEach(r => {
        console.log(`   ${r.w.label.padEnd(28)}  ${String(r.newUsers).padStart(7)}  ${String(r.ordersNonCancelled).padStart(8)}  ${fmtPct(r.conversion).padStart(8)}  ${fmtMoney(r.revenue).padStart(13)}  ${fmtMoney(r.aov).padStart(10)}`);
    });

    console.log(`\n📏 LARGO MEDIO DE MENSAJES DEL BOT`);
    console.log(`   ${'Ventana'.padEnd(28)}  ${'Msgs bot'.padStart(10)}  ${'Chars/msg'.padStart(10)}`);
    results.forEach(r => {
        console.log(`   ${r.w.label.padEnd(28)}  ${String(r.botMsgCount).padStart(10)}  ${r.avgBotLen.toFixed(0).padStart(10)}`);
    });

    console.log(`\n💳 MIX DE MÉTODO DE PAGO POR SEMANA`);
    const allPm = new Set<string>();
    results.forEach(r => r.ordersByPayment.forEach((p: any) => allPm.add(p.pm)));
    const pmArr = [...allPm];
    console.log(`   ${'Ventana'.padEnd(28)}  ${pmArr.map(p => p.padStart(15)).join('  ')}`);
    results.forEach(r => {
        const counts = pmArr.map(p => {
            const f = r.ordersByPayment.find((x: any) => x.pm === p);
            return String(f?.c || 0).padStart(15);
        });
        console.log(`   ${r.w.label.padEnd(28)}  ${counts.join('  ')}`);
    });

    console.log(`\n🏷️  STATUS DE LOS PEDIDOS POR SEMANA`);
    const allSt = new Set<string>();
    results.forEach(r => r.ordersByStatus.forEach((s: any) => allSt.add(s.s)));
    const stArr = [...allSt];
    console.log(`   ${'Ventana'.padEnd(28)}  ${stArr.map(s => s.padStart(15)).join('  ')}`);
    results.forEach(r => {
        const counts = stArr.map(s => {
            const f = r.ordersByStatus.find((x: any) => x.s === s);
            return String(f?.c || 0).padStart(15);
        });
        console.log(`   ${r.w.label.padEnd(28)}  ${counts.join('  ')}`);
    });

    console.log(`\n🥫 PLAN BREAKDOWN`);
    const allPlans = new Set<string>();
    results.forEach(r => r.plans.forEach((p: any) => allPlans.add(p.plan)));
    const planArr = [...allPlans];
    console.log(`   ${'Ventana'.padEnd(28)}  ${planArr.map(p => p.padStart(13)).join('  ')}`);
    results.forEach(r => {
        const counts = planArr.map(p => {
            const f = r.plans.find((x: any) => x.plan === p);
            return String(f?.c || 0).padStart(13);
        });
        console.log(`   ${r.w.label.padEnd(28)}  ${counts.join('  ')}`);
    });

    console.log(`\n💊 PRODUCTO BREAKDOWN`);
    const allProds = new Set<string>();
    results.forEach(r => r.products.forEach((p: any) => allProds.add(p.prod)));
    const prodArr = [...allProds];
    console.log(`   ${'Ventana'.padEnd(28)}  ${prodArr.map(p => p.padStart(13)).join('  ')}`);
    results.forEach(r => {
        const counts = prodArr.map(p => {
            const f = r.products.find((x: any) => x.prod === p);
            return String(f?.c || 0).padStart(13);
        });
        console.log(`   ${r.w.label.padEnd(28)}  ${counts.join('  ')}`);
    });

    // Análisis del último step alcanzado por chats no convertidos
    // (consulta cara — la hacemos solo si User tiene profileData con step)
    console.log(`\n⚠️  ESTADO FINAL DE CHATS NO CONVERTIDOS (último step según profileData)`);
    for (const r of results) {
        try {
            const rows = await q(
                `SELECT
                    COALESCE("pauseReason",'(activo)') AS reason,
                    COUNT(*)::int AS c
                 FROM "User"
                 WHERE "instanceId"=$1 AND "createdAt" BETWEEN $2 AND $3
                 GROUP BY reason ORDER BY c DESC`,
                [SELLER, r.w.from, r.w.to]
            );
            if (rows.length > 0) {
                console.log(`   ${r.w.label}:`);
                rows.forEach((x: any) => console.log(`     ${x.reason.padEnd(40)} ${x.c}`));
            }
        } catch (e: any) {}
    }

    // Diagnóstico final
    console.log(`\n🔍 DIAGNÓSTICO`);
    const peak = results[2]; // Mar 22-28
    const drop = results.filter(r => r.conversion > 0 && r !== peak);
    if (drop.length > 0) {
        const last = drop[drop.length - 1];
        console.log(`   Pico (Mar 22-28): ${fmtPct(peak.conversion)}  |  Última semana medible (${last.w.label}): ${fmtPct(last.conversion)}`);
        console.log(`   Δ = ${(last.conversion - peak.conversion).toFixed(1)}pp\n`);
    }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => pool.end());
