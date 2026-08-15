/**
 * Crea la PRIMERA cuenta de admin del panel, y solo esa.
 *
 * Por qué existe: `seed-admin.ts` es un script manual que hay que lanzar a
 * mano contra la base. En Railway la base solo es alcanzable desde dentro del
 * contenedor, así que en un despliegue nuevo nadie lo ejecuta nunca y el panel
 * arranca SIN ninguna cuenta con la que entrar (crear cuentas por la API exige
 * estar ya logueado como admin: el huevo y la gallina). Por eso esto corre en
 * el arranque, dentro de `npm start`.
 *
 * REGLA CLAVE: si ya existe alguna cuenta, no toca NADA y se va. Así, cuando
 * cambies tu contraseña desde el panel, el siguiente despliegue no te la pisa
 * con la de la variable de entorno.
 *
 * Variables:
 *   SEED_ADMIN_USERNAME — usuario para entrar (si falta, usa SEED_ADMIN_EMAIL)
 *   SEED_ADMIN_EMAIL    — alternativa al anterior
 *   SEED_ADMIN_PASSWORD — contraseña. Sin ella no crea nada (avisa y sigue).
 *
 * Nunca corta el arranque: si algo falla, avisa y deja que el bot siga.
 */

import bcrypt from 'bcryptjs';

const { prisma } = require('../db');

async function main() {
    const existentes = await prisma.account.count();
    if (existentes > 0) {
        console.log(`[BOOTSTRAP] Ya hay ${existentes} cuenta(s) — no toco nada.`);
        return;
    }

    const usuario = (process.env.SEED_ADMIN_USERNAME || process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD;

    if (!usuario || !password) {
        console.warn(
            '[BOOTSTRAP] ⚠️ No hay ninguna cuenta y faltan SEED_ADMIN_USERNAME/SEED_ADMIN_EMAIL ' +
            'y/o SEED_ADMIN_PASSWORD. El panel va a arrancar sin usuario con el que entrar. ' +
            'Define esas variables y vuelve a desplegar.'
        );
        return;
    }

    // El login busca por `name` en minúsculas (ver auth.routes), así que se
    // guarda ya normalizado o nunca encontraría la cuenta.
    const cuenta = await prisma.account.create({
        data: {
            name: usuario,
            password: await bcrypt.hash(password, 10),
            role: 'admin',
            sellerId: null,   // admin global: ve todos los vendedores
        },
        select: { id: true, name: true },
    });

    console.log(`[BOOTSTRAP] ✅ Cuenta de admin creada: "${cuenta.name}". Entra al panel y cámbiale la contraseña.`);
}

main()
    .catch((e) => {
        // A propósito no tumbamos el arranque: que el bot pueda atender aunque
        // el panel se quede sin cuenta es mejor que quedarse sin las dos cosas.
        console.error('[BOOTSTRAP] No se pudo crear la cuenta inicial:', e?.message || e);
    })
    .finally(() => prisma.$disconnect());
