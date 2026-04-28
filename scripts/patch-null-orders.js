/**
 * Patch órdenes con nombre=null que tengan datos rescatables en state.pendingOrder.
 * Ejecutar via: railway ssh --service MainHerbalisBot 'node scripts/patch-null-orders.js'
 *
 * También cancela duplicados creados con <60s de diferencia (mismo phone + instanceId).
 */
const { prisma } = require('../db');

(async () => {
    const since = new Date('2026-04-25T00:00:00Z');
    const nullOrders = await prisma.order.findMany({
        where: { createdAt: { gte: since }, nombre: null },
        orderBy: { createdAt: 'asc' },
        select: {
            id: true, instanceId: true, userPhone: true, nombre: true, calle: true,
            ciudad: true, provincia: true, cp: true, calleOriginal: true, status: true,
            products: true, totalPrice: true, paymentMethod: true, createdAt: true
        }
    });

    console.log(`Found ${nullOrders.length} orders with nombre=null since ${since.toISOString()}`);

    let patched = 0;
    let cancelled = 0;
    const seenWindowKey = new Map(); // `${phone}:${instanceId}` → first order in 60s window

    for (const o of nullOrders) {
        // Detect duplicates: another null-name order for same phone+seller within 60s before this one
        const key = `${o.userPhone}:${o.instanceId}`;
        const prevWinner = seenWindowKey.get(key);
        if (prevWinner && (o.createdAt.getTime() - prevWinner.createdAt.getTime()) < 60_000) {
            // Hard delete the duplicate — no ruido en el panel. El "ganador" (prevWinner)
            // queda como la unica orden visible.
            await prisma.order.delete({ where: { id: o.id } });
            console.log(`  [DUP] Deleted ${o.id.slice(0, 8)} (${o.userPhone}, +${Math.round((o.createdAt - prevWinner.createdAt) / 1000)}s)`);
            cancelled++;
            continue;
        }
        seenWindowKey.set(key, o);

        // Try to rescue address from User.profileData (state.pendingOrder)
        const user = await prisma.user.findUnique({
            where: { phone_instanceId: { phone: o.userPhone, instanceId: o.instanceId } }
        });
        if (!user?.profileData) {
            console.log(`  [NO-STATE] ${o.id.slice(0, 8)} (${o.userPhone}) — no profileData, skip`);
            continue;
        }

        let state;
        try { state = JSON.parse(user.profileData); } catch (e) { continue; }

        const pending = state.pendingOrder || {};
        const partial = state.partialAddress || {};

        const patchData = {};
        if (!o.nombre        && (pending.nombre        || partial.nombre))        patchData.nombre        = pending.nombre        || partial.nombre;
        if (!o.calle         && (pending.calle         || partial.calle))         patchData.calle         = pending.calle         || partial.calle;
        if (!o.ciudad        && (pending.ciudad        || partial.ciudad))        patchData.ciudad        = pending.ciudad        || partial.ciudad;
        if (!o.provincia     && (pending.provincia     || partial.provincia))     patchData.provincia     = pending.provincia     || partial.provincia;
        if (!o.cp            && (pending.cp            || partial.cp))            patchData.cp            = pending.cp            || partial.cp;
        if (!o.calleOriginal && (pending.calleOriginal || partial.calleOriginal)) patchData.calleOriginal = pending.calleOriginal || partial.calleOriginal;

        if (Object.keys(patchData).length === 0) {
            console.log(`  [NO-DATA] ${o.id.slice(0, 8)} (${o.userPhone}) — state has no rescuable address`);
            continue;
        }

        await prisma.order.update({ where: { id: o.id }, data: patchData });
        console.log(`  [PATCHED] ${o.id.slice(0, 8)} (${o.userPhone}) ← ${patchData.nombre || '?'} / ${patchData.calle || '?'} / ${patchData.ciudad || '?'}`);
        patched++;
    }

    console.log(`\nDone. Patched: ${patched}, Cancelled (duplicates): ${cancelled}, Skipped: ${nullOrders.length - patched - cancelled}`);
    await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
