/**
 * deactivate-sellers.ts — Desactiva (isActive=false) los vendedores indicados.
 * No borra datos; solo deja de arrancarlos en el próximo boot.
 *
 *   npx tsx prisma/deactivate-sellers.ts ines pablo
 */
const { prisma } = require('../db');

(async () => {
    const targets = process.argv.slice(2);
    if (!targets.length) { console.error('Pasá los sellerId a desactivar. Ej: npx tsx prisma/deactivate-sellers.ts ines pablo'); process.exit(1); }

    const before = await prisma.account.findMany({
        where: { sellerId: { not: null } },
        select: { name: true, sellerId: true, role: true, isActive: true },
        orderBy: { sellerId: 'asc' },
    });
    console.log('ANTES:\n' + before.map((a: any) => `  ${a.isActive ? '🟢' : '🔴'} ${a.sellerId} (${a.name}, ${a.role})`).join('\n'));

    const res = await prisma.account.updateMany({ where: { sellerId: { in: targets } }, data: { isActive: false } });
    console.log(`\n→ Desactivadas ${res.count} cuenta(s) con sellerId en [${targets.join(', ')}]\n`);

    const after = await prisma.account.findMany({
        where: { sellerId: { not: null } },
        select: { name: true, sellerId: true, isActive: true },
        orderBy: { sellerId: 'asc' },
    });
    console.log('DESPUÉS:\n' + after.map((a: any) => `  ${a.isActive ? '🟢' : '🔴'} ${a.sellerId} (${a.name})`).join('\n'));
    process.exit(0);
})().catch((e: any) => { console.error('Error:', e.message); process.exit(1); });
