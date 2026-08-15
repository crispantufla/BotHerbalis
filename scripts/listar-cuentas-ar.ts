/**
 * Lista las cuentas del panel del bot ARGENTINO (solo lectura).
 *
 * Sirve para saber qué usuarios habría que replicar en España antes de
 * decidir cómo hacerlo. NO imprime el hash de la contraseña.
 *
 * Uso:  npx tsx scripts/listar-cuentas-ar.ts
 * Lee DATABASE_URL del .env del repo argentino (D:/Bot Whatsapp/.env).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

const AR_ENV = path.join('D:', 'Bot Whatsapp', '.env');

function leerUrlArgentina(): string {
    const raw = fs.readFileSync(AR_ENV, 'utf8');
    const m = raw.match(/^DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/m);
    if (!m) throw new Error(`No encontré DATABASE_URL en ${AR_ENV}`);
    return m[1];
}

async function main() {
    // Prisma 7 con adaptador pg (igual que db.js): la conexión se pasa por el
    // adaptador, no por `datasources`.
    const pool = new Pool({ connectionString: leerUrlArgentina(), max: 2 });
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    try {
        const cuentas = await prisma.account.findMany({
            select: { id: true, name: true, role: true, sellerId: true, isActive: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
        });
        console.log(`cuentas encontradas: ${cuentas.length}\n`);
        for (const c of cuentas) {
            console.log(
                `- ${c.name}  | rol: ${c.role}` +
                `  | sellerId: ${c.sellerId ?? '(ninguno → admin global)'}` +
                `  | ${c.isActive ? 'activa' : 'DESACTIVADA'}` +
                `  | alta: ${c.createdAt.toISOString().slice(0, 10)}`
            );
        }
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
