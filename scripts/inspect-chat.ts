/**
 * Imprime el ChatLog completo + el estado actual + los FunnelEvents recientes
 * para un teléfono dado.
 * Uso: DATABASE_URL=... npx tsx scripts/inspect-chat.ts <phone> [hours]
 */
const { prisma } = require('../db');

const phone = process.argv[2];
const hours = parseInt(process.argv[3] || '48', 10);

if (!phone) {
    console.error('Uso: npx tsx scripts/inspect-chat.ts <phone> [hours=48]');
    process.exit(1);
}

async function main() {
    const since = new Date(Date.now() - hours * 3600 * 1000);

    const users = await prisma.user.findMany({
        where: { phone },
        select: { phone: true, instanceId: true, createdAt: true, name: true, lastSeen: true, profileData: true },
    });
    console.log(`\n👤 USUARIOS encontrados con phone=${phone}:`);
    users.forEach((u: any) => {
        console.log(`  • instanceId=${u.instanceId} | createdAt=${u.createdAt.toISOString()} | name=${u.name || '?'} | lastSeen=${u.lastSeen?.toISOString() || '?'}`);
        if (u.profileData) {
            console.log(`    profileData: ${JSON.stringify(u.profileData)}`);
        }
    });

    if (users.length === 0) {
        console.log('  (ninguno)');
        return;
    }

    for (const u of users) {
        console.log(`\n══════════════════════════════════════════════════════════════════`);
        console.log(`  CHAT LOG — ${u.instanceId} / ${phone}  (últimas ${hours}h)`);
        console.log(`══════════════════════════════════════════════════════════════════`);

        const logs = await prisma.chatLog.findMany({
            where: { userPhone: phone, instanceId: u.instanceId, timestamp: { gte: since } },
            orderBy: { timestamp: 'asc' },
        });

        if (logs.length === 0) {
            console.log('  (sin mensajes en la ventana)');
        } else {
            logs.forEach((l: any) => {
                const t = l.timestamp.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
                const who = l.role === 'bot' ? '🤖 BOT' : l.role === 'admin' ? '👨 ADMIN' : '👤 USER';
                const content = (l.content || '').replace(/\n/g, '\n         ');
                console.log(`\n[${t}] ${who}`);
                console.log(`         ${content}`);
            });
        }

        console.log(`\n──────────────────────────────────────────────────────────────────`);
        console.log(`  FUNNEL EVENTS — ${u.instanceId} / ${phone}`);
        console.log(`──────────────────────────────────────────────────────────────────`);
        const evs = await prisma.funnelEvent.findMany({
            where: { phone, sellerId: u.instanceId, enteredAt: { gte: since } },
            orderBy: { enteredAt: 'asc' },
        });
        if (evs.length === 0) {
            console.log('  (sin eventos en la ventana)');
        } else {
            evs.forEach((e: any) => {
                const t = e.enteredAt.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
                const exit = e.exitedAt ? ` → exit=${e.exitType || '?'} a las ${e.exitedAt.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}` : ' (abierto)';
                console.log(`  [${t}] ${e.stepFrom || '∅'} → ${e.stepTo}  | msgs=${e.messageCount} aiCalls=${e.aiCallCount}${exit}`);
            });
        }

        console.log(`\n──────────────────────────────────────────────────────────────────`);
        console.log(`  ÓRDENES — ${u.instanceId} / ${phone}`);
        console.log(`──────────────────────────────────────────────────────────────────`);
        const orders = await prisma.order.findMany({
            where: { userPhone: phone, instanceId: u.instanceId },
            orderBy: { createdAt: 'desc' },
        });
        if (orders.length === 0) {
            console.log('  (sin órdenes)');
        } else {
            orders.slice(0, 5).forEach((o: any) => {
                console.log(`  • ${o.createdAt.toISOString()} | ${o.status} | ${o.products} | $${o.totalPrice} | ${o.paymentMethod || '?'}`);
                if (o.calle || o.ciudad) {
                    console.log(`    Dirección: ${o.calle || '?'}, ${o.ciudad || '?'} ${o.cp || ''} ${o.provincia || ''}`);
                }
                if (o.calleOriginal && o.calleOriginal !== o.calle) {
                    console.log(`    Original (raw): ${o.calleOriginal}`);
                }
            });
        }
    }
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
