/**
 * Investigación profunda de efectividad de ventas (post modelo retiro/domicilio).
 *
 * Ventana de análisis: 2026-05-13 (deploy del modelo nuevo) → hoy.
 *
 * Dump a stdout + JSON en reports/research-2026-05-26/ para análisis posterior.
 *
 * Uso: npx tsx scripts/research-sales-effectiveness.ts
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 15000,
    max: 5,
});

const OUT_DIR = path.join(__dirname, '..', 'reports', 'research-2026-05-26');
const SINCE = new Date('2026-05-13T00:00:00.000-03:00');
const NOW = new Date();

function arDay(s: string, endOfDay = false): Date {
    return new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}-03:00`);
}

async function q(sql: string, params: any[] = []) {
    const r = await pool.query(sql, params);
    return r.rows;
}

function pct(n: number, total: number): string {
    if (!total) return '   —   ';
    return `${((n / total) * 100).toFixed(1)}%`;
}

function fmt(n: number): string {
    return String(n).padStart(6);
}

function writeJson(name: string, data: any) {
    fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(data, null, 2));
}

interface Section {
    title: string;
    lines: string[];
}

const sections: Section[] = [];
function section(title: string) {
    const s: Section = { title, lines: [] };
    sections.push(s);
    return {
        line: (l: string) => s.lines.push(l),
    };
}

async function overallFunnel() {
    const s = section('1) FUNNEL GLOBAL — desde 2026-05-13');

    const [{ c: users }] = await q(
        `SELECT COUNT(*)::int AS c FROM "User" WHERE "createdAt" >= $1`,
        [SINCE]
    );
    const [{ c: orders }] = await q(
        `SELECT COUNT(*)::int AS c FROM "Order" WHERE "createdAt" >= $1 AND status != 'Cancelado'`,
        [SINCE]
    );
    const [{ c: cancelled }] = await q(
        `SELECT COUNT(*)::int AS c FROM "Order" WHERE "createdAt" >= $1 AND status = 'Cancelado'`,
        [SINCE]
    );

    s.line(`Usuarios nuevos: ${users}`);
    s.line(`Pedidos no-cancelados: ${orders}`);
    s.line(`Pedidos cancelados: ${cancelled}`);
    s.line(`Conversión global: ${pct(orders, users)}`);

    // Steps por funnel
    const steps = [
        'greeting',
        'waiting_weight',
        'waiting_preference',
        'waiting_plan_choice',
        'waiting_ok',
        'waiting_data',
        'waiting_maps_confirmation',
        'waiting_payment_method',
        'waiting_mp_payment',
        'waiting_transfer_confirmation',
        'waiting_admin_validation',
        'completed',
    ];

    s.line('');
    s.line('STEP                              ENTRARON  AVANZARON  PAUSED  DROPPED  COMPLETED  BACK');
    const stepStats: any = {};
    for (const step of steps) {
        const enters = await q(
            `SELECT COUNT(*)::int AS c FROM "FunnelEvent"
             WHERE "enteredAt" >= $1 AND "stepTo" = $2`,
            [SINCE, step]
        );
        const exits = await q(
            `SELECT "exitType", COUNT(*)::int AS c FROM "FunnelEvent"
             WHERE "enteredAt" >= $1 AND "stepTo" = $2 AND "exitType" IS NOT NULL
             GROUP BY "exitType"`,
            [SINCE, step]
        );
        const m: any = {};
        exits.forEach((e: any) => { m[e.exitType] = e.c; });
        const total = enters[0].c;
        s.line(`${step.padEnd(34)} ${fmt(total)}   ${fmt(m.advanced || 0)}   ${fmt(m.paused || 0)}  ${fmt(m.dropped || 0)}   ${fmt(m.completed || 0)}    ${fmt(m.back || 0)}`);
        stepStats[step] = { enters: total, ...m };
    }

    writeJson('funnel-steps.json', stepStats);
    return stepStats;
}

async function pauseReasons() {
    const s = section('2) PAUSAS — top reasons');

    const rows = await q(
        `SELECT "pauseReason", COUNT(*)::int AS c
         FROM "User"
         WHERE "pausedAt" >= $1 AND "pauseReason" IS NOT NULL
         GROUP BY "pauseReason"
         ORDER BY c DESC
         LIMIT 50`,
        [SINCE]
    );

    s.line(`Total pausas distintas (top 50): ${rows.length}`);
    s.line('');
    s.line('REASON'.padEnd(80) + 'COUNT');
    rows.forEach((r: any) => {
        const reason = (r.pauseReason || '(null)').slice(0, 78);
        s.line(reason.padEnd(80) + r.c);
    });

    writeJson('pause-reasons.json', rows);
    return rows;
}

async function ordersByPayment() {
    const s = section('3) ÓRDENES — payment method + shipping choice');

    const byPay = await q(
        `SELECT COALESCE("paymentMethod",'(null)') AS pm, status, COUNT(*)::int AS c
         FROM "Order"
         WHERE "createdAt" >= $1
         GROUP BY pm, status
         ORDER BY pm, c DESC`,
        [SINCE]
    );

    s.line('PAYMENT METHOD          STATUS              COUNT');
    byPay.forEach((r: any) => {
        s.line(`${r.pm.padEnd(24)}${r.status.padEnd(20)}${r.c}`);
    });

    // Avg price
    const [{ avg, n }] = await q(
        `SELECT AVG("totalPrice")::float AS avg, COUNT(*)::int AS n
         FROM "Order" WHERE "createdAt" >= $1 AND status != 'Cancelado'`,
        [SINCE]
    );
    s.line('');
    s.line(`Ticket promedio (no-cancelados): $${(avg || 0).toFixed(0)} (n=${n})`);

    writeJson('orders-by-payment.json', byPay);
}

async function lostConversations() {
    const s = section('4) MUESTRA — conversaciones perdidas (paused + sin orden)');

    // Users paused since model change, no completed order
    const lost = await q(
        `SELECT u.phone, u."instanceId", u."pausedAt", u."pauseReason",
                (SELECT COUNT(*)::int FROM "ChatLog" WHERE "userPhone" = u.phone AND "instanceId" = u."instanceId") AS msg_count,
                (SELECT COUNT(*)::int FROM "Order" WHERE "userPhone" = u.phone AND "instanceId" = u."instanceId" AND status != 'Cancelado') AS orders
         FROM "User" u
         WHERE u."pausedAt" >= $1
         ORDER BY u."pausedAt" DESC
         LIMIT 50`,
        [SINCE]
    );

    const losts = lost.filter((l: any) => l.orders === 0);
    s.line(`Conversaciones paused sin orden completada (muestra ${losts.length}):`);
    s.line('');

    // For each, fetch last 10 messages
    const samples: any[] = [];
    for (const u of losts.slice(0, 25)) {
        const msgs = await q(
            `SELECT role, content, "timestamp" FROM "ChatLog"
             WHERE "userPhone" = $1 AND "instanceId" = $2
             ORDER BY "timestamp" DESC LIMIT 15`,
            [u.phone, u.instanceId]
        );
        msgs.reverse();
        samples.push({
            phone: u.phone,
            seller: u.instanceId,
            pausedAt: u.pausedAt,
            reason: u.pauseReason,
            msgCount: u.msg_count,
            tail: msgs,
        });

        s.line(`────────────────────────────────────────────────────────────────────`);
        s.line(`Phone: ${u.phone}  Seller: ${u.instanceId}`);
        s.line(`Pausado: ${u.pausedAt}  Reason: ${u.pauseReason}`);
        s.line(`Total msgs: ${u.msg_count}`);
        msgs.forEach((m: any) => {
            const role = m.role.padEnd(4);
            const content = String(m.content || '').replace(/\n/g, ' ').slice(0, 200);
            s.line(`  [${role}] ${content}`);
        });
    }

    writeJson('lost-conversations.json', samples);
    return losts.length;
}

async function wonConversations() {
    const s = section('5) MUESTRA — conversaciones ganadas (con orden completada)');

    const won = await q(
        `SELECT o."userPhone" AS phone, o."instanceId", o."createdAt", o.status, o."paymentMethod", o."totalPrice",
                (SELECT COUNT(*)::int FROM "ChatLog" WHERE "userPhone" = o."userPhone" AND "instanceId" = o."instanceId") AS msg_count
         FROM "Order" o
         WHERE o."createdAt" >= $1 AND o.status != 'Cancelado'
         ORDER BY o."createdAt" DESC
         LIMIT 20`,
        [SINCE]
    );

    s.line(`Ventas recientes: ${won.length}`);
    s.line('');

    const samples: any[] = [];
    for (const u of won.slice(0, 15)) {
        const msgs = await q(
            `SELECT role, content, "timestamp" FROM "ChatLog"
             WHERE "userPhone" = $1 AND "instanceId" = $2
             ORDER BY "timestamp" ASC LIMIT 80`,
            [u.phone, u.instanceId]
        );
        samples.push({
            phone: u.phone,
            seller: u.instanceId,
            payment: u.paymentMethod,
            total: u.totalPrice,
            msgCount: u.msg_count,
            tail: msgs.slice(-15),
        });

        s.line(`────────────────────────────────────────────────────────────────────`);
        s.line(`Phone: ${u.phone}  Seller: ${u.instanceId}  Pago: ${u.paymentMethod}  Total: $${u.totalPrice}`);
        s.line(`Total msgs: ${u.msg_count}`);
        s.line('Últimos 15 mensajes:');
        msgs.slice(-15).forEach((m: any) => {
            const role = m.role.padEnd(4);
            const content = String(m.content || '').replace(/\n/g, ' ').slice(0, 200);
            s.line(`  [${role}] ${content}`);
        });
    }

    writeJson('won-conversations.json', samples);
}

async function messageEventInsights() {
    const s = section('6) MESSAGE EVENTS — matched vs IA + price objections');

    const rows = await q(
        `SELECT step,
                COUNT(*)::int AS total,
                SUM(CASE WHEN matched THEN 1 ELSE 0 END)::int AS matched,
                SUM(CASE WHEN "priceObjection" THEN 1 ELSE 0 END)::int AS price_obj,
                AVG("retryIndex")::float AS avg_retry,
                MAX("retryIndex")::int AS max_retry
         FROM "MessageEvent"
         WHERE "at" >= $1
         GROUP BY step
         ORDER BY total DESC`,
        [SINCE]
    );

    s.line('STEP                          TOTAL   MATCHED(%)    PRICE_OBJ    AVG_RETRY  MAX_RETRY');
    rows.forEach((r: any) => {
        const matchedPct = pct(r.matched, r.total);
        s.line(`${r.step.padEnd(32)}${fmt(r.total)} ${matchedPct.padStart(10)}   ${fmt(r.price_obj)}     ${(r.avg_retry || 0).toFixed(2).padStart(6)}     ${r.max_retry}`);
    });

    writeJson('message-events.json', rows);
}

async function aiErrors() {
    const s = section('7) AI ERROR REPORTS — admin corrections');

    const rows = await q(
        `SELECT "reportedMessage", correction, "createdAt"
         FROM "AiErrorReport"
         WHERE "createdAt" >= $1
         ORDER BY "createdAt" DESC
         LIMIT 30`,
        [SINCE]
    );

    s.line(`Reportes de error de admin (últimos 30 desde 2026-05-13): ${rows.length}`);
    s.line('');
    rows.forEach((r: any) => {
        s.line(`---`);
        s.line(`Fecha: ${r.createdAt}`);
        s.line(`Reportado: ${String(r.reportedMessage).slice(0, 250)}`);
        s.line(`Corrección: ${String(r.correction).slice(0, 250)}`);
    });

    writeJson('ai-errors.json', rows);
}

async function timing() {
    const s = section('8) TIMING — tiempo medio en cada step');

    const rows = await q(
        `SELECT "stepTo" AS step,
                AVG(EXTRACT(EPOCH FROM ("exitedAt" - "enteredAt")))::float AS avg_seconds,
                COUNT(*)::int AS n
         FROM "FunnelEvent"
         WHERE "enteredAt" >= $1 AND "exitedAt" IS NOT NULL
         GROUP BY "stepTo"
         ORDER BY avg_seconds DESC`,
        [SINCE]
    );

    s.line('STEP                          AVG_SECONDS  AVG_MIN   N');
    rows.forEach((r: any) => {
        const secs = r.avg_seconds || 0;
        s.line(`${r.step.padEnd(32)}${secs.toFixed(0).padStart(11)} ${(secs / 60).toFixed(1).padStart(8)}  ${r.n}`);
    });

    writeJson('timing.json', rows);
}

async function dropAfterShippingChoice() {
    const s = section('9) DROP POST-PAYMENT-METHOD (entró al menú retiro/domicilio, no compró)');

    // Users that hit waiting_payment_method and never reached a non-cancelled order
    const rows = await q(
        `SELECT DISTINCT fe.phone, fe."sellerId"
         FROM "FunnelEvent" fe
         WHERE fe."stepTo" = 'waiting_payment_method' AND fe."enteredAt" >= $1
         AND NOT EXISTS (
           SELECT 1 FROM "Order" o
           WHERE o."userPhone" = fe.phone AND o."instanceId" = fe."sellerId"
             AND o.status != 'Cancelado'
             AND o."createdAt" >= fe."enteredAt"
         )
         LIMIT 30`,
        [SINCE]
    );

    s.line(`Usuarios que llegaron al menú y no convirtieron (muestra): ${rows.length}`);
    s.line('');

    const samples: any[] = [];
    for (const u of rows.slice(0, 20)) {
        // Last 20 messages
        const msgs = await q(
            `SELECT role, content, "timestamp" FROM "ChatLog"
             WHERE "userPhone" = $1 AND "instanceId" = $2
             ORDER BY "timestamp" DESC LIMIT 20`,
            [u.phone, u.sellerId]
        );
        msgs.reverse();
        samples.push({ phone: u.phone, seller: u.sellerId, tail: msgs });

        s.line(`────────────────────────────────────────────────────────────────────`);
        s.line(`Phone: ${u.phone}  Seller: ${u.sellerId}`);
        msgs.forEach((m: any) => {
            const role = m.role.padEnd(4);
            const content = String(m.content || '').replace(/\n/g, ' ').slice(0, 200);
            s.line(`  [${role}] ${content}`);
        });
    }

    writeJson('drop-post-payment.json', samples);
}

async function priceObjectionConversations() {
    const s = section('10) MUESTRA — conversaciones con price objection detectada');

    const rows = await q(
        `SELECT DISTINCT phone, "sellerId"
         FROM "MessageEvent"
         WHERE "priceObjection" = true AND "at" >= $1
         LIMIT 25`,
        [SINCE]
    );

    s.line(`Conversaciones con price objection: ${rows.length}`);
    s.line('');

    const samples: any[] = [];
    for (const u of rows.slice(0, 15)) {
        const msgs = await q(
            `SELECT role, content, "timestamp" FROM "ChatLog"
             WHERE "userPhone" = $1 AND "instanceId" = $2
             ORDER BY "timestamp" DESC LIMIT 14`,
            [u.phone, u.sellerId]
        );
        msgs.reverse();
        samples.push({ phone: u.phone, seller: u.sellerId, tail: msgs });

        s.line(`────────────────────────────────────────────────────────────────────`);
        s.line(`Phone: ${u.phone}  Seller: ${u.sellerId}`);
        msgs.forEach((m: any) => {
            const role = m.role.padEnd(4);
            const content = String(m.content || '').replace(/\n/g, ' ').slice(0, 200);
            s.line(`  [${role}] ${content}`);
        });
    }

    writeJson('price-objections.json', samples);
}

async function main() {
    const t0 = Date.now();
    await overallFunnel();
    await pauseReasons();
    await ordersByPayment();
    await messageEventInsights();
    await timing();
    await dropAfterShippingChoice();
    await priceObjectionConversations();
    await lostConversations();
    await wonConversations();
    await aiErrors();

    // Stitch all sections into one report
    const txt: string[] = [];
    txt.push(`╔════════════════════════════════════════════════════════════════════════════╗`);
    txt.push(`║  INVESTIGACIÓN DE EFECTIVIDAD DE VENTAS                                    ║`);
    txt.push(`║  Período: 2026-05-13 → ${NOW.toISOString().slice(0, 10).padEnd(50)}║`);
    txt.push(`║  Generado: ${new Date().toLocaleString('es-AR').padEnd(63)}║`);
    txt.push(`╚════════════════════════════════════════════════════════════════════════════╝`);
    txt.push('');
    sections.forEach(s => {
        txt.push('');
        txt.push(`### ${s.title}`);
        txt.push('');
        txt.push(...s.lines);
    });

    const reportPath = path.join(OUT_DIR, 'report.txt');
    fs.writeFileSync(reportPath, txt.join('\n'));
    console.log(`Reporte escrito: ${reportPath}  (${(Date.now() - t0) / 1000}s)`);
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => pool.end());
