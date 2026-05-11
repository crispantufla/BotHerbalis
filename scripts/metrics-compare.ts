/**
 * Comparación A/B de dos ventanas — mide el impacto del cambio de prompt
 * (commit 80bdd82, 29/04/2026) que introdujo el split corta/expandida.
 *
 * Métricas:
 *   1. Conversión: órdenes no canceladas / chats nuevos en la ventana
 *   2. % pausas en waiting_preference y waiting_weight
 *   3. Avance step→step (advanced / total exits) por step clave
 *   4. Largo medio de respuestas del bot (caracteres por mensaje)
 *
 * Uso: DATABASE_URL=<public-url> npx tsx scripts/metrics-compare.ts
 */
const { prisma } = require('../db');

// Ventana en hora Argentina (UTC-3). Inclusive ambos extremos.
function arDay(dateStr: string, endOfDay = false): Date {
    // dateStr format: 'YYYY-MM-DD'
    const base = `${dateStr}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}-03:00`;
    return new Date(base);
}

interface Window {
    label: string;
    from: Date;
    to: Date;
}

const baseline: Window = {
    label: 'Baseline · 19-25/04 (prompt viejo)',
    from: arDay('2026-04-19'),
    to: arDay('2026-04-25', true),
};

const postChange: Window = {
    label: 'Post-cambio · 29/04-05/05 (prompt nuevo)',
    from: arDay('2026-04-29'),
    to: arDay('2026-05-05', true),
};

async function metricsFor(w: Window) {
    const where = { gte: w.from, lte: w.to };

    // 1. Conversión
    const [newUsers, ordersAll, ordersNonCancelled] = await Promise.all([
        prisma.user.count({ where: { createdAt: where } }),
        prisma.order.count({ where: { createdAt: where } }),
        prisma.order.count({ where: { createdAt: where, status: { not: 'Cancelado' } } }),
    ]);
    const conversion = newUsers > 0 ? (ordersNonCancelled / newUsers) * 100 : 0;

    // 2. Pausas por step (FunnelEvent exitType='paused')
    const pausesByStep = await prisma.funnelEvent.groupBy({
        by: ['stepTo'],
        where: { enteredAt: where, exitType: 'paused' },
        _count: true,
    });
    const pausesMap: Record<string, number> = {};
    pausesByStep.forEach((r: any) => { pausesMap[r.stepTo || '(null)'] = r._count; });

    // 3. Entradas y salidas por step para calcular % avance
    const [enters, exitsByType] = await Promise.all([
        prisma.funnelEvent.groupBy({
            by: ['stepTo'],
            where: { enteredAt: where },
            _count: true,
        }),
        prisma.funnelEvent.groupBy({
            by: ['stepTo', 'exitType'],
            where: { enteredAt: where, exitType: { not: null } },
            _count: true,
        }),
    ]);
    const entersMap: Record<string, number> = {};
    enters.forEach((r: any) => { entersMap[r.stepTo || '(null)'] = r._count; });

    // step -> { advanced, paused, dropped, back, completed }
    const exitsMap: Record<string, Record<string, number>> = {};
    exitsByType.forEach((r: any) => {
        const s = r.stepTo || '(null)';
        if (!exitsMap[s]) exitsMap[s] = {};
        exitsMap[s][r.exitType] = r._count;
    });

    // % pausas en preference/weight = pausas / entradas a ese step
    const pausePctPref = (entersMap['waiting_preference'] || 0) > 0
        ? ((pausesMap['waiting_preference'] || 0) / entersMap['waiting_preference']) * 100
        : 0;
    const pausePctWeight = (entersMap['waiting_weight'] || 0) > 0
        ? ((pausesMap['waiting_weight'] || 0) / entersMap['waiting_weight']) * 100
        : 0;

    // 4. Largo medio de respuestas del bot
    const botMsgs = await prisma.chatLog.findMany({
        where: { timestamp: where, role: 'bot' },
        select: { content: true },
    });
    const totalChars = botMsgs.reduce((s: number, m: any) => s + (m.content?.length || 0), 0);
    const avgBotLen = botMsgs.length > 0 ? totalChars / botMsgs.length : 0;

    return {
        window: w,
        newUsers,
        ordersAll,
        ordersNonCancelled,
        conversion,
        pausesMap,
        entersMap,
        exitsMap,
        pausePctPref,
        pausePctWeight,
        avgBotLen,
        botMsgCount: botMsgs.length,
    };
}

