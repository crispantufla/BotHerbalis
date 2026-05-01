/**
 * Hard-delete an account by name or sellerId.
 * - Deletes Account (cascade → AccountSession)
 * - Deletes WhatsAppSession for the account's sellerId
 * - Preserves Order, FunnelEvent, MessageEvent, User, ChatLog (tied by instanceId string, no FK)
 *
 * Run with: railway run npx tsx scripts/delete-denis.ts <name-or-sellerId> [--apply]
 * Without --apply: dry-run, just reports what would happen.
 */

const { prisma } = require('../db');

const args = process.argv.slice(2).filter(a => a !== '--apply');
const APPLY = process.argv.includes('--apply');
const TARGET = args[0];

if (!TARGET) {
    console.error('Usage: npx tsx scripts/delete-denis.ts <name-or-sellerId> [--apply]');
    process.exit(1);
}

async function main() {
    console.log(`Target: "${TARGET}"`);
    console.log(`Mode:   ${APPLY ? '⚠️  APPLY (will delete)' : '🔍 DRY-RUN (read-only)'}`);

    const accounts = await prisma.account.findMany({
        where: {
            OR: [
                { name: { equals: TARGET, mode: 'insensitive' } },
                { sellerId: TARGET.toLowerCase() },
            ],
        },
    });

    if (accounts.length === 0) {
        console.log(`✅ No account matching "${TARGET}" found. Nothing to do.`);
        return;
    }

    for (const acc of accounts) {
        console.log(`\nFound account: ${acc.name} | id=${acc.id} | sellerId=${acc.sellerId} | active=${acc.isActive}`);

        // Count what will be PRESERVED
        if (acc.sellerId) {
            const [orderCount, funnelCount, msgCount, userCount, chatCount, sessionCount] = await Promise.all([
                prisma.order.count({ where: { instanceId: acc.sellerId } }),
                prisma.funnelEvent.count({ where: { sellerId: acc.sellerId } }),
                prisma.messageEvent.count({ where: { sellerId: acc.sellerId } }),
                prisma.user.count({ where: { instanceId: acc.sellerId } }),
                prisma.chatLog.count({ where: { instanceId: acc.sellerId } }),
                prisma.accountSession.count({ where: { accountId: acc.id } }),
            ]);
            console.log(`  Preserved (kept after delete):`);
            console.log(`    - ${orderCount} orders`);
            console.log(`    - ${funnelCount} funnel events`);
            console.log(`    - ${msgCount} message events`);
            console.log(`    - ${userCount} users`);
            console.log(`    - ${chatCount} chat logs`);
            console.log(`  Cascade-deleted with Account:`);
            console.log(`    - ${sessionCount} account sessions`);

            const wsSession = await prisma.whatsAppSession.findUnique({ where: { sellerId: acc.sellerId } });
            console.log(`  WhatsAppSession: ${wsSession ? `exists (status=${wsSession.status}) → will delete` : 'none'}`);
        }

        if (APPLY) {
            console.log(`\n⚠️  Deleting...`);
            if (acc.sellerId) {
                await prisma.whatsAppSession.deleteMany({ where: { sellerId: acc.sellerId } });
                console.log(`  ✓ WhatsAppSession deleted`);
            }
            await prisma.account.delete({ where: { id: acc.id } });
            console.log(`  ✓ Account ${acc.name} deleted (AccountSession cascade)`);
        }
    }

    if (!APPLY) {
        console.log('\nDry-run complete. Re-run with --apply to actually delete.');
    } else {
        console.log('\n✅ Done.');
    }
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
