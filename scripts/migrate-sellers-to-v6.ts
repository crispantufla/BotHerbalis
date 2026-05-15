/**
 * Migración 15-may-2026: fijar V6 como guion único para todos los sellers
 * activos. Salta sellers dados de baja (alejandra, suzane, nicolas).
 *
 * Política nueva:
 *   - activeScript = 'v6' para todos los sellers (default)
 *   - 'rotacion' sigue disponible como opción seleccionable manualmente
 *     desde el dashboard, pero NO es el default
 *   - Sellers legacy con v3/v4/v5 también pasan a v6
 *
 * Uso: DATABASE_URL=<url> npx tsx scripts/migrate-sellers-to-v6.ts
 */
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000, max: 5 });

(async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
        console.log(`║  Migración 15-may-2026: todos los sellers → V6 como default`);
        console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

        // ── ANTES ─────────────────────────────────────────────────────────
        const before = await client.query(`
            SELECT b."instanceId", b.value AS script
            FROM "BotConfig" b
            JOIN "Account" a ON a."sellerId" = b."instanceId" AND a."isActive" = true
            WHERE b.key = 'activeScript'
            ORDER BY b."instanceId"
        `);
        console.log(`📋 Estado actual de activeScript (sellers activos):`);
        before.rows.forEach((r: any) =>
            console.log(`   ${r.instanceId.padEnd(20)} ${r.script}`)
        );

        // ── APLICAR ───────────────────────────────────────────────────────
        // Sólo actualizar BotConfig de sellers en Account.isActive=true.
        // Esto excluye alejandra/suzane que dimos de baja antes.
        const updated = await client.query(`
            UPDATE "BotConfig" b
            SET value = '"v6"'
            FROM "Account" a
            WHERE b.key = 'activeScript'
              AND a."sellerId" = b."instanceId"
              AND a."isActive" = true
              AND b.value != '"v6"'
            RETURNING b."instanceId", b.value
        `);
        console.log(`\n✓ ${updated.rowCount} sellers migrados a v6:`);
        updated.rows.forEach((r: any) =>
            console.log(`   ${r.instanceId.padEnd(20)} → ${r.value}`)
        );

        // ── DESPUÉS ───────────────────────────────────────────────────────
        const after = await client.query(`
            SELECT b."instanceId", b.value AS script
            FROM "BotConfig" b
            JOIN "Account" a ON a."sellerId" = b."instanceId" AND a."isActive" = true
            WHERE b.key = 'activeScript'
            ORDER BY b."instanceId"
        `);
        console.log(`\n📋 Estado final:`);
        after.rows.forEach((r: any) =>
            console.log(`   ${r.instanceId.padEnd(20)} ${r.script}`)
        );

        await client.query('COMMIT');
        console.log(`\n✅ Cambios commiteados a la DB.`);
        console.log(`\n📋 Próximo paso:`);
        console.log(`   En el próximo restart del bot (o cambio de script desde el panel),`);
        console.log(`   todos los sellers usarán V6 para nuevos chats. Los chats existentes`);
        console.log(`   conservan el guion que ya tenían asignado (assignedScript en state).\n`);

    } catch (e: any) {
        await client.query('ROLLBACK');
        console.error('\n❌ Error, rollback:', e.message);
        throw e;
    } finally {
        client.release();
        await pool.end();
    }
})();
