/**
 * Venta de prueba de punta a punta, sin tocar WhatsApp ni los datos reales.
 *
 * Corre el MISMO `processSalesFlow` que atiende a los clientes, con la IA de
 * verdad, y conduce la conversación como lo haría un cliente español: mira en
 * qué paso lo deja el bot y responde lo que tocaría en ese paso. Si el bot se
 * atasca, repite el paso o se sale del guion, aquí se ve.
 *
 * Cómo correrlo:
 *   railway run --service bot-es npx tsx scripts/venta-de-prueba.ts
 *       ↑ con el entorno de producción: usa Claude, igual que los clientes.
 *   npx tsx scripts/venta-de-prueba.ts
 *       ↑ solo con el .env local: cae a OpenAI. Sirve para probar el guion,
 *         NO para validar cómo responde la IA de producción.
 *
 * Aislamiento (calcado del playground, ver playground.routes.js):
 *   - sellerId='playground' → el logger del embudo se salta solo
 *   - saveOrderToLocal / notifyAdmin / logAndEmit se capturan en memoria
 *   - no se escribe ni una fila en la base ni se manda ningún WhatsApp
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const { processSalesFlow } = require('../src/flows/salesFlow');

const KNOWLEDGE = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'knowledge_v7.json'), 'utf8')
);

const USER_ID = 'ventaprueba@c.us';
const MAX_TURNOS = 30;

// `npx tsx scripts/venta-de-prueba.ts recogida` prueba la otra modalidad.
const MODO = process.argv[2] === 'recogida' ? 'recogida' : 'domicilio';

// Qué contesta el cliente en cada paso. Es una lista por paso: si el bot deja
// al cliente DOS veces en el mismo sitio (típico cuando falta un dato), la
// segunda respuesta da más detalle en vez de repetir lo mismo como un loro.
const GUION: Record<string, string[]> = {
    greeting: ['Hola, buenas tardes. He visto el anuncio y quería información'],
    waiting_weight: ['Quiero perder unos 10 kilos', 'Unos 10 kilos más o menos'],
    waiting_preference: ['Cápsulas', 'Las cápsulas, por favor'],
    waiting_plan_choice: ['El de 120 días', 'Me quedo con el tratamiento de 120 días'],
    waiting_ok: ['Vale, perfecto', 'Sí, adelante'],
    waiting_price_confirmation: ['Sí, me parece bien', 'De acuerdo con el precio'],
    waiting_data: [
        'Elena Ruiz Gómez, Calle Mayor 12, 3ºB, 28013 Madrid',
        'Elena Ruiz Gómez. Mi dirección es Calle Mayor número 12, piso 3ºB. El código postal es 28013 y la población es Madrid',
    ],
    waiting_maps_confirmation: ['Sí, esa es', 'Sí, correcta'],
    waiting_payment_method: MODO === 'recogida'
        ? ['2', 'La opción 2, la recojo en la oficina de Correos']
        : ['1', 'La opción 1, a domicilio'],
    waiting_final_confirmation: ['Sí, confirmo', 'Sí, todo correcto'],
};

// Donde termina una venta buena (o donde se corta si algo se tuerce).
const PASOS_FINALES = new Set([
    'completed', 'closing', 'post_sale', 'waiting_admin_validation', 'waiting_admin_ok',
    'rejected_medical', 'rejected_abusive', 'rejected_geo',
]);

function separador(txt: string) {
    console.log(`\n${'─'.repeat(70)}\n  ${txt}\n${'─'.repeat(70)}`);
}

async function main() {
    const pedidos: any[] = [];
    const avisosAdmin: string[] = [];
    const pausados = new Set<string>();

    const construirDeps = (respuestas: string[]) => ({
        saveState: () => {},
        sendMessageWithDelay: async (_uid: string, msg: string) => { respuestas.push(msg); },
        notifyAdmin: async (msg: string) => { avisosAdmin.push(msg); },
        aiService: require('../src/services/ai').aiService,
        logAndEmit: () => {},
        saveOrderToLocal: (order: any) => { pedidos.push(order); },
        cancelLatestOrder: async () => null,
        sharedState: {
            io: { to: () => ({ emit: () => {} }), emit: () => {} },
            pausedUsers: pausados,
            config: { activeScript: 'v7' },
            sellerId: 'playground',
            sessionAlerts: [],
        },
        config: { activeScript: 'v7', scriptStats: {} },
        effectiveScript: 'v7',
        sellerId: 'playground',
        client: { sendMessage: async () => {} },
    });

    const userState: Record<string, any> = {};
    const vecesEnPaso: Record<string, number> = {};

    separador(`VENTA DE PRUEBA (${MODO}) — guion V7 España, todo contra reembolso`);
    console.log(`  IA: ${process.env.ANTHROPIC_API_KEY ? 'Claude disponible (como producción)' : 'solo OpenAI (local)'}`);

    let mensaje: string | null = GUION.greeting[0];
    let pasoAnterior = '(nuevo)';

    for (let turno = 1; turno <= MAX_TURNOS && mensaje; turno++) {
        const respuestas: string[] = [];
        console.log(`\n\x1b[36m[Cliente]\x1b[0m ${mensaje}`);

        // Igual que el playground: el mensaje del cliente entra al history antes
        // de procesar, salvo en el primer turno (ahí lo crea processSalesFlow).
        if (userState[USER_ID]) {
            userState[USER_ID].history = userState[USER_ID].history || [];
            userState[USER_ID].history.push({ role: 'user', content: mensaje, timestamp: Date.now() });
        }

        try {
            await processSalesFlow(USER_ID, mensaje, userState, KNOWLEDGE, construirDeps(respuestas));
        } catch (e: any) {
            console.log(`\n\x1b[31m✗ EL FLUJO PETÓ:\x1b[0m ${e.message}`);
            console.log(e.stack);
            break;
        }

        for (const r of respuestas) console.log(`\x1b[32m[Bot]\x1b[0m ${r}`);
        if (respuestas.length === 0) console.log('\x1b[33m[Bot]\x1b[0m (no contestó nada)');

        const st = userState[USER_ID] || {};
        const paso = String(st.step || '(sin paso)');
        if (paso !== pasoAnterior) {
            console.log(`\x1b[90m       ${pasoAnterior} → ${paso}\x1b[0m`);
            pasoAnterior = paso;
        }

        if (pausados.has(USER_ID)) {
            console.log(`\n\x1b[33m⏸ El bot PAUSÓ al cliente y derivó a un humano.\x1b[0m`);
            break;
        }
        if (PASOS_FINALES.has(paso)) {
            console.log(`\n\x1b[32m✓ Fin del recorrido en "${paso}".\x1b[0m`);
            break;
        }

        vecesEnPaso[paso] = (vecesEnPaso[paso] || 0) + 1;
        if (vecesEnPaso[paso] > 3) {
            console.log(`\n\x1b[31m✗ ATASCADO: cuarta vuelta en "${paso}". Corto aquí.\x1b[0m`);
            break;
        }

        const opciones = GUION[paso];
        if (!opciones) {
            console.log(`\n\x1b[31m✗ Paso inesperado "${paso}" — no tengo respuesta de cliente para él.\x1b[0m`);
            break;
        }
        mensaje = opciones[Math.min(vecesEnPaso[paso] - 1, opciones.length - 1)];
    }

    const st = userState[USER_ID] || {};
    separador('RESULTADO');
    console.log(`  Paso final:  ${st.step}`);
    console.log(`  Producto:    ${st.selectedProduct || '—'}   Plan: ${st.selectedPlan || '—'}`);
    console.log(`  Total:       ${st.totalPrice ?? st.price ?? '—'}`);
    console.log(`  Dirección:   ${JSON.stringify(st.partialAddress || {})}`);
    console.log(`  Carrito:     ${JSON.stringify(st.cart || [])}`);

    if (pedidos.length) {
        separador(`PEDIDO REGISTRADO (${pedidos.length})`);
        for (const p of pedidos) console.log(JSON.stringify(p, null, 2));
    } else {
        console.log('\n  ⚠️ No se registró ningún pedido.');
    }

    if (avisosAdmin.length) {
        separador(`AVISOS AL ADMIN (${avisosAdmin.length})`);
        for (const a of avisosAdmin) console.log(`  • ${a.replace(/\n/g, '\n    ')}`);
    }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
