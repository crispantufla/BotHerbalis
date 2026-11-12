/**
 * Revisión nocturna de charlas (services/nightlyReview). No toca la base ni la
 * API reales: prisma y el cliente de Anthropic son de mentira.
 */
jest.mock('../db', () => ({ prisma: {} }));
jest.mock('../src/services/ai', () => ({ aiService: { anthropic: null } }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildTranscript, parseReviewText, formatReviewForAdmin, runNightlyReview } = require('../src/services/nightlyReview');

const at = (hhmm) => new Date(`2026-11-12T${hhmm}:00Z`);
const LOGS = [
    { userPhone: '5493410000001', role: 'bot', content: '¿Te paso los precios? 😊', timestamp: at('13:00') },
    { userPhone: '5493410000001', role: 'user', content: 'Tengo los triglicéridos alto y diabetes', timestamp: at('13:01') },
    { userPhone: '5493410000001', role: 'bot', content: '¡Claro! Estos son los precios 👇', timestamp: at('13:01') },
    { userPhone: '5493410000002', role: 'user', content: 'MEDIA_AUDIO:/media/a.ogg|TRANSCRIPTION:hola quiero saber como se toma', timestamp: at('14:00') },
    { userPhone: '5493410000002', role: 'admin', content: 'te cuento', timestamp: at('14:05') },
    { userPhone: '5493410000003', role: 'bot', content: 'Promo enviada, nadie contestó', timestamp: at('15:00') },
    { userPhone: '5493410000004', role: 'user', content: '/9j/4AAQSkZJRg' + 'A'.repeat(400), timestamp: at('16:00') },
];
const fakePrisma = { chatLog: { findMany: jest.fn().mockResolvedValue(LOGS) } };

const AI_TEXT = `RESUMEN: El bot ignoró un tema de salud. Es el problema que más se repite.

### 5493410000001 | alta
PASÓ: El cliente dijo que tiene diabetes y el bot mandó la lista de precios.
DEBÍA: Atender el tema de salud antes de los precios.
CITA: CLIENTE: "Tengo los triglicéridos alto y diabetes" / BOT: "¡Claro! Estos son los precios 👇"

### 5493410000002 | baja
PASÓ: Tardó en responder.
DEBÍA: Responder antes.
CITA: "hola quiero saber como se toma"

SIN RESPUESTA: 5493410000004, 5493410000009`;

const fakeClient = (text) => ({ messages: { create: jest.fn().mockResolvedValue({ content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } }) } });

describe('buildTranscript', () => {
    test('solo charlas con mensajes del cliente, con roles legibles y hora de Argentina', async () => {
        const t = await buildTranscript('horacio', at('00:00'), at('23:59'), fakePrisma);
        expect(t.conversaciones).toBe(3);                    // la 0003 no tiene mensajes del cliente
        expect(t.mensajesDeClientes).toBe(3);
        expect(t.text).toContain('=== Teléfono 5493410000001 ===');
        expect(t.text).toContain('[10:01] CLIENTE: Tengo los triglicéridos alto y diabetes');
        expect(t.text).toContain('VENDEDOR: te cuento');
        expect(t.text).toContain('CLIENTE: [audio] hola quiero saber como se toma');
        expect(t.text).toContain('CLIENTE: [imagen]');       // el base64 no viaja a la IA
        expect(t.text).not.toContain('5493410000003');
    });
});

describe('parseReviewText', () => {
    test('lee resumen, hallazgos con sus campos y los teléfonos sin respuesta', () => {
        const r = parseReviewText(AI_TEXT);
        expect(r.resumen).toMatch(/ignoró un tema de salud/);
        expect(r.hallazgos).toHaveLength(2);
        expect(r.hallazgos[0]).toEqual({
            telefono: '5493410000001',
            gravedad: 'alta',
            que_paso: 'El cliente dijo que tiene diabetes y el bot mandó la lista de precios.',
            que_debia_pasar: 'Atender el tema de salud antes de los precios.',
            cita: 'CLIENTE: "Tengo los triglicéridos alto y diabetes" / BOT: "¡Claro! Estos son los precios 👇"',
        });
        expect(r.hallazgos[1].gravedad).toBe('baja');
        expect(r.sinRespuesta).toEqual(['5493410000004', '5493410000009']);
    });

    test('sin fallas: resumen solo', () => {
        const r = parseReviewText('RESUMEN: Todo bien hoy.\n\nSIN RESPUESTA: ninguno');
        expect(r).toEqual({ resumen: 'Todo bien hoy.', hallazgos: [], sinRespuesta: [] });
    });

    test('texto que no respeta el formato → resumen vacío', () => {
        expect(parseReviewText('No pude revisar nada.').resumen).toBe('');
    });
});

