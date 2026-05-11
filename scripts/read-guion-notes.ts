/**
 * Lee comentarios/notas/correcciones de un guión específico desde DB.
 * Uso: SCRIPT=v6 DATABASE_URL=... npx tsx scripts/read-guion-notes.ts
 */
const { prisma } = require('../db');

async function main() {
    const script = process.env.SCRIPT || 'v6';
    const comments = await prisma.guionComment.findMany({
        where: { script },
        orderBy: [{ sectionPath: 'asc' }, { createdAt: 'asc' }],
    });

    console.log(`\nGuión ${script} — ${comments.length} comentarios totales`);
    console.log(`(${comments.filter((c: any) => !c.resolved).length} sin resolver)\n`);

    const grouped: Record<string, any[]> = {};
    comments.forEach((c: any) => {
        const k = c.sectionPath;
        if (!grouped[k]) grouped[k] = [];
        grouped[k].push(c);
    });

    Object.entries(grouped).forEach(([section, list]) => {
        console.log(`\n━━━ ${section} ━━━`);
        list.forEach((c: any) => {
            const status = c.resolved ? '✓ RESUELTO' : '○';
            console.log(`\n  ${status} [${c.type}] ${c.authorName} · ${new Date(c.createdAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
            console.log(`  ${c.content.split('\n').map((l: string) => '  ' + l).join('\n')}`);
            if (c.suggestedText) {
                console.log(`\n  💡 Sugerido:`);
                console.log(`  ${c.suggestedText.split('\n').map((l: string) => '    ' + l).join('\n')}`);
            }
            const reactions = (() => { try { return JSON.parse(c.reactions || '[]'); } catch { return []; } })();
            if (reactions.length) {
                console.log(`  👍 ${reactions.length} (${reactions.map((r: any) => r.name).join(', ')})`);
            }
        });
    });
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
