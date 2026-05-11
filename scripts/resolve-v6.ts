/**
 * Marca como resueltos todos los comentarios pendientes del guión V6.
 * Uso: DATABASE_URL=... npx tsx scripts/resolve-v6.ts
 */
const { prisma } = require('../db');

(async () => {
    const r = await prisma.guionComment.updateMany({
        where: { script: 'v6', resolved: false },
        data: { resolved: true }
    });
    console.log('Comentarios V6 marcados como resueltos:', r.count);
    await prisma.$disconnect();
})();