describe('formatReviewForAdmin', () => {
    const base = { sellerId: 'horacio', desde: '', hasta: '', conversaciones: 3, mensajesDeClientes: 3, resumen: 'Resumen.' };
    test('los graves primero y los sin respuesta al final', () => {
        const msg = formatReviewForAdmin({ ...base, hallazgos: parseReviewText(AI_TEXT).hallazgos.reverse(), sinRespuesta: ['5493410000004'] });
        expect(msg.indexOf('🔴')).toBeLessThan(msg.indexOf('🟡'));
        expect(msg).toMatch(/Sin respuesta:\* 5493410000004/);
    });
    test('sin hallazgos lo dice', () => {
        expect(formatReviewForAdmin({ ...base, hallazgos: [], sinRespuesta: [] })).toMatch(/No encontré fallas/);
    });
    test('corta para que entre en un mensaje', () => {
        const many = Array.from({ length: 60 }, (_, i) => ({ telefono: `54934100000${i}`, gravedad: 'media', que_paso: 'x'.repeat(200), que_debia_pasar: 'y', cita: '' }));
        const msg = formatReviewForAdmin({ ...base, hallazgos: many, sinRespuesta: [] }, 1500);
        expect(msg.length).toBeLessThanOrEqual(1500);
        expect(msg).toMatch(/hallazgos más en el informe guardado/);
    });
});

describe('runNightlyReview', () => {
    test('revisa, guarda el informe y avisa al admin; no escribe en la base', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
        const notifyAdmin = jest.fn().mockResolvedValue(undefined);
        const client = fakeClient(AI_TEXT);
        const report = await runNightlyReview('horacio', { notifyAdmin }, { client, prisma: fakePrisma, dataDir: dir, now: at('23:59') });

        expect(report.hallazgos).toHaveLength(2);
        expect(client.messages.create.mock.calls[0][0].messages[0].content).toContain('=== Teléfono 5493410000001 ===');
        expect(notifyAdmin).toHaveBeenCalledWith('📋 Revisión de charlas', 'system', expect.stringContaining('5493410000001'));
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'reviews', 'horacio', '2026-11-12.json'), 'utf8'));
        expect(saved.hallazgos[0].telefono).toBe('5493410000001');
        expect(Object.keys(fakePrisma)).toEqual(['chatLog']);   // solo lectura de ChatLog
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('sin conversaciones no llama a la IA ni avisa', async () => {
        const client = fakeClient(AI_TEXT);
        const notifyAdmin = jest.fn();
        const empty = { chatLog: { findMany: jest.fn().mockResolvedValue([]) } };
        expect(await runNightlyReview('horacio', { notifyAdmin }, { client, prisma: empty })).toBeNull();
        expect(client.messages.create).not.toHaveBeenCalled();
        expect(notifyAdmin).not.toHaveBeenCalled();
    });

    test('la IA falla o no respeta el formato → null, sin aviso', async () => {
        const notifyAdmin = jest.fn();
        const broken = { messages: { create: jest.fn().mockRejectedValue(new Error('sin saldo')) } };
        expect(await runNightlyReview('horacio', { notifyAdmin }, { client: broken, prisma: fakePrisma })).toBeNull();
        expect(await runNightlyReview('horacio', { notifyAdmin }, { client: fakeClient('cualquier cosa'), prisma: fakePrisma })).toBeNull();
        expect(notifyAdmin).not.toHaveBeenCalled();
    });

    test('sin cliente de Anthropic no hace nada', async () => {
        expect(await runNightlyReview('horacio', {}, { prisma: fakePrisma })).toBeNull();
    });
});
