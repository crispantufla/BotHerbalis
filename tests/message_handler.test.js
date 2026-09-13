/**
 * createMessageHandler — la puerta de entrada de CADA mensaje que llega.
 *
 * No tenía ningún test. Este archivo fija su comportamiento observable (qué
 * registra, qué contesta, a quién avisa, qué encola y cuándo) para poder partir
 * la función sin cambiarlo. Todo lo que toca afuera está mockeado: Redis, la IA,
 * la DB y el cliente de WhatsApp.
 *
 * Con MH_TRACE_FILE=<ruta> vuelca la traza completa de efectos de cada
 * escenario, para comparar byte a byte antes y después de un refactor.
 */
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');

// queueService abre una conexión a Redis al importarse (y el .env apunta a prod).
jest.mock('../src/services/queueService', () => ({
    redisConnection: { set: jest.fn(async () => 'OK'), get: jest.fn(async () => null) },
}));
jest.mock('../src/services/ai', () => ({
    aiService: { transcribeAudio: jest.fn(async () => null) },
}));
// pauseUser persiste la pausa: sin esto escribiría en la DB de producción.
jest.mock('../db', () => ({
    prisma: {
        user: { upsert: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
        funnelEvent: { create: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue(null) },
        messageEvent: { create: jest.fn().mockResolvedValue({}) },
        order: { findFirst: jest.fn().mockResolvedValue(null) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    },
}));
jest.mock('whatsapp-web.js', () => ({
    MessageMedia: class { constructor(mimetype, data, filename) { Object.assign(this, { mimetype, data, filename }); } },
}));

const { redisConnection } = require('../src/services/queueService');
const { aiService } = require('../src/services/ai');
const { createMessageHandler } = require('../src/handlers/messageHandler');

const ADMIN = '5490000000000@c.us';
const CLIENTE = '5491111111111@c.us';
const LID = '99887766554433@lid';
const RESUELTO = '5491155550000@c.us';

const traces = [];
let tmp;
let seq = 0;

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-')); });
afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (process.env.MH_TRACE_FILE) fs.writeFileSync(process.env.MH_TRACE_FILE, JSON.stringify(traces, null, 2));
});
beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-13T12:00:00Z') });
    redisConnection.set.mockReset().mockResolvedValue('OK');
    redisConnection.get.mockReset().mockResolvedValue(null);
    aiService.transcribeAudio.mockReset().mockResolvedValue(null);
});
afterEach(() => { jest.useRealTimers(); });

function mkHarness(over = {}) {
    const calls = [];
    const push = (...e) => calls.push(e);
    const pausedUsers = over.pausedUsers || new Set();
    const client = {
        sendMessage: jest.fn(async (to, content) => { push('client.sendMessage', to, typeof content === 'string' ? content : '[media]'); }),
    };
    const ctx = {
        sellerId: 'horacio',
        client,
        sharedState: { connectedAt: 1000000000, knowledge: null, pausedUsers },
        userState: over.userState || {},
        config: { alertNumbers: ['5490000000000'], globalPause: false, ...(over.config || {}) },
        pausedUsers,
        pendingMessages: new Map(),
        botQueue: { add: jest.fn(async (...a) => { push('botQueue.add', ...a); }) },
        logAndEmit: jest.fn((...a) => { push('logAndEmit', ...a); }),
        notifyAdmin: jest.fn(async (...a) => { push('notifyAdmin', ...a); }),
        handleAdminCommand: jest.fn(async (...a) => { push('handleAdminCommand', ...a); return `resultado de ${a[1]}`; }),
        saveState: jest.fn((...a) => { push('saveState', ...a); }),
        knowledge: null,
        dataDir: path.join(tmp, 'data'),
    };
    return { ctx, calls, handler: createMessageHandler(ctx) };
}

function mkMsg(o = {}) {
    seq++;
    return {
        from: CLIENTE, body: 'hola', type: 'chat', fromMe: false, timestamp: 2000000000 + seq,
        id: { _serialized: `false_MSG${seq}` },
        hasMedia: false, _data: {},
        getChat: jest.fn(async () => ({ isGroup: false, sendStateRecording: jest.fn(async () => {}) })),
        getContact: jest.fn(async () => ({ number: '5491111111111' })),
        downloadMedia: jest.fn(async () => ({ data: Buffer.from('ogg-bytes').toString('base64'), mimetype: 'audio/ogg; codecs=opus' })),
        ...o,
    };
}