function pad(s: string | number, n: number, align: 'l' | 'r' = 'l'): string {
    const str = String(s);
    if (str.length >= n) return str;
    const pad = ' '.repeat(n - str.length);
    return align === 'l' ? str + pad : pad + str;
}

function fmtPct(n: number): string { return n.toFixed(1) + '%'; }
function fmtNum(n: number): string { return n.toLocaleString('es-AR'); }

function delta(a: number, b: number): string {
    if (a === 0 && b === 0) return '—';
    if (a === 0) return '+∞';
    const diff = ((b - a) / a) * 100;
    const sign = diff >= 0 ? '+' : '';
    return `${sign}${diff.toFixed(1)}%`;
}

function bar(pct: number, max: number = 100, width: number = 20): string {
    const filled = Math.round((pct / max) * width);
    return '█'.repeat(Math.min(filled, width)) + '·'.repeat(Math.max(0, width - filled));
}

async function main() {
    console.log(`\n╔════════════════════════════════════════════════════════════════════════╗`);
    console.log(`║  COMPARACIÓN PROMPT VIEJO vs NUEVO  (commit 80bdd82)`);
    console.log(`║  Generado: ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })} ART`);
    console.log(`╚════════════════════════════════════════════════════════════════════════╝\n`);

    const [a, b] = await Promise.all([metricsFor(baseline), metricsFor(postChange)]);

    console.log(`📅 VENTANAS`);
    console.log(`   A · ${baseline.label}`);
    console.log(`      ${baseline.from.toISOString()} → ${baseline.to.toISOString()}`);
    console.log(`   B · ${postChange.label}`);
    console.log(`      ${postChange.from.toISOString()} → ${postChange.to.toISOString()}\n`);

    // ── 1. Conversión ───────────────────────────────────────────────────────
    console.log(`📊 CONVERSIÓN`);
    console.log(`                              ${pad('A (viejo)', 18, 'r')}  ${pad('B (nuevo)', 18, 'r')}   Δ`);
    console.log(`   Chats nuevos              ${pad(fmtNum(a.newUsers), 18, 'r')}  ${pad(fmtNum(b.newUsers), 18, 'r')}   ${delta(a.newUsers, b.newUsers)}`);
    console.log(`   Pedidos (no cancelados)   ${pad(fmtNum(a.ordersNonCancelled), 18, 'r')}  ${pad(fmtNum(b.ordersNonCancelled), 18, 'r')}   ${delta(a.ordersNonCancelled, b.ordersNonCancelled)}`);
    console.log(`   Pedidos totales           ${pad(fmtNum(a.ordersAll), 18, 'r')}  ${pad(fmtNum(b.ordersAll), 18, 'r')}   ${delta(a.ordersAll, b.ordersAll)}`);
    console.log(`   Conversión %              ${pad(fmtPct(a.conversion), 18, 'r')}  ${pad(fmtPct(b.conversion), 18, 'r')}   ${delta(a.conversion, b.conversion)}`);

    // Veredicto principal
    const convDelta = b.conversion - a.conversion;
    console.log();
    if (Math.abs(convDelta) < 0.5) {
        console.log(`   ⚪ Sin diferencia significativa (Δ ${convDelta.toFixed(1)}pp)`);
    } else if (convDelta > 0) {
        console.log(`   🟢 Conversión SUBIÓ ${convDelta.toFixed(1)}pp — el split funciona`);
    } else {
        console.log(`   🔴 Conversión BAJÓ ${Math.abs(convDelta).toFixed(1)}pp — considerar revertir 80bdd82`);
    }

    // ── 2. Pausas en steps críticos ─────────────────────────────────────────
    console.log(`\n⏸️  PAUSAS (cliente quedó frenado, requiere intervención)`);
    console.log(`                              ${pad('A (viejo)', 18, 'r')}  ${pad('B (nuevo)', 18, 'r')}   Δ`);
    const stepsOfInterest = ['waiting_weight', 'waiting_preference', 'waiting_plan_choice', 'waiting_data'];
    stepsOfInterest.forEach(step => {
        const aP = a.pausesMap[step] || 0;
        const bP = b.pausesMap[step] || 0;
        const aE = a.entersMap[step] || 0;
        const bE = b.entersMap[step] || 0;
        const aPct = aE > 0 ? (aP / aE) * 100 : 0;
        const bPct = bE > 0 ? (bP / bE) * 100 : 0;
        const stepLabel = step.replace('waiting_', '').padEnd(20);
        console.log(`   ${stepLabel}      ${pad(`${aP} (${fmtPct(aPct)})`, 18, 'r')}  ${pad(`${bP} (${fmtPct(bPct)})`, 18, 'r')}   ${delta(aPct, bPct)}`);
    });

    // ── 3. Avance step→step ──────────────────────────────────────────────────
    console.log(`\n➡️  AVANCE STEP→STEP (% que avanzó vs total con exitType registrado)`);
    console.log(`                              ${pad('A advance%', 18, 'r')}  ${pad('B advance%', 18, 'r')}   Δ`);
    const allFlowSteps = [
        'greeting', 'waiting_weight', 'waiting_preference', 'waiting_plan_choice',
        'waiting_ok', 'waiting_data', 'waiting_maps_confirmation', 'waiting_payment_method',
        'waiting_final_confirmation'
    ];
    allFlowSteps.forEach(step => {
        const aE = a.exitsMap[step] || {};
        const bE = b.exitsMap[step] || {};
        const aTotal = Object.values(aE).reduce((s: number, n: any) => s + (n as number), 0);
        const bTotal = Object.values(bE).reduce((s: number, n: any) => s + (n as number), 0);
        const aAdv = (aE.advanced || 0);
        const bAdv = (bE.advanced || 0);
        const aPct = aTotal > 0 ? (aAdv / aTotal) * 100 : 0;
        const bPct = bTotal > 0 ? (bAdv / bTotal) * 100 : 0;
        if (aTotal === 0 && bTotal === 0) return;
        const stepLabel = step.padEnd(28);
        console.log(`   ${stepLabel.substring(0, 28)}  ${pad(fmtPct(aPct) + ` (${aAdv}/${aTotal})`, 18, 'r')}  ${pad(fmtPct(bPct) + ` (${bAdv}/${bTotal})`, 18, 'r')}   ${delta(aPct, bPct)}`);
    });

    // ── 4. Largo medio de respuestas del bot ─────────────────────────────────
    console.log(`\n📏 LARGO MEDIO RESPUESTAS DEL BOT`);
    console.log(`                              ${pad('A (viejo)', 18, 'r')}  ${pad('B (nuevo)', 18, 'r')}   Δ`);
    console.log(`   Mensajes del bot          ${pad(fmtNum(a.botMsgCount), 18, 'r')}  ${pad(fmtNum(b.botMsgCount), 18, 'r')}   ${delta(a.botMsgCount, b.botMsgCount)}`);
    console.log(`   Caracteres promedio       ${pad(a.avgBotLen.toFixed(0), 18, 'r')}  ${pad(b.avgBotLen.toFixed(0), 18, 'r')}   ${delta(a.avgBotLen, b.avgBotLen)}`);
    const lenDelta = b.avgBotLen - a.avgBotLen;
    console.log();
    if (lenDelta > 30) {
        console.log(`   📖 Respuestas más largas en promedio (+${lenDelta.toFixed(0)} chars) — el bot está usando el modo expandido`);
    } else if (lenDelta < -30) {
        console.log(`   📏 Respuestas más cortas en promedio (${lenDelta.toFixed(0)} chars) — el split cortó más de lo previsto`);
    } else {
        console.log(`   ⚪ Largo promedio similar (Δ ${lenDelta.toFixed(0)} chars)`);
    }

    // ── Veredicto final ──────────────────────────────────────────────────────
    console.log(`\n╔════════════════════════════════════════════════════════════════════════╗`);
    console.log(`║  VEREDICTO`);
    console.log(`╚════════════════════════════════════════════════════════════════════════╝`);
    if (convDelta >= 0.5) {
        console.log(`   ✅ MANTENER el prompt nuevo. Conversión subió ${convDelta.toFixed(1)}pp.`);
    } else if (convDelta <= -0.5) {
        console.log(`   ⚠️  REVERTIR el commit 80bdd82. Conversión bajó ${Math.abs(convDelta).toFixed(1)}pp.`);
        console.log(`      Comando: git revert 80bdd82`);
    } else {
        console.log(`   ⚪ INCONCLUSO. Movimiento de conversión dentro del ruido (Δ ${convDelta.toFixed(1)}pp).`);
        console.log(`      Mirá los otros indicadores para decidir.`);
    }
    console.log();
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
