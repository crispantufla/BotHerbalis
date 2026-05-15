require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });

(async () => {
    try {
        // BotConfig schema
        const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='BotConfig'`);
        console.log('=== BotConfig cols ===', cols.rows.map((r: any) => r.column_name).join(','));

        // Get all
        const r1 = await pool.query(`SELECT * FROM "BotConfig"`);
        console.log('\n=== BotConfig rows ===');
        r1.rows.forEach((r: any) => {
            console.log('---');
            Object.entries(r).forEach(([k, v]) => {
                const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
                console.log(`  ${k}: ${str.slice(0, 200)}`);
            });
        });

        // Account schema y vendedores
        const accCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='Account'`);
        console.log('\n=== Account cols ===', accCols.rows.map((r: any) => r.column_name).join(','));
        const r2 = await pool.query(`SELECT * FROM "Account" LIMIT 20`);
        console.log('\n=== Accounts ===');
        r2.rows.forEach((r: any) => {
            const fields = Object.entries(r).filter(([k]) => !['passwordHash', 'password'].includes(k));
            console.log(fields.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v).slice(0, 60)}`).join(' | '));
        });

        // WhatsAppSession (estado de las sesiones)
        try {
            const sCols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='WhatsAppSession'`);
            console.log('\n=== WhatsAppSession cols ===', sCols.rows.map((r: any) => r.column_name).join(','));
            const r3 = await pool.query(`SELECT * FROM "WhatsAppSession" LIMIT 20`);
            console.log('\n=== WhatsAppSession rows ===');
            r3.rows.forEach((r: any) => {
                console.log('---');
                Object.entries(r).forEach(([k, v]) => {
                    if (k === 'sessionData') return; // huge
                    const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
                    console.log(`  ${k}: ${str.slice(0, 120)}`);
                });
            });
        } catch (e: any) { console.log('WhatsAppSession err:', e.message); }

    } catch (e: any) {
        console.log('ERR', e.message);
    }
    await pool.end();
})();
