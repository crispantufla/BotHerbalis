/**
 * Compara la conversión de marzo (semana alta) vs ahora para identificar
 * dónde cayó. Mide por semana, por step, por método de pago, por script.
 *
 * Uso: DATABASE_URL=<url> npx tsx scripts/investigate-conversion-drop.ts
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 15000,
    max: 5,
});

function arDay(dateStr: string, endOfDay = false): Date {
    const base = `${dateStr}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}-03:00`;
    return new Date(base);
}

interface Window {
    label: string;
    from: Date;
    to: Date;
}

const windows: Window[] = [
    { label: 'Mar 22-28 (alta conv. histórica)', from: arDay('2026-03-22'), to: arDay('2026-03-28', true) },
    { label: 'Abr 19-25 (pre V5/V6)', from: arDay('2026-04-19'), to: arDay('2026-04-25', true) },
    { label: 'May 6-11 (V5/V6 antes MP-first)', from: arDay('2026-05-06'), to: arDay('2026-05-11', true) },
    { label: 'May 12-14 (post MP-first $10k seña)', from: arDay('2026-05-12'), to: arDay('2026-05-14', true) },
    { label: 'May 13-15 (últimos 3 días)', from: arDay('2026-05-13'), to: arDay('2026-05-15', true) },
];

async function q(sql: string, params: any[] = []) {
    const r = await pool.query(sql, params);
    return r.rows;
}

async function metricsFor(w: Window) {
    const [usersRow] = await q(
        `SELECT COUNT(*)::int AS c FROM "User" WHERE "createdAt" BETWEEN $1 AND $2`,
        [w.from, w.to]
    );
    const [ordersAllRow] = await q(
        `SELECT COUNT(*)::int AS c FROM "Order" WHERE "createdAt" BETWEEN $1 AND $2`,
        [w.from, w.to]
    );
    const [ordersOkRow] = await q(
        `SELECT COUNT(*)::int AS c FROM "Order" WHERE "createdAt" BETWEEN $1 AND $2 AND status != 'Cancelado'`,
        [w.from, w.to]
    );
    const ordersByPayment = await q(
        `SELECT COALESCE("paymentMethod",'(null)') AS pm, COUNT(*)::int AS c
         FROM "Order"
         WHERE "createdAt" BETWEEN $1 AND $2 AND status != 'Cancelado'
         GROUP BY pm
         ORDER BY c DESC`,
        [w.from, w.to]
    );
    const ordersByStatus = await q(
        `SELECT COALESCE(status,'(null)') AS s, COUNT(*)::int AS c
         FROM "Order"
         WHERE "createdAt" BETWEEN $1 AND $2
         GROUP BY s
         ORDER BY c DESC`,
        [w.from, w.to]
    );

    let funnelEnters: any[] = [];
    let funnelExits: any[] = [];
    try {
        funnelEnters = await q(
            `SELECT COALESCE("stepTo",'(null)') AS step, COUNT(*)::int AS c
             FROM "FunnelEvent"
             WHERE "enteredAt" BETWEEN $1 AND $2
             GROUP BY step`,
            [w.from, w.to]
        );
        funnelExits = await q(
            `SELECT COALESCE("stepTo",'(null)') AS step, "exitType", COUNT(*)::int AS c
             FROM "FunnelEvent"
             WHERE "enteredAt" BETWEEN $1 AND $2 AND "exitType" IS NOT NULL
             GROUP BY step, "exitType"`,
            [w.from, w.to]
        );
    } catch (e: any) {
        // FunnelEvent puede no existir en la ventana mar 22-28
    }

    const entersMap: Record<string, number> = {};
    funnelEnters.forEach(r => { entersMap[r.step] = r.c; });
    const exitsMap: Record<string, Record<string, number>> = {};
    funnelExits.forEach(r => {
        if (!exitsMap[r.step]) exitsMap[r.step] = {};
        exitsMap[r.step][r.exitType] = r.c;
    });

    // Mensajes bot — largo promedio (sólo si existe ChatLog en la ventana)
    let botMsgCount = 0;
    let avgBotLen = 0;
    try {
        const [r] = await q(
            `SELECT COUNT(*)::int AS cnt, COALESCE(AVG(LENGTH(content)),0)::float AS avg_len
             FROM "ChatLog"
             WHERE "timestamp" BETWEEN $1 AND $2 AND role = 'bot'`,
            [w.from, w.to]
        );
        botMsgCount = r.cnt;
        avgBotLen = r.avg_len;
    } catch (e) {}

    const newUsers = usersRow.c;
    const ordersNonCancelled = ordersOkRow.c;
    const conversion = newUsers > 0 ? (ordersNonCancelled / newUsers) * 100 : 0;

    return {
        window: w,
        newUsers,
        ordersAll: ordersAllRow.c,
        ordersNonCancelled,
        conversion,
        ordersByPayment,
        ordersByStatus,
        entersMap,
        exitsMap,
        botMsgCount,
        avgBotLen,
    };
}

function fmtPct(n: number): string { return n.toFixed(1) + '%'; }

async function main() {
    console.log(`\n╔════════════════════════════════════════════════════════════════════════╗`);
    console.log(`║  INVESTIGACIÓN: ¿Por qué bajó la conversión?`);
    console.log(`║  Generado: ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })} ART`);
    console.log(`╚════════════════════════════════════════════════════════════════════════╝\n`);

    const results = [];
    for (const w of windows) {
        results.push(await metricsFor(w));
    }

    console.log(`📊 CONVERSIÓN POR VENTANA`);
    console.log(`   ${'Ventana'.padEnd(45)}  ${'Chats'.padStart(7)}  ${'Pedidos'.padStart(8)}  ${'Conv%'.padStart(8)}`);
    console.log(`   ${'─'.repeat(45)}  ${'─'.repeat(7)}  ${'─'.repeat(8)}  ${'─'.repeat(8)}`);
    results.forEach(r => {
        console.log(`   ${r.window.label.padEnd(45)}  ${String(r.newUsers).padStart(7)}  ${String(r.ordersNonCancelled).padStart(8)}  ${fmtPct(r.conversion).padStart(8)}`);
    });

    // Largo medio de mensajes
    console.log(`\n📏 LARGO MEDIO DE MENSAJES DEL BOT`);
    console.log(`   ${'Ventana'.padEnd(45)}  ${'Msgs bot'.padStart(10)}  ${'Chars/msg'.padStart(10)}`);
    results.forEach(r => {
        console.log(`   ${r.window.label.padEnd(45)}  ${String(r.botMsgCount).padStart(10)}  ${r.avgBotLen.toFixed(0).padStart(10)}`);
    });

    // Pedidos por método de pago
    console.log(`\n💳 PEDIDOS POR MÉTODO DE PAGO (no cancelados)`);
    const allPayments = new Set<string>();
    results.forEach(r => r.ordersByPayment.forEach((p: any) => allPayments.add(p.pm)));
    const payArr = [...allPayments];
    console.log(`   ${'Ventana'.padEnd(45)}  ${payArr.map(p => p.padStart(16)).join('  ')}`);
    results.forEach(r => {
        const counts = payArr.map(p => {
            const found = r.ordersByPayment.find((x: any) => x.pm === p);
            return String(found?.c || 0).padStart(16);
        });
        console.log(`   ${r.window.label.padEnd(45)}  ${counts.join('  ')}`);
    });

    // Pedidos por status
    console.log(`\n🏷️  PEDIDOS POR STATUS`);
    const allStatus = new Set<string>();
    results.forEach(r => r.ordersByStatus.forEach((s: any) => allStatus.add(s.s)));
    const statusArr = [...allStatus];
    console.log(`   ${'Ventana'.padEnd(45)}  ${statusArr.map(s => s.padStart(16)).join('  ')}`);
    results.forEach(r => {
        const counts = statusArr.map(s => {
            const found = r.ordersByStatus.find((x: any) => x.s === s);
            return String(found?.c || 0).padStart(16);
        });
        console.log(`   ${r.window.label.padEnd(45)}  ${counts.join('  ')}`);
    });

    // Drop-off por step
    const criticalSteps = [
        'greeting', 'waiting_weight', 'waiting_preference', 'waiting_plan_choice',
        'waiting_ok', 'waiting_data', 'waiting_maps_confirmation', 'waiting_payment_method',
        'waiting_mp_payment', 'waiting_price_confirmation', 'waiting_final_confirmation'
    ];

    console.log(`\n➡️  AVANCE POR STEP (advanced / total con exitType)`);
    console.log(`   ${'Step'.padEnd(30)}  ${results.map(r => (r.window.label.split(' ')[1] || r.window.label.slice(0, 8)).padStart(14)).join(' ')}`);
    criticalSteps.forEach(step => {
        const row = results.map(r => {
            const exitTypes = r.exitsMap[step] || {};
            const total = Object.values(exitTypes).reduce((s: number, n: any) => s + (n as number), 0);
            const adv = (exitTypes.advanced as number) || 0;
            const pct = total > 0 ? (adv / total) * 100 : 0;
            return total === 0 ? '   —   '.padStart(14) : `${fmtPct(pct)} ${adv}/${total}`.padStart(14);
        });
        console.log(`   ${step.padEnd(30)}  ${row.join(' ')}`);
    });

    console.log(`\n⏸️  PAUSAS POR STEP (% paused / entradas)`);
    console.log(`   ${'Step'.padEnd(30)}  ${results.map(r => (r.window.label.split(' ')[1] || r.window.label.slice(0, 8)).padStart(14)).join(' ')}`);
    criticalSteps.forEach(step => {
        const row = results.map(r => {
            const exitTypes = r.exitsMap[step] || {};
            const paused = (exitTypes.paused as number) || 0;
            const enters = r.entersMap[step] || 0;
            const pct = enters > 0 ? (paused / enters) * 100 : 0;
            return enters === 0 ? '   —   '.padStart(14) : `${fmtPct(pct)} ${paused}/${enters}`.padStart(14);
        });
        console.log(`   ${step.padEnd(30)}  ${row.join(' ')}`);
    });

    // Diagnóstico
    console.log(`\n🔍 DIAGNÓSTICO`);
    const base = results[0];
    const last = results[results.length - 1];
    console.log(`   Conversión marzo → ahora: ${fmtPct(base.conversion)} → ${fmtPct(last.conversion)}  (Δ ${(last.conversion - base.conversion).toFixed(1)}pp)`);

    console.log(`\n   Cambios de avance% por step (marzo vs últimos 3 días):`);
    criticalSteps.forEach(step => {
        const a = base.exitsMap[step] || {};
        const b = last.exitsMap[step] || {};
        const aTotal = Object.values(a).reduce((s: number, n: any) => s + (n as number), 0);
        const bTotal = Object.values(b).reduce((s: number, n: any) => s + (n as number), 0);
        if (aTotal === 0 && bTotal === 0) return;
        const aPct = aTotal > 0 ? ((a.advanced as number || 0) / aTotal) * 100 : 0;
        const bPct = bTotal > 0 ? ((b.advanced as number || 0) / bTotal) * 100 : 0;
        const diff = bPct - aPct;
        if (Math.abs(diff) > 3) {
            const arrow = diff > 0 ? '🟢' : '🔴';
            console.log(`     ${arrow} ${step.padEnd(28)}  ${fmtPct(aPct)} → ${fmtPct(bPct)}  (${diff > 0 ? '+' : ''}${diff.toFixed(1)}pp)`);
        }
    });
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => pool.end());