function record(name, h) {
    const norm = (v) => JSON.parse(JSON.stringify(v, (k, x) => {
        if (typeof x === 'string') return x.replace(/aud_\d+_[0-9a-f-]{36}/g, 'aud_TS_UUID');
        if (x instanceof Set) return [...x].sort();
        return x;
    }));
    traces.push({
        name,
        calls: norm(h.calls),
        paused: [...h.ctx.pausedUsers].sort(),
        pending: [...h.ctx.pendingMessages.entries()].map(([k, v]) => [k, v.messages.map(m => m.text)]),
        userState: norm(h.ctx.userState),
        redisSet: norm(redisConnection.set.mock.calls),
        redisGet: norm(redisConnection.get.mock.calls),
        transcribe: norm(aiService.transcribeAudio.mock.calls.map(c => c[1])),
    });
}

const names = (h, kind) => h.calls.filter(c => c[0] === kind);

describe('descartes antes de tocar nada', () => {
    test('status@broadcast', async () => {
        const h = mkHarness(); const msg = mkMsg({ from: 'status@broadcast' });
        await h.handler(msg);
        expect(h.calls).toEqual([]);
        expect(msg.getChat).not.toHaveBeenCalled();
        record('status@broadcast', h);
    });
    test('grupo', async () => {
        const h = mkHarness(); const msg = mkMsg({ from: '120363000000000000@g.us' });
        await h.handler(msg);
        expect(h.calls).toEqual([]);
        expect(msg.getChat).not.toHaveBeenCalled();
        record('grupo', h);
    });
    test('mensaje anterior a la conexión', async () => {
        const h = mkHarness(); const msg = mkMsg({ timestamp: 999 });
        await h.handler(msg);
        expect(h.calls).toEqual([]);
        expect(msg.getChat).not.toHaveBeenCalled();
        record('anterior a la conexion', h);
    });
    test('mensaje ya procesado (dedup en Redis)', async () => {
        redisConnection.set.mockResolvedValueOnce(null);
        const h = mkHarness(); const msg = mkMsg();
        await h.handler(msg);
        expect(h.calls).toEqual([]);
        expect(msg.getChat).not.toHaveBeenCalled();
        record('dedup', h);
    });
    test('Redis caído: sigue sin dedup', async () => {
        redisConnection.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        const h = mkHarness();
        await h.handler(mkMsg({ body: 'hola' }));
        expect(h.ctx.logAndEmit).toHaveBeenCalledWith(CLIENTE, 'user', 'hola', 'new');
        record('redis caido', h);
    });
    test('id inutilizable ("[object Object]"): no se dedupea', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ id: { _serialized: '[object Object]' } }));
        expect(redisConnection.set).not.toHaveBeenCalled();
        expect(h.ctx.logAndEmit).toHaveBeenCalled();
        record('id inutilizable', h);
    });
    test('getChat dice que es grupo', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ getChat: jest.fn(async () => ({ isGroup: true })) }));
        expect(h.calls).toEqual([]);
        record('getChat grupo', h);
    });
});

describe('identidad del cliente', () => {
    test('@lid se resuelve al teléfono y queda pegado en Redis', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ from: LID, getContact: jest.fn(async () => ({ number: '5491155550000' })) }));
        expect(h.ctx.logAndEmit).toHaveBeenCalledWith(RESUELTO, 'user', 'hola', 'new');
        expect(redisConnection.set).toHaveBeenCalledWith(`lidmap:horacio:${LID}`, RESUELTO, 'EX', 604800);
        record('lid resuelto', h);
    });
    test('si getContact falla, usa la última resolución guardada', async () => {
        redisConnection.get.mockResolvedValueOnce(RESUELTO);
        const h = mkHarness();
        await h.handler(mkMsg({ from: LID, getContact: jest.fn(async () => { throw new Error('r'); }) }));
        expect(h.ctx.logAndEmit).toHaveBeenCalledWith(RESUELTO, 'user', 'hola', 'new');
        record('lid desde cache', h);
    });
    test('sin resolución ni caché, sigue con el id crudo', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ from: LID, getContact: jest.fn(async () => { throw new Error('r'); }) }));
        expect(h.ctx.logAndEmit).toHaveBeenCalledWith(LID, 'user', 'hola', 'new');
        record('lid crudo', h);
    });
    test('id largo sin @lid: toma los dígitos del nombre del contacto', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ from: '123456789012345678901@c.us', getContact: jest.fn(async () => ({ pushname: '+54 9 11 5555-0000' })) }));
        expect(h.ctx.logAndEmit).toHaveBeenCalledWith(RESUELTO, 'user', 'hola', 'new');
        record('id largo', h);
    });
});

