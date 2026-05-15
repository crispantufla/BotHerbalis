/**
 * Acción 4: revisar los chats marcados como rechazo explícito en vendedores reales.
 * Filtra los chats de "terciario" (sin mensajes / datos de prueba).
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000, max: 5 });

function classify(text: string): 'HARD' | 'SOFT' | 'AMBIGUO' {
    const t = text.toLowerCase().trim();

    // HARD: hostilidad, "stop", "no molestes", "callate"
    if (/\b(no molestes|no me jodas|callate|cállate|stop|dejá de|deja de|no me escribas|jodete|andate|forro|pelot[ud]|hijo de|la concha|carajo|spam|deja en paz|no me hinchen|no me jodan|callat)\b/.test(t)) return 'HARD';
    if (/no me\s+(escribas|llames|hables|moleste)/.test(t)) return 'HARD';

    // SOFT: rechazo cortés, objeción económica/temporal — recuperable
    if (/^no\s+gracias\s*\.?\s*$/i.test(text.trim())) return 'SOFT';
    if (/\b(no gracias|no quiero (?:avanzar|seguir|continuar|nada)|no me convence|prefiero no|no por ahora|ahora no|no quiero comprar|por ahora no|no me interesa)\b/.test(t) && !/no me molestes/.test(t)) return 'SOFT';
    if (/\b(no tengo plata|sin plata|no tengo dinero|cuando cobre|más adelante|despu[ée]s te (contacto|escribo)|en otro momento|cuando pueda|me lo pienso|lo pienso|consultar|preguntar a|hablar con|otra cosa|m[aá]s barato)\b/.test(t)) return 'SOFT';

    return 'AMBIGUO';
}

async function main() {
    const users = await pool.query(`
        SELECT u.phone, u."instanceId", u."pausedAt", u."pauseReason"
        FROM "User" u
        WHERE u."pauseReason" ILIKE '%rechaz%explícitamente%'
           OR u."pauseReason" ILIKE '%rechazo%explicitamente%'
           OR u."pauseReason" ILIKE '%desistió del pedido%'
           OR u."pauseReason" ILIKE '%desistio del pedido%'
        ORDER BY u."pausedAt" DESC
    `);

    console.log(`\n╔═══════════════════════════════════════════════════════════════════╗`);
    console.log(`║  Acción 4 — Revisión de rechazos (${users.rows.length} totales en DB)`);
    console.log(`╚═══════════════════════════════════════════════════════════════════╝\n`);

    const buckets: Record<string, any[]> = { HARD: [], SOFT: [], AMBIGUO: [], TEST_DATA: [] };

    for (const u of users.rows) {
        const msgs = await pool.query(`
            SELECT role, content, "timestamp"
            FROM "ChatLog"
            WHERE "instanceId"=$1 AND "userPhone"=$2
            ORDER BY "timestamp" DESC
            LIMIT 8
        `, [u.instanceId, u.phone]);

        const ordered = msgs.rows.reverse();
        const userMsgs = ordered.filter((m: any) => m.role === 'user');
        const lastUserMsg = userMsgs[userMsgs.length - 1]?.content || '';

        // Filtro: chat sin mensajes del usuario o phone no parece real
        const isTestData = userMsgs.length === 0 || !/^\d{10,15}$/.test(u.phone);

        if (isTestData) {
            buckets.TEST_DATA.push({ ...u, lastUserMsg, ordered });
            continue;
        }

        // Usar el motivo de pausa si trae la frase entre comillas
        const reasonMatch = u.pauseReason.match(/"([^"]+)"/);
        const trigger = reasonMatch ? reasonMatch[1] : lastUserMsg;
        const klass = classify(trigger);
        buckets[klass].push({ ...u, trigger, ordered });
    }

    const fmt = (s: string, n: number) => (s || '').replace(/\s+/g, ' ').slice(0, n);

    const showBucket = (klass: string, items: any[]) => {
        const emoji = klass === 'HARD' ? '🔴' : klass === 'SOFT' ? '🟢' : klass === 'AMBIGUO' ? '🟡' : '⚪';
        const label = klass === 'HARD' ? 'RECHAZO DURO (dejar como está)'
                    : klass === 'SOFT' ? 'OBJECIÓN RECUPERABLE (ajustar bot)'
                    : klass === 'AMBIGUO' ? 'AMBIGUO (revisar caso por caso)'
                    : 'DATOS DE PRUEBA (ignorar)';
        console.log(`\n${emoji} ${label}  ·  ${items.length} chats`);
        console.log('─'.repeat(70));

        if (klass === 'TEST_DATA') {
            console.log(`   (chats sin mensajes del usuario o teléfonos de prueba — ignorados)`);
            console.log(`   instanceIds: ${[...new Set(items.map((x: any) => x.instanceId))].join(', ')}`);
            return;
        }

        items.forEach((it: any, i: number) => {
            const date = it.pausedAt?.toISOString?.()?.slice(0, 10) || '?';
            console.log(`\n${i + 1}. ${it.instanceId} · ${it.phone} · ${date}`);
            console.log(`   Disparador: "${fmt(it.trigger, 200)}"`);
            if (it.ordered.length > 0) {
                console.log(`   Contexto:`);
                it.ordered.slice(-5).forEach((m: any) => {
                    console.log(`     [${m.role}] ${fmt(m.content, 110)}`);
                });
            }
        });
    };

    showBucket('SOFT', buckets.SOFT);
    showBucket('HARD', buckets.HARD);
    showBucket('AMBIGUO', buckets.AMBIGUO);
    showBucket('TEST_DATA', buckets.TEST_DATA);

    // Resumen final
    const real = buckets.HARD.length + buckets.SOFT.length + buckets.AMBIGUO.length;
    console.log(`\n\n╔═══════════════════════════════════════════════════════════════════╗`);
    console.log(`║  RESUMEN EJECUTIVO`);
    console.log(`╚═══════════════════════════════════════════════════════════════════╝`);
    console.log(`   Total chats con flag rechazo:    ${users.rows.length}`);
    console.log(`   Datos de prueba (ignorar):       ${buckets.TEST_DATA.length}`);
    console.log(`   ─────────────────────────────────────`);
    console.log(`   Casos reales evaluables:         ${real}`);
    console.log(`     🔴 Rechazos duros:             ${buckets.HARD.length}`);
    console.log(`     🟢 Objeciones recuperables:    ${buckets.SOFT.length}`);
    console.log(`     🟡 Ambiguos:                   ${buckets.AMBIGUO.length}`);

    if (real > 0) {
        const recoverable = buckets.SOFT.length + Math.round(buckets.AMBIGUO.length / 2);
        const recoveryRate = (recoverable / real * 100).toFixed(0);
        console.log(`\n   📈 Estimación recuperables:      ~${recoverable}/${real} (${recoveryRate}%)`);
        console.log(`   💰 Si recuperás la mitad → +${Math.round(recoverable * 0.5)} ventas potenciales\n`);
    } else {
        console.log(`\n   ⚠️  No hay casos reales suficientes para concluir nada estadísticamente`);
        console.log(`      relevante. Pero los pocos casos son útiles como ejemplo cualitativo.\n`);
    }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => pool.end());
