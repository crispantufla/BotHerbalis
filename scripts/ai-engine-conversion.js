/**
 * ai-engine-conversion.js
 *
 * Mide el impacto de la migración a Claude: conversión (órdenes/prospectos) y
 * tasa de "Errores de IA" en el período GPT (antes del corte) vs el período
 * Claude (después). Read-only — no escribe nada.
 *
 * Por qué: el 2026-05-31 migramos el 100% del tráfico a Claude apostando a más
 * conversión. Esto lo verifica con datos en vez de a ojo. Ya NO es un A/B (no
 * hay grupo de control GPT); es un antes/después por ventana de tiempo.
 *
 * Uso:
 *   node scripts/ai-engine-conversion.js                 # corte 2026-05-31, 7 días por lado
 *   node scripts/ai-engine-conversion.js 2026-05-31 7    # corte y días explícitos
 *
 * Contra PRODUCCIÓN (DB read-only):
 *   $env:DATABASE_URL = (railway variables --service Postgres --kv | sls DATABASE_PUBLIC_URL)
 *   node scripts/ai-engine-conversion.js
 */

require('dotenv').config();
const { prisma } = require('../db');

const LEGACY_INSTANCE = '__legacy_import__';
const PROSPECT_STEPS = ['greeting', 'waiting_weight'];

function parseArgs() {
    const cutoffArg = process.argv[2] || '2026-05-31';
    const daysArg = parseInt(process.argv[3] || '7', 10) || 7;
    const cutoff = new Date(`${cutoffArg}T00:00:00.000Z`);
    if (isNaN(cutoff.getTime())) {
        console.error(`Fecha de corte inválida: "${cutoffArg}". Usá YYYY-MM-DD.`);
        process.exit(1);
    }
    return { cutoff, days: daysArg };
}

async function windowMetrics(from, to) {
    // Prospectos: teléfonos distintos que entraron al funnel en la ventana.
    const prospectRows = await prisma.funnelEvent.findMany({
        where: { stepTo: { in: PROSPECT_STEPS }, enteredAt: { gte: from, lt: to } },
        select: { phone: true, sellerId: true },
        distinct: ['phone', 'sellerId'],
    });
    const prospects = prospectRows.length;

    // Órdenes reales (excluye el namespace de import legacy).
    const orders = await prisma.order.count({
        where: { createdAt: { gte: from, lt: to }, instanceId: { not: LEGACY_INSTANCE } },
    });

    // Reportes de "Error de IA" cargados por el admin en la ventana.
    const aiErrors = await prisma.aiErrorReport.count({
        where: { createdAt: { gte: from, lt: to } },
    });

    const conv = prospects > 0 ? (orders / prospects) * 100 : 0;
    const errPer100 = prospects > 0 ? (aiErrors / prospects) * 100 : 0;
    return { prospects, orders, conv, aiErrors, errPer100 };
}

function fmtRow(label, m) {
    return [
        label.padEnd(16),
        String(m.prospects).padStart(9),
        String(m.orders).padStart(7),
        `${m.conv.toFixed(2)}%`.padStart(9),
        String(m.aiErrors).padStart(8),
        `${m.errPer100.toFixed(2)}`.padStart(11),
    ].join(' │ ');
}

async function main() {
    const { cutoff, days } = parseArgs();
    const now = new Date();

    const gptFrom = new Date(cutoff.getTime() - days * 86400000);
    const gptTo = cutoff;
    const claudeFrom = cutoff;
    const claudeTo = new Date(Math.min(cutoff.getTime() + days * 86400000, now.getTime()));

    const claudeDaysReales = Math.max(0, (claudeTo - claudeFrom) / 86400000);

    console.log('\n📊 Conversión IA — GPT (antes) vs Claude (después)');
    console.log('═'.repeat(72));
    console.log(`Corte migración: ${cutoff.toISOString().slice(0, 10)}  |  Ventana: ${days} días por lado`);
    console.log(`GPT:    ${gptFrom.toISOString().slice(0, 10)} → ${gptTo.toISOString().slice(0, 10)}`);
    console.log(`Claude: ${claudeFrom.toISOString().slice(0, 10)} → ${claudeTo.toISOString().slice(0, 10)} (${claudeDaysReales.toFixed(1)} días con datos)`);
    if (claudeDaysReales < days) {
        console.log(`⚠️  El período Claude todavía no completó ${days} días — la comparación es parcial.`);
    }
    console.log('─'.repeat(72));
    console.log(['Período'.padEnd(16), 'Prospectos', 'Órden.', 'Conv.', 'ErrIA', 'Err/100prosp'].join(' │ '));
    console.log('─'.repeat(72));

    const gpt = await windowMetrics(gptFrom, gptTo);
    const claude = await windowMetrics(claudeFrom, claudeTo);
    console.log(fmtRow('GPT-4o', gpt));
    console.log(fmtRow('Claude', claude));
    console.log('─'.repeat(72));

    const deltaConv = claude.conv - gpt.conv;
    const arrow = deltaConv > 0 ? '🟢 ↑' : deltaConv < 0 ? '🔴 ↓' : '⚪️ =';
    console.log(`Δ Conversión: ${arrow} ${deltaConv >= 0 ? '+' : ''}${deltaConv.toFixed(2)} pts`);
    if (gpt.conv > 0) {
        const rel = (deltaConv / gpt.conv) * 100;
        console.log(`   (${rel >= 0 ? '+' : ''}${rel.toFixed(0)}% relativo sobre el período GPT)`);
    }
    console.log('\nNota: prospectos = teléfonos distintos que entraron al funnel (FunnelEvent');
    console.log('stepTo greeting/waiting_weight). Órdenes excluye el import legacy. La señal');
    console.log('es más confiable cuanto más larga sea la ventana Claude.\n');
}

main()
    .catch((e) => { console.error('Error:', e.message); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
