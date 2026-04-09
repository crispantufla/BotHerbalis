/**
 * One-time: re-hash all passwords as lowercase and ensure names are lowercase.
 * Run: railway run -s MainHerbalisBot -- npx tsx prisma/rehash-passwords.ts
 */
import bcrypt from 'bcryptjs';
const { prisma } = require('../db');

// Known passwords from the setup
const PASSWORDS: Record<string, string> = {
    'horacio': 'perrosanchez',
    'cristian': 'perrosanchez',
    'nicolas': 'perrosanchez',
    'pablo': '777164',
    'alejandra': '192404',
    'ines': '658025',
    'suzane': '719896',
    'denis': '724989',
};

async function main() {
    const accounts = await (prisma.account as any).findMany();
    for (const acc of accounts) {
        const nameLower = acc.name.toLowerCase();
        const pwd = PASSWORDS[nameLower];
        if (!pwd) {
            console.log(`⏭ ${acc.name}: no known password, skipping`);
            continue;
        }
        const hashed = await bcrypt.hash(pwd.toLowerCase(), 10);
        await (prisma.account as any).update({
            where: { id: acc.id },
            data: { name: nameLower, password: hashed },
        });
        console.log(`✅ ${acc.name} → ${nameLower} (password re-hashed lowercase)`);
    }
}

main()
    .catch(e => { console.error('Failed:', e); process.exit(1); })
    .finally(() => prisma.$disconnect());
