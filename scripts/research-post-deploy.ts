/**
 * Análisis del modelo nuevo de pago (post deploy 2026-05-25 22:17).
 * Foco en patrones estructurales/recurrentes, no en el modelo viejo.
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const SINCE = new Date('2026-05-25T22:17:00-03:00');
const OUT_DIR = path.join(__dirname, '..', 'reports', 'research-2026-05-26');

async function q(sql: string, params: any[] = []) {
    return (await pool.query(sql, params)).rows;
}

async function main() {
    const lines: string[] = [];
    const log = (s: string = '') => lines.push(s);

    log(`╔════════════════════════════════════════════════════════════════╗`);
    log(`║ ANÁLISIS POST-DEPLOY MODELO RETIRO/DOMICILIO                   ║`);
    log(`║ Ventana: 2026-05-25 22:17 ART → ahora (${((Date.now() - +SINCE) / 36e5).toFixed(1)}h)`);
    log(`╚════════════════════════════════════════════════════════════════╝`);
    log('');

    // 1. Funnel
    const [{ users }] = await q(
        `SELECT COUNT(*)::int AS users FROM "User" WHERE "createdAt" >= $1`,
        [SINCE]
    );
    const [{ orders }] = await q(
        `SELECT COUNT(*)::int AS orders FROM "Order" WHERE "createdAt" >= $1 AND status != 'Cancelado'`,
        [SINCE]
    );
    log(`Usuarios nuevos: ${users}`);
    log(`Pedidos completados: ${orders}`);
    log(`Conversión: ${users ? ((orders / users) * 100).toFixed(2) : '—'}%`);
    log('');

    // Usuarios que llegaron al menu de pago (modelo nuevo)
    const reachedPayment = await q(
        `SELECT DISTINCT phone, "sellerId" FROM "FunnelEvent"
         WHERE "stepTo" = 'waiting_payment_method' AND "enteredAt" >= $1`,
        [SINCE]
    );
    log(`Usuarios que llegaron al menu de pago nuevo: ${reachedPayment.length}`);

    // Cuántos avanzaron a MP/transfer/admin_validation
    for (const next of ['waiting_mp_payment', 'waiting_transfer_confirmation', 'waiting_admin_validation', 'completed']) {
        const [{ c }] = await q(
            `SELECT COUNT(DISTINCT phone)::int AS c FROM "FunnelEvent"
             WHERE "stepTo" = $2 AND "enteredAt" >= $1`,
            [SINCE, next]
        );
        log(`  → ${next}: ${c}`);
    }
    log('');

    // 2. Bot responses con "anticipo" o "10.000" o "10000" POST-DEPLOY
    log('### MENSAJES BOT CON "anticipo" POST-DEPLOY (deberían ser 0)');
    const leaks = await q(
        `SELECT "instanceId", "userPhone", content, "timestamp"
         FROM "ChatLog"
         WHERE "timestamp" >= $1 AND role = 'bot'
         AND (content ILIKE '%anticipo%' OR content ILIKE '%$10.000%')
         ORDER BY "timestamp" DESC LIMIT 20`,
        [SINCE]
    );
    log(`Encontrados: ${leaks.length}`);
    leaks.forEach((l: any) => {
        log(`  [${new Date(l.timestamp).toISOString()}] ${l.instanceId} / ${l.userPhone}`);
        log(`    ${l.content.slice(0, 200)}`);
    });
    log('');

    // 3. Bot responses mencionando "4 a 6" o "7 a 10" — ventanas viejas
    log('### MENSAJES BOT CON "4 a 6" o "7 a 10" días POST-DEPLOY (deberían ser 0 — solo "5 a 7")');
    const oldEta = await q(
        `SELECT "instanceId", content, "timestamp"
         FROM "ChatLog"
         WHERE "timestamp" >= $1 AND role = 'bot'
         AND (content ILIKE '%4 a 6%' OR content ILIKE '%7 a 10%')
         ORDER BY "timestamp" DESC LIMIT 10`,
        [SINCE]
    );
    log(`Encontrados: ${oldEta.length}`);
    oldEta.forEach((l: any) => {
        log(`  [${new Date(l.timestamp).toISOString()}] ${l.instanceId}`);
        log(`    ${l.content.slice(0, 200)}`);
    });
    log('');

    // 4. Pausas post-deploy
    log('### PAUSAS POST-DEPLOY');
    const pausas = await q(
        `SELECT "pauseReason", COUNT(*)::int AS c
         FROM "User" WHERE "pausedAt" >= $1
         GROUP BY "pauseReason" ORDER BY c DESC`,
        [SINCE]
    );
    pausas.forEach((p: any) => {
        log(`  ${(p.pauseReason || '(null)').slice(0, 80).padEnd(82)} ${p.c}`);
    });
    log('');

    // 5. Toda conversación de un user que llegó al menu nuevo (muestra)
    log('### MUESTRA DE 15 CONVERSACIONES POST-DEPLOY QUE TOCARON EL MENU NUEVO');
    log('   (filtrando seller terciario que son tests)');
    log('');

    for (const u of reachedPayment.filter((u: any) => u.sellerId !== 'terciario').slice(0, 15)) {
        const msgs = await q(
            `SELECT role, content, "timestamp" FROM "ChatLog"
             WHERE "userPhone" = $1 AND "instanceId" = $2 AND "timestamp" >= $3
             ORDER BY "timestamp" ASC`,
            [u.phone, u.sellerId, SINCE]
        );
        if (msgs.length === 0) continue;
        log(`────────────────────────────────────────────────────────────────────`);
        log(`Phone: ${u.phone}  Seller: ${u.sellerId}  Msgs: ${msgs.length}`);
        msgs.forEach((m: any) => {
            const role = m.role.padEnd(5);
            log(`  [${role}] ${String(m.content || '').replace(/\n/g, ' ').slice(0, 220)}`);
        });
    }

    const out = lines.join('\n');
    const f = path.join(OUT_DIR, 'post-deploy-report.txt');
    fs.writeFileSync(f, out);
    console.log(`Reporte escrito: ${f}`);
}

main().catch(console.error).finally(() => pool.end());
