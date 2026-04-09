/**
 * One-time seed: creates Horacio's admin account and registers the WhatsApp session slot.
 *
 * Run against Railway DB:
 *   DATABASE_URL="postgresql://..." npx tsx prisma/seed-horacio.ts
 *
 * Or locally if .env already points to the correct DB:
 *   npx tsx prisma/seed-horacio.ts
 */

import bcrypt from 'bcryptjs';
const { prisma } = require('../db');

const SELLER_ID = 'horacio';
const NAME = 'Horacio';
const PASSWORD = 'perrosanchez';
const ROLE = 'admin';

async function main() {
    const hashed = await bcrypt.hash(PASSWORD, 10);

    const account = await (prisma.account as any).upsert({
        where: { name: NAME },
        create: {
            name: NAME,
            password: hashed,
            role: ROLE,
            sellerId: SELLER_ID,
            isActive: true,
        },
        update: {
            password: hashed,
            role: ROLE,
            sellerId: SELLER_ID,
            isActive: true,
        },
    });

    console.log(`Account ready: ${account.name} | role: ${account.role} | sellerId: ${account.sellerId}`);

    // Register WhatsApp session slot so the clientPool knows this seller exists
    await (prisma.whatsAppSession as any).upsert({
        where: { sellerId: SELLER_ID },
        create: { sellerId: SELLER_ID, status: 'disconnected' },
        update: {},
    });

    console.log(`WhatsApp session slot registered for sellerId: ${SELLER_ID}`);
}

main()
    .catch((e) => { console.error('Seed failed:', e); process.exit(1); })
    .finally(() => prisma.$disconnect());
