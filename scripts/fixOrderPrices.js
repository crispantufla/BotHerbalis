/**
 * Migration: Fix corrupted totalPrice values in orders table.
 * 
 * Bug: parseFloat("52.900") treated the dot as decimal → stored 52.9 instead of 52900.
 * Fix: Multiply totalPrice by 1000 for all orders where totalPrice < 1000.
 * 
 * Usage: node scripts/fixOrderPrices.js
 *        node scripts/fixOrderPrices.js --dry-run   (preview only, no changes)
 */

require('dotenv').config();
const { prisma, pool } = require('../db');

async function main() {
    const dryRun = process.argv.includes('--dry-run');

    console.log(`\n🔧 Fix Order Prices Migration ${dryRun ? '(DRY RUN)' : ''}`);
    console.log('═'.repeat(50));

    // Find all orders with corrupted prices (< 1000 means it was divided by 1000)
    const corruptedOrders = await prisma.order.findMany({
        where: { totalPrice: { lt: 1000 } },
        orderBy: { createdAt: 'desc' }
    });

    if (corruptedOrders.length === 0) {
        console.log('\n✅ No corrupted prices found. All orders look correct.');
        return;
    }

    console.log(`\n⚠️  Found ${corruptedOrders.length} order(s) with totalPrice < 1000:\n`);

    for (const order of corruptedOrders) {
        const oldPrice = order.totalPrice;
        const newPrice = Math.round(oldPrice * 1000);

        console.log(`  📦 ${order.id} | ${order.nombre || 'Sin nombre'} | ${order.products}`);
        console.log(`     $${oldPrice} → $${newPrice.toLocaleString('es-AR')}`);

        if (!dryRun) {
            await prisma.order.update({
                where: { id: order.id },
                data: { totalPrice: newPrice }
            });
            console.log(`     ✅ Updated`);
        } else {
            console.log(`     ⏭️  Skipped (dry run)`);
        }
        console.log('');
    }

    console.log('═'.repeat(50));
    if (dryRun) {
        console.log(`\n🔍 DRY RUN complete. Run without --dry-run to apply changes.`);
    } else {
        console.log(`\n✅ Migration complete. ${corruptedOrders.length} order(s) fixed.`);
    }
}

main()
    .catch(e => { console.error('❌ Migration failed:', e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); await pool.end(); });