describe('mensajes del admin', () => {
    test('!ayuda manda el menú en dos partes', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ from: ADMIN, body: '!ayuda' }));
        const sent = names(h, 'client.sendMessage');
        expect(sent).toHaveLength(2);
        expect(sent.every(c => c[1] === ADMIN)).toBe(true);
        expect(h.ctx.handleAdminCommand).not.toHaveBeenCalled();
        expect(h.ctx.logAndEmit).not.toHaveBeenCalled();
        record('!ayuda', h);
    });
    test('!saltear fuerza waiting_data y le pide los datos al cliente', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ from: ADMIN, body: '!saltear 5491122223333' }));
        expect(h.ctx.userState['5491122223333@c.us'].step).toBe('waiting_data');
        expect(h.ctx.saveState).toHaveBeenCalled();
        expect(h.ctx.client.sendMessage).toHaveBeenCalledWith('5491122223333@c.us', expect.stringContaining('Pasame los datos'));
        expect(h.ctx.client.sendMessage).toHaveBeenCalledWith(ADMIN, '✅ Usuario 5491122223333 forzado a waiting_data.');
        record('!saltear', h);
    });
    test('comando con selector de alerta ("2 ok")', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ from: ADMIN, body: '2 ok' }));
        expect(h.ctx.handleAdminCommand).toHaveBeenCalledWith(null, 'ok', false, '2');
        expect(h.ctx.client.sendMessage).toHaveBeenCalledWith(ADMIN, 'resultado de ok');
        record('selector de alerta', h);
    });
    test('audio del admin: se transcribe y se ejecuta como comando', async () => {
        aiService.transcribeAudio.mockResolvedValueOnce('!status');
        const h = mkHarness();
        await h.handler(mkMsg({ from: ADMIN, type: 'ptt', body: '' }));
        expect(h.ctx.handleAdminCommand).toHaveBeenCalledWith(null, '!status', false, null);
        expect(h.ctx.client.sendMessage).toHaveBeenCalledWith(ADMIN, 'resultado de !status');
        expect(h.ctx.logAndEmit).not.toHaveBeenCalled();
        record('audio admin', h);
    });
    test('mensaje propio (fromMe) cuenta como admin', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ fromMe: true, body: '!pausados' }));
        expect(h.ctx.handleAdminCommand).toHaveBeenCalledWith(null, '!pausados', false, null);
        expect(h.ctx.logAndEmit).not.toHaveBeenCalled();
        record('fromMe', h);
    });
    test('texto vacío del admin: nada', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ from: ADMIN, body: '' }));
        expect(h.calls).toEqual([]);
        record('admin vacio', h);
    });
});

