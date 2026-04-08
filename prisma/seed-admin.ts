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

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    const email = process.env.SEED_ADMIN_EMAIL || 'admin@herbalis.com';
    const password = process.env.SEED_ADMIN_PASSWORD;

    if (!password) {
        console.error('ERROR: SEED_ADMIN_PASSWORD env var is required');
        process.exit(1);
    }

    const hashed = await bcrypt.hash(password, 10);

    const account = await prisma.account.upsert({
        where: { email },
        create: {
            email,
            password: hashed,
            name: 'Admin',
            role: 'admin',
            sellerId: null,
        },
        update: {
            password: hashed,
            role: 'admin',
            isActive: true,
        },
    });

    console.log(`Admin account ready: ${account.email} (id: ${account.id})`);
}

main()
    .catch((e) => {
        console.error('Seed failed:', e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
