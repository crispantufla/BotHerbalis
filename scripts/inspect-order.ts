/**
 * Imprime los detalles completos de las órdenes asociadas a un teléfono.
 * Uso: DATABASE_URL=... npx tsx scripts/inspect-order.ts <phone>
 */
const { prisma } = require('../db');

const phone = process.argv[2];
if (!phone) {
    console.error('Uso: npx tsx scripts/inspect-order.ts <phone>');
    process.exit(1);
}

async function main() {
    const orders = await prisma.order.findMany({
        where: { userPhone: phone },
        orderBy: { createdAt: 'desc' },
    });

    if (orders.length === 0) {
        console.log(`Sin órdenes para teléfono ${phone}`);
        return;
    }

    orders.forEach((o: any, idx: number) => {
        console.log(`\n══ Orden #${idx + 1} ══════════════════════════════════════`);
        console.log(`  ID:             ${o.id}`);
        console.log(`  instanceId:     ${o.instanceId}    ← cuenta del bot que la creó`);
        console.log(`  seller (phone): ${o.seller || '(null)'}    ← número de WhatsApp que envió`);
        console.log(`  Status:         ${o.status}`);
        console.log(`  Producto:       ${o.products}`);
        console.log(`  Precio:         $${o.totalPrice}`);
        console.log(`  Pago:           ${o.paymentMethod || '(null)'}`);
        console.log(`  Postdated:      ${o.postdated || '(no)'}`);
        console.log(`  Tracking:       ${o.tracking || '(no)'}`);
        console.log(`  Cliente:        ${o.nombre || '(no)'}`);
        console.log(`  Dirección:      ${o.calle || '(no)'}, ${o.ciudad || '(no)'} ${o.cp || ''} ${o.provincia || ''}`);
        if (o.calleOriginal && o.calleOriginal !== o.calle) {
            console.log(`  Original (cliente escribió):  ${o.calleOriginal}`);
        }
        console.log(`  Creada:         ${o.createdAt.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
    });

    // Buscar info del seller
    const sellerIds = [...new Set(orders.map((o: any) => o.instanceId).filter(Boolean))];
    const sellerPhones = [...new Set(orders.map((o: any) => o.seller).filter(Boolean))];

    if (sellerIds.length > 0) {
        console.log(`\n══ Cuentas (instanceId) involucradas ══`);
        for (const sid of sellerIds) {
            const acc = await prisma.account.findFirst({ where: { sellerId: sid } });
            const wa = await prisma.whatsAppSession.findUnique({ where: { sellerId: sid as string } }).catch(() => null);
            console.log(`  ${sid}: ${acc ? `Cuenta activa "${acc.name}" (rol=${acc.role})` : '⚠️  cuenta BORRADA'}`);
            if (wa) console.log(`         WhatsApp session: ${wa.phoneNumber || 'sin número'} (status=${wa.status})`);
            else console.log(`         WhatsApp session: no encontrada`);
        }
    }

    if (sellerPhones.length > 0) {
        console.log(`\n══ Números de WhatsApp (campo seller) ══`);
        sellerPhones.forEach(p => console.log(`  ${p}`));
    }
}

main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
