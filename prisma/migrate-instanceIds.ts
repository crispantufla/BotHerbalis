/**
 * One-time migration: rename old instanceIds to match new sellerIds.
 *
 * Run: railway run -s MainHerbalisBot -- npx tsx prisma/migrate-instanceIds.ts
 * Or locally with DATABASE_URL set.
 */
const { pool } = require('../db');

const MAPPING: [string, string][] = [
    ['bot_secundario', 'horacio'],
    ['bot_principal', 'ines'],
    ['bot_pablo', 'pablo'],
    ['bot_denis', 'denis'],
    ['bot_alejandra', 'alejandra'],
];

const TABLES = [
    '"User"',
    '"ChatMessage"',
    '"Order"',
    '"BotConfig"',
    '"PausedUser"',
    '"DailyStats"',
    '"QuickReply"',
    '"ConversationLog"',
];

async function migrate() {
    const client = await pool.connect();
    try {
        for (const [oldId, newId] of MAPPING) {
            console.log(`\n=== ${oldId} → ${newId} ===`);
            for (const table of TABLES) {
                try {
                    const res = await client.query(
                        `UPDATE ${table} SET "instanceId" = $1 WHERE "instanceId" = $2`,
                        [newId, oldId]
                    );
                    if (res.rowCount > 0) {
                        console.log(`  ${table}: ${res.rowCount} rows`);
                    }
                } catch (e: any) {
                    if (e.message.includes('does not exist')) continue;
                    console.log(`  ${table}: ERROR - ${e.message}`);
                }
            }
        }

        // Verify
        console.log('\n=== Verification ===');
        const orders = await client.query(`SELECT "instanceId", COUNT(*) as cnt FROM "Order" GROUP BY "instanceId" ORDER BY cnt DESC`);
        console.log('Orders:', orders.rows);
        const users = await client.query(`SELECT "instanceId", COUNT(*) as cnt FROM "User" GROUP BY "instanceId" ORDER BY cnt DESC`);
        console.log('Users:', users.rows);
    } finally {
        client.release();
        await pool.end();
    }
}

migrate().catch(e => { console.error('Migration failed:', e); process.exit(1); });