describe('audio del cliente', () => {
    test('no se pudo descargar: queda registrado y se le pide que escriba', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ type: 'ptt', body: '', downloadMedia: jest.fn(async () => { throw new Error('r'); }) }));
        expect(h.ctx.logAndEmit).toHaveBeenCalledWith(CLIENTE, 'user', '🎤 Audio recibido (no se pudo descargar)', 'new');
        expect(h.ctx.client.sendMessage).toHaveBeenCalledWith(CLIENTE, 'Disculpá, no pude escuchar bien el audio. ¿Me lo escribís?');
        expect(h.ctx.pendingMessages.size).toBe(0);
        record('audio sin descarga', h);
    });
    test('descarga vacía: mismo camino', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ type: 'audio', body: '', downloadMedia: jest.fn(async () => null) }));
        expect(h.ctx.logAndEmit).toHaveBeenCalledWith(CLIENTE, 'user', '🎤 Audio recibido (no se pudo descargar)', 'new');
        record('audio descarga null', h);
    });
    test('transcripto: se registra con el audio y sigue como texto', async () => {
        aiService.transcribeAudio.mockResolvedValueOnce('quiero bajar 10 kilos');
        const h = mkHarness();
        await h.handler(mkMsg({ type: 'ptt', body: '' }));
        const logs = names(h, 'logAndEmit');
        expect(logs).toHaveLength(1);
        expect(logs[0][3]).toMatch(/^MEDIA_AUDIO:\/media\/audio\/aud_\d+_[0-9a-f-]{36}\.ogg\|TRANSCRIPTION:quiero bajar 10 kilos$/);
        expect(h.ctx.pendingMessages.get(CLIENTE).messages.map(m => m.text)).toEqual(['quiero bajar 10 kilos']);
        record('audio transcripto', h);
    });
    test('sin transcripción: se registra el audio y se pide que escriba', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ type: 'ptt', body: '' }));
        expect(names(h, 'logAndEmit')[0][3]).toMatch(/^MEDIA_AUDIO:/);
        expect(h.ctx.client.sendMessage).toHaveBeenCalledWith(CLIENTE, 'Disculpá, no pude escuchar bien el audio. ¿Me lo escribís?');
        expect(h.ctx.pendingMessages.size).toBe(0);
        record('audio sin transcripcion', h);
    });
});

describe('imágenes, stickers y documentos', () => {
    test('imagen durante el pago = comprobante: pausa y avisa', async () => {
        const h = mkHarness({ userState: { [CLIENTE]: { step: 'waiting_mp_payment' } } });
        await h.handler(mkMsg({ type: 'image', body: '' }));
        expect(h.ctx.logAndEmit).toHaveBeenCalledWith(CLIENTE, 'user', '📷 Imagen recibida', 'waiting_mp_payment');
        expect(h.ctx.client.sendMessage).toHaveBeenCalledWith(CLIENTE, expect.stringContaining('comprobante'));
        expect(h.ctx.pausedUsers.has(CLIENTE)).toBe(true);
        expect(h.ctx.notifyAdmin).toHaveBeenCalledWith('💸 Comprobante recibido (imagen)', CLIENTE, expect.any(String));
        expect(h.ctx.pendingMessages.size).toBe(0);
        record('imagen comprobante', h);
    });
    test('imagen con texto fuera del pago: sigue como mensaje', async () => {
        const h = mkHarness({ userState: { [CLIENTE]: { step: 'waiting_weight' } } });
        await h.handler(mkMsg({ type: 'image', body: 'mirá mi panza' }));
        expect(names(h, 'logAndEmit')).toEqual([['logAndEmit', CLIENTE, 'user', '📷 Imagen recibida: mirá mi panza', 'waiting_weight']]);
        expect(h.ctx.pendingMessages.get(CLIENTE).messages.map(m => m.text)).toEqual(['[Imagen enviada por el usuario] mirá mi panza']);
        record('imagen con texto', h);
    });
    test('imagen sin texto fuera del pago: solo se registra', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ type: 'image', body: '' }));
        expect(h.calls).toEqual([['logAndEmit', CLIENTE, 'user', '📷 Imagen recibida', 'new']]);
        record('imagen sin texto', h);
    });
    test('sticker: solo se registra', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ type: 'sticker', body: '' }));
        expect(h.calls).toEqual([['logAndEmit', CLIENTE, 'user', '📷 Sticker recibida', 'new']]);
        record('sticker', h);
    });
    test('PDF durante el pago = comprobante', async () => {
        const h = mkHarness({ userState: { [CLIENTE]: { step: 'waiting_transfer_confirmation' } } });
        await h.handler(mkMsg({ type: 'document', body: '', _data: { filename: 'comprobante.pdf' } }));
        expect(h.ctx.logAndEmit).toHaveBeenCalledWith(CLIENTE, 'user', '📄 Documento recibido: comprobante.pdf', 'waiting_transfer_confirmation');
        expect(h.ctx.pausedUsers.has(CLIENTE)).toBe(true);
        expect(h.ctx.notifyAdmin).toHaveBeenCalledWith('💸 Comprobante recibido (PDF)', CLIENTE, expect.stringContaining('comprobante.pdf'));
        record('pdf comprobante', h);
    });
    test('documento fuera del pago: se registra y se ignora', async () => {
        const h = mkHarness({ userState: { [CLIENTE]: { step: 'waiting_weight' } } });
        await h.handler(mkMsg({ type: 'document', body: 'catalogo.pdf' }));
        expect(h.calls).toEqual([['logAndEmit', CLIENTE, 'user', '📄 Documento recibido: catalogo.pdf', 'waiting_weight']]);
        record('documento fuera del pago', h);
    });
});

