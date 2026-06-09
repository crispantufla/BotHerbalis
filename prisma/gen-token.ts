/**
 * gen-token.ts — Genera un JWT válido para un vendedor y lo escribe en agent/config.json
 * (campo apiToken), para que los botones del panel del agente llamen a la API.
 *
 *   npx tsx -r dotenv/config prisma/gen-token.ts horacio
 */
const { prisma } = require('../db');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

(async () => {
    const sellerId = process.argv[2] || 'horacio';
    const acc = await prisma.account.findFirst({
        where: { sellerId },
        select: { id: true, role: true, sellerId: true, name: true },
    });
    if (!acc) { console.error(`No encontré la cuenta con sellerId="${sellerId}"`); process.exit(1); }

    const secret = process.env.JWT_SECRET || process.env.API_KEY;
    if (!secret) { console.error('Falta JWT_SECRET (¿corriste con -r dotenv/config?)'); process.exit(1); }

    const token = jwt.sign(
        { accountId: acc.id, role: acc.role, sellerId: acc.sellerId, name: acc.name },
        secret,
        { expiresIn: '7d' }
    );

    const cfgPath = path.join(__dirname, '..', 'agent', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.apiToken = token;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

    console.log(`✅ apiToken (JWT de ${sellerId}, role=${acc.role}) escrito en agent/config.json — válido 7 días. (valor no mostrado)`);
    process.exit(0);
})().catch((e: any) => { console.error('Error:', e.message); process.exit(1); });
