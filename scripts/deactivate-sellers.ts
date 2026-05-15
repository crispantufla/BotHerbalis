/**
 * Da de baja vendedores permanentemente:
 *   1. Marca Account.isActive = false (en el próximo boot del bot no se carga)
 *   2. Borra fila de WhatsAppSession (estaban desconectadas igual)
 *   3. Conserva intactos: Order, User, ChatLog, BotConfig (data histórica)
 *
 * Para limpiar el filesystem (carpeta .wwebjs_auth en el volume), correr
 * después en Railway shell:
 *   rm -rf $DATA_DIR/alejandra $DATA_DIR/suzane
 *
 * Uso: DATABASE_URL=<url> npx tsx scripts/deactivate-sellers.ts
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000, max: 5 });

const SELLERS_TO_DEACTIVATE = ['alejandra', 'suzane'];

(async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
        console.log(`║  Dando de baja vendedores: ${SELLERS_TO_DEACTIVATE.join(', ')}`);
        console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

        // ── BEFORE ────────────────────────────────────────────────────────
        const accountsBefore = await client.query(
            `SELECT name, "sellerId", role, "isActive" FROM "Account" WHERE name = ANY($1)`,
            [SELLERS_TO_DEACTIVATE]
        );
        console.log(`📋 Estado actual de cuentas:`);
        accountsBefore.rows.forEach((r: any) =>
            console.log(`   ${r.name.padEnd(15)} role=${r.role.padEnd(8)} sellerId=${r.sellerId} isActive=${r.isActive}`)
        );

        const sessionsBefore = await client.query(
            `SELECT "sellerId", status, "phoneNumber", "lastSeen" FROM "WhatsAppSession" WHERE "sellerId" = ANY($1)`,
            [SELLERS_TO_DEACTIVATE]
        );
        console.log(`\n📱 Sesiones de WhatsApp actuales:`);
        if (sessionsBefore.rows.length === 0) console.log(`   (ninguna fila)`);
        sessionsBefore.rows.forEach((r: any) =>
            console.log(`   ${r.sellerId.padEnd(15)} status=${r.status.padEnd(12)} phone=${r.phoneNumber || '(null)'} lastSeen=${r.lastSeen?.toISOString?.()?.slice(0, 10) || '(null)'}`)
        );

        // Data histórica que conservamos
        const orders = await client.query(
            `SELECT "instanceId", COUNT(*)::int AS c FROM "Order" WHERE "instanceId" = ANY($1) GROUP BY "instanceId"`,
            [SELLERS_TO_DEACTIVATE]
        );
        const users = await client.query(
            `SELECT "instanceId", COUNT(*)::int AS c FROM "User" WHERE "instanceId" = ANY($1) GROUP BY "instanceId"`,
            [SELLERS_TO_DEACTIVATE]
        );
        console.log(`\n💾 Data histórica que se CONSERVA:`);
        SELLERS_TO_DEACTIVATE.forEach(s => {
            const o = orders.rows.find((r: any) => r.instanceId === s);
            const u = users.rows.find((r: any) => r.instanceId === s);
            console.log(`   ${s.padEnd(15)} ${o?.c || 0} órdenes · ${u?.c || 0} usuarios · (ChatLog + BotConfig también)`);
        });

        // ── APPLY ─────────────────────────────────────────────────────────
        console.log(`\n⚙️  Aplicando cambios...`);

        const updateRes = await client.query(
            `UPDATE "Account" SET "isActive" = false, "updatedAt" = NOW()
             WHERE name = ANY($1) RETURNING name, "isActive"`,
            [SELLERS_TO_DEACTIVATE]
        );
        console.log(`   ✓ ${updateRes.rowCount} Account(s) marcadas como inactivas:`);
        updateRes.rows.forEach((r: any) => console.log(`     - ${r.name} → isActive=${r.isActive}`));

        const deleteRes = await client.query(
            `DELETE FROM "WhatsAppSession" WHERE "sellerId" = ANY($1) RETURNING "sellerId"`,
            [SELLERS_TO_DEACTIVATE]
        );
        console.log(`   ✓ ${deleteRes.rowCount} fila(s) de WhatsAppSession borradas:`);
        deleteRes.rows.forEach((r: any) => console.log(`     - ${r.sellerId}`));

        // Confirmar
        await client.query('COMMIT');
        console.log(`\n✅ Cambios commiteados a la DB.`);

        console.log(`\n📋 Próximos pasos:`);
        console.log(`   1. En el próximo deploy / restart del bot, alejandra y suzane`);
        console.log(`      NO se cargarán al clientPool (porque Account.isActive=false).`);
        console.log(`   2. Para liberar el espacio en disco del volume de Railway, correr:`);
        console.log(`        rm -rf $DATA_DIR/alejandra $DATA_DIR/suzane`);
        console.log(`      (data histórica de ventas queda intacta en la DB)`);
        console.log(`\n   Reversible: si volvieran, basta con UPDATE Account SET isActive=true.`);
        console.log(`   La sesión de WhatsApp habría que escanearla de nuevo.\n`);

    } catch (e: any) {
        await client.query('ROLLBACK');
        console.error('\n❌ Error, rollback:', e.message);
        throw e;
    } finally {
        client.release();
        await pool.end();
    }
})();
