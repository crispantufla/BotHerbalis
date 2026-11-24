/**
 * SIMULADOR DE CLIENTES — el flujo real del bot contra clientes hechos por IA.
 *
 * Cada PERSONAJE (tests/sim/personas.js) es un cliente difícil: una IA (Haiku)
 * escribe sus mensajes como en WhatsApp y el bot le contesta con el flujo real
 * (processSalesFlow + Claude de producción + clasificador de intención). Nada
 * sale a WhatsApp ni se escribe en la base: los envíos, los pedidos, los avisos y
 * la DB son de mentira.
 *
 * Por cada charla corren CHEQUEOS AUTOMÁTICOS (tests/sim/checks.js): mensajes
 * repetidos, localidad preguntada de más, precios que no están en la lista, la
 * palabra "bot", derivar al médico, cliente sin respuesta, y lo que el personaje
 * declare (no debe cerrarse un pedido, solo gotas, etc.). Después el JUEZ (el
 * mismo prompt del reporte diario) lee todas las charlas.
 *
 * ⚠️ GATED: solo corre con RUN_LLM_SIMS=1 y ANTHROPIC_API_KEY. Gasta saldo de
 * Anthropic (~US$0,10 por charla).
 *
 *   export ANTHROPIC_API_KEY="$(railway variables -s MainHerbalisBot --kv | grep '^ANTHROPIC_API_KEY=' | cut -d= -f2-)"
 *   RUN_LLM_SIMS=1 npx jest tests/customer_sim.live.test.js --forceExit
 *
 * Variables: SIM_ONLY=id1,id2 (solo esos personajes) · SIM_REPEAT=2 (cada uno N
 * veces) · SIM_CONCURRENCY=4 · SIM_OUT=<carpeta> (default sim-output/, ignorada por git).
 */
process.env.CLAUDE_AB_SELLERS = '*';
process.env.CLAUDE_AB_PERCENT = '100';
process.env.SISTEMA_AUTO_PUSH = '0';

jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }));
jest.mock('../src/services/queueService', () => ({ redisConnection: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn() } }));
jest.mock('../src/services/funnelLogger', () => {
    const actual = jest.requireActual('../src/services/funnelLogger');
    return Object.fromEntries(Object.keys(actual).map((k) => [k, typeof actual[k] === 'function' ? jest.fn().mockResolvedValue(undefined) : actual[k]]));
});
// Base de mentira: cualquier modelo.método contesta vacío. Nada se lee ni se escribe en prod.
jest.mock('../db', () => {
    const model = new Proxy({}, {
        get: (_t, method) => async () => {
            const m = String(method);
            if (/^findMany|groupBy/.test(m)) return [];
            if (/^count/.test(m)) return 0;
            if (/^(create|update|upsert)/.test(m)) return { id: 'sim' };
            return null;
        },
    });
    return { prisma: new Proxy({}, { get: (_t, p) => (p === '$queryRawUnsafe' || p === '$queryRaw' ? async () => [] : p === 'then' ? undefined : model) }) };
});
jest.mock('../src/services/pauseService', () => ({
    pauseUser: jest.fn(async (userId, reason, { sharedState }) => { sharedState.pausedUsers.add(userId); sharedState._pauseReasons = sharedState._pauseReasons || {}; sharedState._pauseReasons[userId] = reason; }),
    unpauseUser: jest.fn(),
}));
// Siempre en horario de atención: de noche las pausas mandan otro mensaje y la charla no es comparable.
jest.mock('../src/services/timeUtils', () => ({ ...jest.requireActual('../src/services/timeUtils'), isBusinessHours: () => true }));
jest.mock('mercadopago', () => ({
    MercadoPagoConfig: function () {},
    Preference: function () { this.create = async () => ({ id: 'pref-sim', init_point: 'https://mpago.la/sim-link' }); },
    Payment: function () { this.search = async () => ({ results: [] }); this.get = async () => ({}); },
}), { virtual: true });

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const RUN = process.env.RUN_LLM_SIMS === '1' && !!process.env.ANTHROPIC_API_KEY;
const d = RUN ? describe : describe.skip;
jest.setTimeout(45 * 60 * 1000);