describe('mensajes sin texto', () => {
    test('chat vacío (clic en anuncio) → saludo de anuncio', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ type: 'chat', body: '' }));
        expect(h.ctx.logAndEmit).toHaveBeenCalledWith(CLIENTE, 'user', 'Hola! (Vengo de un anuncio)', 'new');
        expect(h.ctx.pendingMessages.get(CLIENTE).messages.map(m => m.text)).toEqual(['Hola! (Vengo de un anuncio)']);
        record('clic en anuncio', h);
    });
    test('evento de sistema de WhatsApp → se descarta sin registrar', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ type: 'e2e_notification', body: '' }));
        expect(h.calls).toEqual([]);
        record('evento de sistema', h);
    });
    test('tipo que el bot no sabe leer → se registra siempre, se avisa una vez', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ type: 'video', body: '' }));
        await h.handler(mkMsg({ type: 'video', body: '' }));
        expect(names(h, 'logAndEmit')).toHaveLength(2);
        expect(names(h, 'notifyAdmin')).toHaveLength(1);
        record('tipo no soportado', h);
    });
    test('placeholder de WhatsApp ("esperando el mensaje") → se trata como Hola', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ body: 'Esperando el mensaje. Consulta tu teléfono.' }));
        expect(h.ctx.logAndEmit).toHaveBeenCalledWith(CLIENTE, 'user', 'Hola', 'new');
        record('placeholder', h);
    });
});

