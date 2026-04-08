/**
 * Seed script: creates the initial admin account.
 * Run with: npx tsx prisma/seed-admin.ts
 *
 * Env vars:
 *   SEED_ADMIN_EMAIL    — email for the admin account (default: admin@herbalis.com)
 *   SEED_ADMIN_PASSWORD — password for the admin account (required)
 *   DATABASE_URL        — PostgreSQL connection string
 *
 * This script is idempotent (uses upsert).
 */

import bcrypt from 'bcryptjs';

// Use the shared db module which has the PrismaPg adapter configured
const { prisma } = require('../db');

async function main() {
    const name = process.env.SEED_ADMIN_USERNAME || process.env.SEED_ADMIN_EMAIL || 'admin';
    const password = process.env.SEED_ADMIN_PASSWORD;

    if (!password) {
        console.error('ERROR: SEED_ADMIN_PASSWORD env var is required');
        process.exit(1);
    }

    const hashed = await bcrypt.hash(password, 10);

    const account = await prisma.account.upsert({
        where: { name },
        create: {
            name,
            password: hashed,
            role: 'admin',
            sellerId: null,
        },
        update: {
            password: hashed,
            role: 'admin',
            isActive: true,
        },
    });

    console.log(`Admin account ready: ${account.name} (id: ${account.id})`);

    // Seed a sample quick reply for any seller accounts that exist
    const sellers = await prisma.account.findMany({
        where: { role: 'seller', sellerId: { not: null } },
        select: { sellerId: true },
    });

    for (const seller of sellers) {
        await (prisma.quickReply as any).upsert({
            where: { instanceId_title: { instanceId: seller.sellerId!, title: '¡Gracias por tu consulta!' } },
            update: {},
            create: {
                instanceId: seller.sellerId!,
                title: '¡Gracias por tu consulta!',
                message: '¡Hola! Gracias por comunicarte con nosotros. En breve te respondemos 😊',
            },
        });
        console.log(`Sample quick reply created for seller: ${seller.sellerId}`);
    }
}

main()
    .catch((e) => {
        console.error('Seed failed:', e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
