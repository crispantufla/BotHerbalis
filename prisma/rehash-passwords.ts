/**
 * One-time: re-hash an account's password from a plaintext value supplied
 * via environment variables. Name is also lowercased for consistency.
 *
 * SECURITY NOTE: Never hardcode plaintext passwords in this file. Prior
 * revisions of this script stored production passwords in source — any such
 * credentials must be rotated.
 *
 * Usage (single account):
 *   ACCOUNT_NAME=cristian ACCOUNT_PASSWORD='newpass' npx tsx prisma/rehash-passwords.ts
 *
 * Usage (bulk, JSON map from env):
 *   PASSWORDS_JSON='{"cristian":"newpass","pablo":"anotherpass"}' npx tsx prisma/rehash-passwords.ts
 */
import bcrypt from 'bcryptjs';
const { prisma } = require('../db');

function _loadPasswordMap(): Record<string, string> {
    if (process.env.PASSWORDS_JSON) {
        try {
            const parsed = JSON.parse(process.env.PASSWORDS_JSON);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch (e) {
            throw new Error('PASSWORDS_JSON is set but is not valid JSON');
        }
    }
    const name = process.env.ACCOUNT_NAME;
    const pwd = process.env.ACCOUNT_PASSWORD;
    if (name && pwd) return { [name.toLowerCase()]: pwd };
    return {};
}

async function main() {
    const map = _loadPasswordMap();
    const keys = Object.keys(map);
    if (keys.length === 0) {
        console.error('No passwords provided. Set ACCOUNT_NAME+ACCOUNT_PASSWORD or PASSWORDS_JSON.');
        process.exit(1);
    }

    const accounts = await (prisma.account as any).findMany();
    for (const acc of accounts) {
        const nameLower = acc.name.toLowerCase();
        const pwd = map[nameLower];
        if (!pwd) {
            console.log(`skip ${acc.name}: no password provided`);
            continue;
        }
        const hashed = await bcrypt.hash(pwd, 10);
        await (prisma.account as any).update({
            where: { id: acc.id },
            data: { name: nameLower, password: hashed },
        });
        console.log(`updated ${acc.name} -> ${nameLower}`);
    }
}

main()
    .catch(e => { console.error('Failed:', e); process.exit(1); })
    .finally(() => prisma.$disconnect());