describe('texto, pausas y debounce', () => {
    test('texto normal: se registra y se encola a los 10 s', async () => {
        const h = mkHarness();
        const startTime = Date.now();
        await h.handler(mkMsg({ body: 'hola, info' }));
        expect(h.ctx.logAndEmit).toHaveBeenCalledWith(CLIENTE, 'user', 'hola, info', 'new');
        await jest.advanceTimersByTimeAsync(9999);
        expect(h.ctx.botQueue.add).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        expect(h.ctx.botQueue.add).toHaveBeenCalledWith('process-message',
            { userId: CLIENTE, combinedText: 'hola, info', effectiveScript: 'v7', startTime },
            { removeOnComplete: true, removeOnFail: 100 });
        expect(h.ctx.pendingMessages.size).toBe(0);
        record('texto normal', h);
    });
    test('dos mensajes seguidos se juntan en uno', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ body: 'hola' }));
        await jest.advanceTimersByTimeAsync(3000);
        await h.handler(mkMsg({ body: 'quiero info' }));
        await jest.advanceTimersByTimeAsync(10000);
        expect(h.ctx.botQueue.add).toHaveBeenCalledTimes(1);
        expect(h.ctx.botQueue.add.mock.calls[0][1].combinedText).toBe('hola quiero info');
        record('dos mensajes', h);
    });
    test('en waiting_data el debounce es de 25 s', async () => {
        const h = mkHarness({ userState: { [CLIENTE]: { step: 'waiting_data', assignedScript: 'v7' } } });
        await h.handler(mkMsg({ body: 'Juan Perez' }));
        await jest.advanceTimersByTimeAsync(10000);
        expect(h.ctx.botQueue.add).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(15000);
        expect(h.ctx.botQueue.add).toHaveBeenCalledTimes(1);
        record('debounce waiting_data', h);
    });
    test('pausa global: se registra pero no se encola', async () => {
        const h = mkHarness({ config: { globalPause: true } });
        await h.handler(mkMsg({ body: 'hola' }));
        expect(h.ctx.logAndEmit).toHaveBeenCalledWith(CLIENTE, 'user', 'hola', 'new');
        await jest.advanceTimersByTimeAsync(30000);
        expect(h.ctx.botQueue.add).not.toHaveBeenCalled();
        expect(h.ctx.pendingMessages.size).toBe(0);
        record('pausa global', h);
    });
    test('cliente pausado: se registra, no se encola, y se avisa como mucho cada 30 min', async () => {
        const h = mkHarness({ pausedUsers: new Set([CLIENTE]) });
        await h.handler(mkMsg({ body: 'hola?' }));
        await jest.advanceTimersByTimeAsync(60 * 1000);
        await h.handler(mkMsg({ body: 'estás?' }));
        expect(names(h, 'notifyAdmin')).toHaveLength(1);
        await jest.advanceTimersByTimeAsync(31 * 60 * 1000);
        await h.handler(mkMsg({ body: 'hola??' }));
        expect(names(h, 'notifyAdmin')).toHaveLength(2);
        expect(names(h, 'logAndEmit')).toHaveLength(3);
        expect(h.ctx.botQueue.add).not.toHaveBeenCalled();
        record('cliente pausado', h);
    });
    test('una pausa guardada bajo el @lid crudo se mueve al teléfono resuelto', async () => {
        const h = mkHarness({ pausedUsers: new Set([LID]) });
        await h.handler(mkMsg({ from: LID, getContact: jest.fn(async () => ({ number: '5491155550000' })) }));
        expect([...h.ctx.pausedUsers]).toEqual([RESUELTO]);
        expect(h.ctx.notifyAdmin).toHaveBeenCalledWith('💬 Cliente en pausa te escribió', RESUELTO, expect.any(String));
        record('pausa migrada del lid', h);
    });
    test('si lo pausan durante el debounce, no se encola', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ body: 'hola' }));
        h.ctx.pausedUsers.add(CLIENTE);
        await jest.advanceTimersByTimeAsync(10000);
        expect(h.ctx.botQueue.add).not.toHaveBeenCalled();
        expect(h.ctx.pendingMessages.size).toBe(0);
        record('pausado durante debounce', h);
    });
    test('un state con otro guion se normaliza a v7 al procesar', async () => {
        const h = mkHarness({ userState: { [CLIENTE]: { step: 'waiting_weight', assignedScript: 'v6' } } });
        await h.handler(mkMsg({ body: 'hola' }));
        await jest.advanceTimersByTimeAsync(10000);
        expect(h.ctx.userState[CLIENTE].assignedScript).toBe('v7');
        expect(h.ctx.saveState).toHaveBeenCalledWith(CLIENTE);
        record('normaliza guion', h);
    });
});

describe('errores', () => {
    test('si algo revienta, avisa al admin que el mensaje se perdió', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ body: 'hola', getChat: jest.fn(async () => { throw new Error('r'); }) }));
        expect(h.ctx.notifyAdmin).toHaveBeenCalledWith('⚠️ Mensaje perdido', CLIENTE, expect.stringContaining('Error: r'));
        record('error avisa', h);
    });
    test('...pero no por mensajes propios', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ fromMe: true, getChat: jest.fn(async () => { throw new Error('r'); }) }));
        expect(h.ctx.notifyAdmin).not.toHaveBeenCalled();
        record('error fromMe', h);
    });
});

describe('"marta mandame un audio"', () => {
    // Era un easter egg que pedía aiService.generateAudio, un método que no
    // existe en ningún lado del repo: siempre terminaba en "Uy, tuve un
    // problemita con el audio". Se sacó el 2026-09-13; ahora es un mensaje más.
    test('ya no es un comando: sigue como cualquier texto', async () => {
        const h = mkHarness();
        await h.handler(mkMsg({ body: 'marta mandame un audio' }));
        expect(h.ctx.client.sendMessage).not.toHaveBeenCalled();
        expect(h.ctx.pendingMessages.get(CLIENTE).messages.map(m => m.text)).toEqual(['marta mandame un audio']);
        record('easter egg audio', h);
    });
});