d('simulador de clientes (IA real)', () => {
    test('personajes contra el flujo real + chequeos + juez', async () => {
        const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge_v7.json'), 'utf8'));
        const { processSalesFlow } = require('../src/flows/salesFlow');
        const { createInitialUserState } = require('../src/flows/leadClassifier');
        const { classifyMessage } = require('../src/services/intentClassifier');
        const { aiService } = require('../src/services/ai');
        const { runNightlyReview } = require('../src/services/nightlyReview');
        const { PERSONAS } = require('./sim/personas');
        const { runChecks } = require('./sim/checks');
        const Anthropic = require('@anthropic-ai/sdk');
        const anthropic = new (Anthropic.default || Anthropic)({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000 });

        const only = (process.env.SIM_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
        const repeat = Math.max(1, parseInt(process.env.SIM_REPEAT || '1', 10) || 1);
        const concurrency = Math.max(1, parseInt(process.env.SIM_CONCURRENCY || '4', 10) || 4);
        const outDir = process.env.SIM_OUT || path.join(__dirname, '..', 'sim-output');
        fs.mkdirSync(outDir, { recursive: true });

        const jobs = [];
        for (const p of PERSONAS) {
            if (only.length && !only.includes(p.id)) continue;
            for (let i = 0; i < repeat; i++) jobs.push({ persona: p, run: i + 1 });
        }

        // ── El cliente: Haiku escribe el próximo mensaje según el personaje ──────
        async function nextCustomerMessage(persona, log) {
            const convo = log.filter((l) => l.role === 'user' || l.role === 'bot')
                .map((l) => `${l.role === 'user' ? 'VOS' : 'VENDEDORA'}: ${l.content}`).join('\n');
            const r = await anthropic.messages.create({
                model: process.env.SIM_CUSTOMER_MODEL || 'claude-haiku-4-5-20251001',
                max_tokens: 200,
                temperature: 1,
                system: `Hacés de un cliente argentino que le escribe por WhatsApp a una vendedora de un producto para bajar de peso (Nuez de la India: cápsulas, gotas o semillas). NO sos un asistente: sos el cliente.\n\nTU PERSONAJE: ${persona.brief}\n\nCómo escribís: como en WhatsApp de verdad. Mensajes cortos (casi siempre menos de 15 palabras), informal, a veces sin signos ni mayúsculas, con algún error de tipeo. Un solo mensaje por vez. Nunca expliques que sos una simulación. Seguí tu personaje aunque la vendedora insista, pero reaccioná a lo que ella dice de verdad (si te pregunta algo razonable, contestalo a tu manera).\n\nSi tu personaje ya logró o abandonó lo que quería, o la charla ya no da para más, respondé SOLO con: [FIN]`,
                messages: [{ role: 'user', content: `La conversación hasta ahora:\n\n${convo}\n\nEscribí SOLO tu próximo mensaje de WhatsApp (o [FIN]).` }],
            });
            return (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim().replace(/^VOS:\s*/i, '').replace(/^"|"$/g, '');
        }

        // ── Una charla ───────────────────────────────────────────────────────────
        async function simulate({ persona, run }) {
            const USER = `${persona.phone || '5493415550'}${String(100 + jobs.findIndex((j) => j.persona === persona && j.run === run)).slice(-3)}@c.us`;
            const us = {};
            const log = [];
            const orders = [], alerts = [];
            const config = { alertNumbers: [], mpEnabled: persona.mpEnabled !== false };
            const sharedState = { pausedUsers: new Set(), userState: us, io: null, saveState: () => {}, config, sessionAlerts: [], sellerId: 'horacio' };
            const deps = {
                saveState: () => {},
                sendMessageWithDelay: async (u, m) => { log.push({ role: 'bot', content: m, step: us[u]?.step }); us[u]?.history?.push({ role: 'bot', content: m }); return true; },
                notifyAdmin: async (title, _u, body) => { alerts.push({ title, body }); log.push({ role: 'system', content: `AVISO AL VENDEDOR: ${title} | ${String(body || '').replace(/\s+/g, ' ').slice(0, 300)}` }); },
                saveOrderToLocal: (o) => { orders.push(o); log.push({ role: 'system', content: `PEDIDO GUARDADO: ${o.producto} ${o.plan} $${o.precio} · ${o.paymentMethod || ''} · ${o.nombre || ''} · ${o.calle || ''} · ${o.ciudad || ''}` }); },
                cancelLatestOrder: async () => ({ ok: true }),
                aiService, sellerId: 'horacio', sharedState, config, logAndEmit: () => {}, client: undefined,
            };
            us[USER] = createInitialUserState({ step: 'greeting' });
            const maxTurns = persona.maxTurns || 12;
            let errors = 0;
            for (let turn = 0; turn < maxTurns; turn++) {
                let text = turn === 0 ? persona.opener : await nextCustomerMessage(persona, log).catch((e) => `[FIN] (${e.message})`);
                if (!text || /\[FIN\]/i.test(text)) break;
                text = text.replace(/\s*\[FIN\]\s*/gi, '').trim();
                log.push({ role: 'user', content: text, step: us[USER]?.step });
                if (sharedState.pausedUsers.has(USER)) { log.push({ role: 'system', content: '(chat pausado: el bot no contesta, lo sigue una persona)' }); break; }
                const before = log.length;
                try {
                    const lastBot = [...(us[USER].history || [])].reverse().find((h) => h && h.role === 'bot');
                    const intent = await classifyMessage(text, { lastBotMessage: lastBot?.content || null, step: String(us[USER].step || '') });
                    await processSalesFlow(USER, text, us, knowledge, { ...deps, intent });
                } catch (e) {
                    errors++;
                    log.push({ role: 'system', content: `EXCEPCIÓN DEL BOT: ${e.message}` });
                }
                if (sharedState.pausedUsers.has(USER)) log.push({ role: 'system', content: `BOT PAUSADO: ${sharedState._pauseReasons?.[USER] || ''}` });
                if (log.length === before) log.push({ role: 'system', content: '(el bot no respondió nada)' });
            }
            const st = us[USER];
            const result = { id: persona.id, run, phone: USER.split('@')[0], persona, log, orders, alerts, errors, paused: sharedState.pausedUsers.has(USER),
                final: { step: st.step, deliveryZone: st.deliveryZone, paymentMethod: st.paymentMethod, product: st.selectedProduct, plan: st.selectedPlan, total: st.totalPrice, clientAge: st.clientAge, ciudad: st.partialAddress?.ciudad } };
            result.issues = runChecks(result, knowledge);
            return result;
        }

        // ── Corre todo con un tope de charlas en paralelo ────────────────────────
        const results = [];
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
            while (next < jobs.length) {
                const job = jobs[next++];
                const r = await simulate(job).catch((e) => ({ id: job.persona.id, run: job.run, persona: job.persona, log: [{ role: 'system', content: `SIM ROTA: ${e.message}` }], orders: [], alerts: [], issues: [{ level: 'alta', code: 'sim_rota', detail: e.message }], final: {} }));
                results.push(r);
                process.stdout.write(`  · ${r.id}#${r.run}: ${r.log.filter((l) => l.role === 'user').length} turnos, ${r.issues.length} chequeos, fin=${r.final.step}${r.orders.length ? ', PEDIDO' : ''}${r.paused ? ', PAUSADO' : ''}\n`);
            }
        }));
        results.sort((a, b) => a.id.localeCompare(b.id) || a.run - b.run);

        // ── Transcripciones ──────────────────────────────────────────────────────
        const ROLE = { user: '👤 CLIENTE', bot: '🤖 BOT', system: '   ⚑' };
        const transcript = results.map((r) => `===== ${r.id}#${r.run} (${r.phone}) — ${r.persona.title} =====\nPersonaje: ${r.persona.brief}\n\n`
            + r.log.map((l) => `${ROLE[l.role]}: ${l.content}`).join('\n\n')
            + `\n\n[final: ${JSON.stringify(r.final)}]\n[chequeos: ${r.issues.length ? r.issues.map((i) => `${i.level}:${i.code}`).join(', ') : 'ninguno'}]`).join('\n\n\n');
        fs.writeFileSync(path.join(outDir, 'charlas.txt'), transcript);

        // ── El juez: el prompt del reporte diario sobre las charlas simuladas ────
        const judged = [];
        const base = Date.parse('2026-01-01T12:00:00Z');
        for (let i = 0; i < results.length; i += 12) {
            const chunk = results.slice(i, i + 12);
            const logs = [];
            chunk.forEach((r, ci) => r.log.forEach((l, li) => logs.push({ userPhone: r.phone, role: l.role, content: l.content, timestamp: new Date(base + ci * 3600_000 + li * 20_000) })));
            const report = await runNightlyReview('sim', {}, {
                client: anthropic, prisma: { chatLog: { findMany: async () => logs } },
                now: new Date(base + 23 * 3600_000), hours: 24, dataDir: path.join(outDir, 'juez'),
            }).catch(() => null);
            if (report) judged.push(...report.hallazgos.map((h) => ({ ...h, id: (chunk.find((r) => r.phone === h.telefono) || {}).id || h.telefono })));
        }

        // ── Informe ──────────────────────────────────────────────────────────────
        const auto = results.flatMap((r) => r.issues.map((i) => ({ id: `${r.id}#${r.run}`, ...i })));
        const order = { alta: 0, media: 1, baja: 2 };
        auto.sort((a, b) => order[a.level] - order[b.level]);
        judged.sort((a, b) => (order[a.gravedad] ?? 3) - (order[b.gravedad] ?? 3));
        const md = [
            `# Simulación de clientes — ${results.length} charlas`,
            '', `Pedidos cerrados: ${results.filter((r) => r.orders.length).length} · pausados: ${results.filter((r) => r.paused).length} · excepciones: ${results.reduce((n, r) => n + (r.errors || 0), 0)}`,
            '', `## Chequeos automáticos (${auto.length})`, '',
            ...auto.map((i) => `- **${i.level}** \`${i.code}\` — ${i.id}: ${i.detail}`),
            '', `## Juez (${judged.length})`, '',
            ...judged.map((h) => `- **${h.gravedad}** — ${h.id}: ${h.que_paso}\n  - Debía: ${h.que_debia_pasar}\n  - Cita: ${h.cita}`),
            '', '## Por personaje', '',
            ...results.map((r) => `- ${r.id}#${r.run} — ${r.persona.title}: fin \`${r.final.step}\`${r.orders.length ? ', pedido' : ''}${r.paused ? ', pausado' : ''} · ${r.issues.length} chequeos`),
        ].join('\n');
        fs.writeFileSync(path.join(outDir, 'informe.md'), md);
        fs.writeFileSync(path.join(outDir, 'resultados.json'), JSON.stringify({ results: results.map(({ persona, ...r }) => ({ ...r, title: persona.title })), judged }, null, 2));
        process.stdout.write(`\nSIM: ${results.length} charlas · ${auto.length} chequeos automáticos · ${judged.length} hallazgos del juez → ${outDir}\n`);

        // El simulador informa; no hace fallar la suite por lo que encuentre.
        expect(results.length).toBe(jobs.length);
    });
});
