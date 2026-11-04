/**
 * Simulación de punta a punta del guion de venta de Club Herbys (28-oct) con el
 * flujo real (processSalesFlow) y la IA simulada: saludo con "¿te paso los
 * precios?", lista de precios, elección, localidad y cierre en zona (pago al
 * recibir) y fuera de zona (Correo con transferencia previa, 4 días).
 * SIM_PRINT=1 imprime las conversaciones.
 */
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../src/services/funnelLogger', () => {
    const actual = jest.requireActual('../src/services/funnelLogger');
    return Object.fromEntries(Object.keys(actual).map((k) => [k, typeof actual[k] === 'function' ? jest.fn().mockResolvedValue(undefined) : actual[k]]));
});
jest.mock('../db', () => ({
    prisma: {
        order: { create: jest.fn().mockResolvedValue({ id: 'o1' }), findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
        user: { upsert: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue(null) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
        paymentLink: { create: jest.fn(), findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
        promoRecipient: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
    },
}));
jest.mock('../src/services/pauseService', () => ({
    pauseUser: jest.fn(async (userId, reason, { sharedState }) => { sharedState.pausedUsers.add(userId); }),
    unpauseUser: jest.fn(),
}));
jest.mock('../src/services/ai', () => ({
    aiService: {
        chat: jest.fn().mockResolvedValue({ response: '[IA] (respuesta libre)', goalMet: false, extractedData: null }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        // "Nombre Apellido, Calle 123[, Ciudad][, CP 2000]"
        parseAddress: jest.fn(async (t) => {
            const parts = String(t).split(',').map((x) => x.trim());
            const out = {};
            if (parts[0] && !/\d/.test(parts[0])) out.nombre = parts[0];
            if (parts[1] && /\d/.test(parts[1])) out.calle = parts[1];
            if (parts[2]) out.ciudad = parts[2];
            const cp = String(t).match(/\bcp\s*(\d{4})\b/i); if (cp) out.cp = cp[1];
            return out;
        }),
    },
}));

const fs = require('fs');
const path = require('path');
const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v7.json'), 'utf8'));
const { processSalesFlow } = require('../src/flows/salesFlow');
const { createInitialUserState } = require('../src/flows/leadClassifier');
const { _getPrice } = require('../src/flows/utils/pricing');
const priceRe = (p) => new RegExp('\\$' + String(p).replace(/\./g, '\\.'));
const { aiService } = require('../src/services/ai');

async function simulate(name, lines) {
    const USER = '5493415550123@c.us';
    const us = {};
    const log = [];
    const sent = [], alerts = [], orders = [];
    const sharedState = { pausedUsers: new Set(), userState: us, io: null, saveState: jest.fn(), config: { alertNumbers: [], mpEnabled: false }, sessionAlerts: [] };
    const d = {
        saveState: jest.fn(),
        sendMessageWithDelay: jest.fn(async (u, m) => { sent.push(m); log.push(`🤖 ${m}`); us[u]?.history?.push({ role: 'bot', content: m }); return true; }),
        notifyAdmin: jest.fn(async (title, u, body) => { alerts.push({ title, body }); log.push(`   ⚑ AVISO A HORACIO: ${title} | ${String(body).replace(/\n/g, ' · ')}`); }),
        saveOrderToLocal: jest.fn((o) => { orders.push(o); log.push(`   ⚑ PEDIDO GUARDADO: ${o.producto} ${o.plan} $${o.precio} · ${o.paymentMethod || ''}`); }),
        aiService, sellerId: 'horacio', sharedState, config: { alertNumbers: [], mpEnabled: false }, logAndEmit: jest.fn(),
    };
    us[USER] = createInitialUserState({ step: 'greeting' });
    for (const line of lines) {
        log.push(`👤 ${line}`);
        if (sharedState.pausedUsers.has(USER)) { log.push('   (chat pausado: el bot no contesta)'); continue; }
        await processSalesFlow(USER, line, us, knowledge, d);
    }
    const st = us[USER];
    if (process.env.SIM_PRINT) console.log(`\n===== ${name} =====\n` + log.join('\n\n') + `\n\n[estado final: ${st.step} · zona ${st.deliveryZone} · pago ${st.paymentMethod} · total $${st.totalPrice}]`);
    return { sent, alerts, orders, st, log };
}

beforeEach(() => jest.clearAllMocks());

test('Rosario y zona: precios → gotas 60 → Funes → datos → confirma (pago al recibir)', async () => {
    const r = await simulate('EN ZONA (Funes)', ['Hola, quiero info', 'si', 'las gotas de 60', 'Soy de Funes', 'Ana Gómez, San Martín 1450', 'si']);
    const all = r.sent.join('\n');
    expect(r.sent[0]).toMatch(/Te paso los precios/);
    expect(r.sent[0]).not.toMatch(/cuánto te gustaría bajar/);
    expect(r.sent[1]).toMatch(priceRe(_getPrice('Gotas', '60')));
    expect(all).not.toMatch(/60 o 120/);           // ya dijo el plan
    expect(all).toMatch(/de qué localidad/);
    expect(all).toMatch(/reparto propio/);
    expect(r.orders).toHaveLength(1);
    expect(r.st.paymentMethod).toBe('contrarembolso');
    expect(r.st.totalPrice).toBe(_getPrice('Gotas', '60'));
    expect(r.alerts.some((a) => /VENTA CERRADA|PEDIDO NUEVO/.test(a.title))).toBe(true);
});

test('Semillas de 120: no pregunta el plan', async () => {
    const r = await simulate('SEMILLAS', ['hola', 'dale', 'semillas de 120', 'Rosario']);
    const all = r.sent.join('\n');
    expect(all).not.toMatch(/60 o 120/);
    expect(all).toMatch(/Semillas.*120 días/s);
    expect(r.st.selectedPlan).toBe('120');
    expect(r.st.totalPrice).toBe(_getPrice('Semillas', '120'));
});

test('Fuera de zona: Correo, transferencia previa, 4 días', async () => {
    const r = await simulate('FUERA DE ZONA (Córdoba)', ['Hola', 'si', 'capsulas 120', 'Soy de Córdoba capital', 'a domicilio', 'Laura Pérez, Av. Colón 1234, Córdoba, CP 5000', 'listo, ya transferí']);
    const all = r.sent.join('\n');
    expect(all).toMatch(/Correo Argentino/);
    expect(all).toMatch(/4 días hábiles/);
    expect(all).toMatch(/transferencia/i);
    expect(all).not.toMatch(/tarjeta de crédito|link de pago|Mercado Pago/i);
    expect(r.st.totalPrice).toBe(_getPrice('Cápsulas', '120'));
    expect(all).toMatch(/datos para el envío/);
    expect(all).toMatch(/Anotado, Laura/);
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0]).toMatchObject({ paymentMethod: 'transferencia', status: 'Pendiente', cp: '5000' });
    expect(r.alerts.map((a) => a.title)).toEqual([expect.stringMatching(/PEDIDO NUEVO — Correo/), expect.stringMatching(/Avisó que transfirió/)]);
    expect(r.st.correoOrderSaved).toBe(true);
});
