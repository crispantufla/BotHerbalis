/**
 * Respuestas con nota de voz (A/B, nov-2026): a quien escribió por audio y cayó
 * en el grupo "voz", el bot le contesta con una nota de voz en vez del texto.
 *
 * Lo que no puede pasar nunca: que el cliente se quede sin respuesta (toda falla
 * cae al texto) y que el eco de la nota de voz se tome por algo que el vendedor
 * mandó a mano y pause el chat (ver tests/manual_chat.test.js).
 *
 * Nada de acá llama a ElevenLabs ni a WhatsApp: el sintetizador se inyecta o se
 * mockea fetch, y el "agente" es cada test.
 */
require('dotenv').config();

jest.mock('../src/services/queueService', () => ({
    redisConnection: { set: jest.fn(), get: jest.fn() },
}));
jest.mock('../src/services/ai', () => ({
    aiService: { transcribeAudio: jest.fn(async () => 'quiero bajar diez kilos') },
}));
// El ChatLog y la pausa se escriben en la DB, que es la de producción.
jest.mock('../db', () => ({
    prisma: {
        user: { upsert: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
        chatLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
        funnelEvent: { create: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue(null) },
        messageEvent: { create: jest.fn().mockResolvedValue({}) },
        order: { findFirst: jest.fn().mockResolvedValue(null) },
    },
}));
jest.mock('whatsapp-web.js', () => ({
    MessageMedia: class { constructor(mimetype, data, filename) { Object.assign(this, { mimetype, data, filename }); } },
}));
jest.mock('../src/services/agentBridge', () => ({
    agentHub: { bind: jest.fn(), dispose: jest.fn(), send: jest.fn(() => true) },
}));

const os = require('os');
const path = require('path');
const { redisConnection } = require('../src/services/queueService');
const { prisma } = require('../db');
const { agentHub } = require('../src/services/agentBridge');
const { createMessageHandler, createOutgoingMessageHandler, trackBotSends } = require('../src/handlers/messageHandler');
const { createBotHelpers } = require('../src/handlers/botHelpers');
const { RemoteClient } = require('../src/services/remoteClient');
const tts = require('../src/services/tts');

const SELLER = 'horacio';
const LID = '99887766554433@lid';
const SELF_LID = '11223344556677@lid';

// Un teléfono de cada grupo del A/B, buscados con el mismo hash que usa el bot.
function phoneInGroup(group) {
    for (let i = 0; i < 1000; i++) {
        const phone = `54911555${String(10000 + i)}`;
        if (tts.voiceGroupFor(phone) === group) return phone;
    }
    throw new Error(`no encontré un teléfono del grupo ${group}`);
}
const VOICE_PHONE = phoneInGroup('voice');
const TEXT_PHONE = phoneInGroup('text');
const VOICE_CHAT = `${VOICE_PHONE}@c.us`;
const TEXT_CHAT = `${TEXT_PHONE}@c.us`;

const AUDIO = { base64: 'T2dnUwAC', mimetype: 'audio/ogg; codecs=opus' };
const REPLY = '¡Perfecto! 😊 Con *10 kilos* te recomiendo las cápsulas. Salen $47.000 y las pagás al recibir.';

const redis = new Map();

beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-11-12T15:00:00Z') });
    jest.clearAllMocks();
    redis.clear();
    redisConnection.set.mockImplementation(async (key, value, ...opts) => {
        if (opts.includes('NX') && redis.has(key)) return null;
        redis.set(key, value);
        return 'OK';
    });
    redisConnection.get.mockImplementation(async (key) => redis.get(key) ?? null);
    agentHub.send.mockImplementation(() => true);
    tts._resetTtsForTests();
});
afterEach(() => { jest.useRealTimers(); });

const chatLogRows = () => prisma.chatLog.create.mock.calls.map(c => [c[0].data.userPhone, c[0].data.role, c[0].data.content]);

/** El estado de un cliente que acaba de mandar un audio. */
const afterAudio = (over = {}) => ({ step: 'waiting_weight', history: [], lastInboundWasAudio: true, lastInboundAudioAt: Date.now(), ...over });

function mkSeller({ userState = {}, voice, sharedState = {}, client } = {}) {
    const pausedUsers = new Set();
    const cli = client || {
        getChatById: jest.fn(async () => ({ sendStateTyping: jest.fn() })),
        sendMessage: jest.fn(async () => ({ id: { _serialized: 'true_x_3EB0BOT' } })),
    };
    const shared = { sellerId: SELLER, io: null, config: {}, ...sharedState };
    const synthesize = jest.fn(async () => AUDIO);
    const helpers = createBotHelpers({
        sellerId: SELLER, sharedState: shared, client: cli, userState, config: { alertNumbers: [] }, pausedUsers, redlock: {},
        voice: voice === undefined ? { synthesize } : voice,
    });
    /** Manda y deja correr el delay humanizado (4-8 s) y el ChatLog en segundo plano. */
    const send = async (chatId, text) => {
        const p = helpers.sendMessageWithDelay(chatId, text);
        await jest.advanceTimersByTimeAsync(9000);
        const ok = await p;
        await jest.advanceTimersByTimeAsync(0);
        return ok;
    };
    return { helpers, client: cli, userState, pausedUsers, sharedState: shared, synthesize, send };
}

describe('el texto que va (o no va) por voz', () => {
    test('se limpia para leerlo en voz alta: sin emojis ni asteriscos, y la plata como plata', () => {
        expect(tts.cleanTextForVoice(REPLY)).toBe('¡Perfecto! Con 10 kilos te recomiendo las cápsulas. Salen 47000 pesos y las pagás al recibir.');
        expect(tts.cleanTextForVoice('Son $ 18.900 hoy 👉 y _nada más_')).toBe('Son 18900 pesos hoy y nada más.');
        expect(tts.cleanTextForVoice('Total: $1.234.500,50')).toBe('Total: 1234500 pesos con 50.');
        expect(tts.cleanTextForVoice('Dale\n\n¿Cuántos kilos querés bajar? 🤔')).toBe('Dale. ¿Cuántos kilos querés bajar?');
        expect(tts.cleanTextForVoice('👍🏽✨')).toBe('');
    });

    test('un texto corto de charla es apto', () => {
        expect(tts.isVoiceFriendly(REPLY)).toBe(true);
        expect(tts.isVoiceFriendly('Las de 60 salen $47.000 y las de 120, $79.000.')).toBe(true);
    });

    test.each([
        ['largo (más de 600 caracteres)', 'Te cuento cómo funciona. '.repeat(30)],
        ['con un link', 'Pagás acá: https://mpago.la/2xYz'],
        ['con un link sin protocolo', 'Mirá la web, herbalis.com.ar'],
        ['con un alias de transferencia', 'Transferí al alias tienda.nuez.mp'],
        ['con más de dos montos', 'Cápsulas $47.000, gotas $45.000 y semillas $39.000'],
        ['con un menú de teclas numeradas', 'Elegí:\n1️⃣ Cápsulas\n2️⃣ Gotas'],
        ['con viñetas de emoji', 'Tenemos:\n🔹 Cápsulas\n🔹 Gotas'],
        ['con viñetas de guion', 'Necesito:\n- Nombre completo\n- Calle y número'],
        ['con una lista numerada', 'Pasos:\n1. Elegís\n2. Pagás'],
        ['con un número para copiar', 'Tu código de seguimiento es 00012345678'],
        ['solo emojis', '👍😊'],
        ['vacío', ''],
    ])('no es apto: %s', (_, text) => {
        expect(tts.isVoiceFriendly(text)).toBe(false);
    });

    test('el grupo sale del teléfono, siempre el mismo, y reparte más o menos por mitades', () => {
        expect(tts.voiceGroupFor(VOICE_PHONE)).toBe('voice');
        expect(tts.voiceGroupFor(VOICE_PHONE)).toBe('voice');
        let voice = 0;
        for (let i = 0; i < 2000; i++) if (tts.voiceGroupFor(`549341${String(1000000 + i)}`) === 'voice') voice++;
        expect(voice).toBeGreaterThan(900);
        expect(voice).toBeLessThan(1100);
    });

    test('en los tests la función está apagada aunque haya clave', () => {
        const prev = { key: process.env.ELEVENLABS_API_KEY, voice: process.env.ELEVENLABS_VOICE_ID };
        process.env.ELEVENLABS_API_KEY = 'clave-de-prueba';
        process.env.ELEVENLABS_VOICE_ID = 'voz-de-prueba';
        try {
            expect(tts.isVoiceRepliesEnabled()).toBe(false);
        } finally {
            if (prev.key === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = prev.key;
            if (prev.voice === undefined) delete process.env.ELEVENLABS_VOICE_ID; else process.env.ELEVENLABS_VOICE_ID = prev.voice;
        }
    });
});

describe('el interruptor VOICE_REPLIES (fuera de los tests)', () => {
    const KEYS = ['JEST_WORKER_ID', 'NODE_ENV', 'VOICE_REPLIES', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID'];
    let saved;
    beforeEach(() => {
        saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
        delete process.env.JEST_WORKER_ID;
        process.env.NODE_ENV = 'production';
        process.env.ELEVENLABS_API_KEY = 'clave-de-prueba';
        process.env.ELEVENLABS_VOICE_ID = 'voz-de-prueba';
        delete process.env.VOICE_REPLIES;
    });
    afterEach(() => {
        for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    });

    test('con clave y voz pero sin VOICE_REPLIES: apagado (hay que prenderlo a propósito)', () => {
        expect(tts.isVoiceRepliesEnabled()).toBe(false);
    });
    test('VOICE_REPLIES=1 lo prende', () => {
        process.env.VOICE_REPLIES = '1';
        expect(tts.isVoiceRepliesEnabled()).toBe(true);
    });
    test('VOICE_REPLIES=0 lo deja apagado', () => {
        process.env.VOICE_REPLIES = '0';
        expect(tts.isVoiceRepliesEnabled()).toBe(false);
    });
    test('VOICE_REPLIES=1 sin clave: apagado', () => {
        process.env.VOICE_REPLIES = '1';
        process.env.ELEVENLABS_API_KEY = '';
        expect(tts.isVoiceRepliesEnabled()).toBe(false);
    });
});

describe('synthesizeVoice (ElevenLabs, con fetch de mentira)', () => {
    const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(32, 1)]);
    const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32, 1)]);
    const okBody = (buf) => ({ ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
    const errBody = (status) => ({ ok: false, status, text: async () => '{"detail":"x"}' });
    let saved;
    let realFetch;

    beforeEach(() => {
        saved = { key: process.env.ELEVENLABS_API_KEY, voice: process.env.ELEVENLABS_VOICE_ID };
        process.env.ELEVENLABS_API_KEY = 'clave-de-prueba';
        process.env.ELEVENLABS_VOICE_ID = 'voz-de-prueba';
        realFetch = global.fetch;
        global.fetch = jest.fn();
    });
    afterEach(() => {
        global.fetch = realFetch;
        if (saved.key === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = saved.key;
        if (saved.voice === undefined) delete process.env.ELEVENLABS_VOICE_ID; else process.env.ELEVENLABS_VOICE_ID = saved.voice;
    });

    test('pide ogg/opus con el modelo multilingüe y el texto ya limpio', async () => {
        global.fetch.mockResolvedValueOnce(okBody(OGG));
        const audio = await tts.synthesizeVoice(REPLY);

        expect(audio).toEqual({ base64: OGG.toString('base64'), mimetype: 'audio/ogg; codecs=opus' });
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voz-de-prueba?output_format=opus_48000_64');
        expect(init.headers['xi-api-key']).toBe('clave-de-prueba');
        expect(JSON.parse(init.body)).toEqual({
            text: '¡Perfecto! Con 10 kilos te recomiendo las cápsulas. Salen 47000 pesos y las pagás al recibir.',
            model_id: 'eleven_multilingual_v2',
        });
    });

    test('sin clave no llama a nadie y devuelve null', async () => {
        process.env.ELEVENLABS_API_KEY = '';
        expect(await tts.synthesizeVoice(REPLY)).toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('si el formato opus es rechazado, cae a mp3 y las siguientes van directo a mp3', async () => {
        global.fetch.mockResolvedValueOnce(errBody(400)).mockResolvedValue(okBody(MP3));
        expect(await tts.synthesizeVoice('Hola, ¿cómo estás?')).toEqual({ base64: MP3.toString('base64'), mimetype: 'audio/mpeg' });
        expect(await tts.synthesizeVoice('Dale, te cuento')).toEqual({ base64: MP3.toString('base64'), mimetype: 'audio/mpeg' });

        expect(global.fetch.mock.calls.map(c => c[0].split('output_format=')[1])).toEqual(['opus_48000_64', 'mp3_44100_128', 'mp3_44100_128']);
    });

    test.each([401, 429, 500])('un %i devuelve null sin reintentar', async (status) => {
        global.fetch.mockResolvedValueOnce(errBody(status));
        expect(await tts.synthesizeVoice('Hola, ¿cómo estás?')).toBeNull();
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('la red se cae: null', async () => {
        global.fetch.mockRejectedValueOnce(new Error('ECONNRESET'));
        expect(await tts.synthesizeVoice('Hola, ¿cómo estás?')).toBeNull();
    });

    test('a los 15 s corta y devuelve null', async () => {
        global.fetch.mockImplementationOnce((_url, init) => new Promise((_, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }));
        const p = tts.synthesizeVoice('Hola, ¿cómo estás?');
        await jest.advanceTimersByTimeAsync(14999);
        let settled = false;
        p.then(() => { settled = true; });
        await jest.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        expect(await p).toBeNull();
    });
});

describe('sendMessageWithDelay con el cliente que escribió por audio', () => {
    test('grupo voz: sale la nota de voz EN VEZ del texto, y queda registrado lo que se dijo', async () => {
        const s = mkSeller({ userState: { [VOICE_CHAT]: afterAudio() } });
        expect(await s.send(VOICE_CHAT, REPLY)).toBe(true);

        expect(s.synthesize).toHaveBeenCalledWith(REPLY);
        expect(s.client.sendMessage).toHaveBeenCalledTimes(1);
        const [chatId, media, opts] = s.client.sendMessage.mock.calls[0];
        expect(chatId).toBe(VOICE_CHAT);
        expect(media).toMatchObject({ mimetype: AUDIO.mimetype, data: AUDIO.base64 });
        expect(opts).toEqual({ sendAudioAsVoice: true });

        // En el panel se ve que salió como audio; la IA lee el texto pelado.
        expect(chatLogRows()).toEqual([[VOICE_PHONE, 'bot', `🎤 ${REPLY}`]]);
        expect(s.userState[VOICE_CHAT].history).toEqual([{ role: 'bot', content: REPLY, timestamp: expect.any(Number) }]);
        expect(s.userState[VOICE_CHAT].voiceAB).toBe('voice');
    });

    test('grupo texto: sale el texto de siempre, sin sintetizar nada, y queda anotado el grupo', async () => {
        const s = mkSeller({ userState: { [TEXT_CHAT]: afterAudio() } });
        expect(await s.send(TEXT_CHAT, REPLY)).toBe(true);

        expect(s.synthesize).not.toHaveBeenCalled();
        expect(s.client.sendMessage.mock.calls).toEqual([[TEXT_CHAT, REPLY]]);
        expect(chatLogRows()).toEqual([[TEXT_PHONE, 'bot', REPLY]]);
        expect(s.userState[TEXT_CHAT].voiceAB).toBe('text');
    });

    test('el grupo anotado manda sobre el hash (no cambia de lado a mitad del experimento)', async () => {
        const s = mkSeller({ userState: { [VOICE_CHAT]: afterAudio({ voiceAB: 'text' }) } });
        await s.send(VOICE_CHAT, REPLY);

        expect(s.synthesize).not.toHaveBeenCalled();
        expect(s.client.sendMessage.mock.calls).toEqual([[VOICE_CHAT, REPLY]]);
        expect(s.userState[VOICE_CHAT].voiceAB).toBe('text');
    });

    test.each([
        ['el TTS devuelve null', async () => null],
        ['el TTS tira', async () => { throw new Error('boom'); }],
    ])('%s: cae al texto', async (_, synthesize) => {
        const s = mkSeller({ userState: { [VOICE_CHAT]: afterAudio() }, voice: { synthesize: jest.fn(synthesize) } });
        expect(await s.send(VOICE_CHAT, REPLY)).toBe(true);

        expect(s.client.sendMessage.mock.calls).toEqual([[VOICE_CHAT, REPLY]]);
        expect(chatLogRows()).toEqual([[VOICE_PHONE, 'bot', REPLY]]);
        expect(s.userState[VOICE_CHAT].history.map(h => h.content)).toEqual([REPLY]);
    });

    test('el envío del audio falla: manda el texto', async () => {
        const s = mkSeller({ userState: { [VOICE_CHAT]: afterAudio() } });
        s.client.sendMessage.mockRejectedValueOnce(new Error("RPC 'send_media' timeout (30000ms)"));
        expect(await s.send(VOICE_CHAT, REPLY)).toBe(true);

        expect(s.client.sendMessage).toHaveBeenCalledTimes(2);
        expect(s.client.sendMessage.mock.calls[1]).toEqual([VOICE_CHAT, REPLY]);
        expect(chatLogRows()).toEqual([[VOICE_PHONE, 'bot', REPLY]]);
    });

    test.each([
        ['un link de pago', 'Listo, pagás acá: https://mpago.la/2xYz'],
        ['un menú', '¿Cómo preferís pagar?\n1️⃣ Tarjeta\n2️⃣ Transferencia'],
        ['tres precios', 'Cápsulas $47.000, gotas $45.000 y semillas $39.000'],
        ['un texto largo', 'Te cuento bien cómo se toma el producto. '.repeat(20)],
    ])('texto no apto (%s): va como texto, sin sintetizar', async (_, text) => {
        const s = mkSeller({ userState: { [VOICE_CHAT]: afterAudio() } });
        expect(await s.send(VOICE_CHAT, text)).toBe(true);

        expect(s.synthesize).not.toHaveBeenCalled();
        expect(s.client.sendMessage.mock.calls).toEqual([[VOICE_CHAT, text]]);
        expect(chatLogRows()).toEqual([[VOICE_PHONE, 'bot', text]]);
        // Igual queda anotado el grupo: el cliente ya entró al experimento.
        expect(s.userState[VOICE_CHAT].voiceAB).toBe('voice');
    });

    test('el cliente escribió por texto: texto, y no entra al experimento', async () => {
        const s = mkSeller({ userState: { [VOICE_CHAT]: { step: 'waiting_weight', history: [] } } });
        await s.send(VOICE_CHAT, REPLY);

        expect(s.synthesize).not.toHaveBeenCalled();
        expect(s.client.sendMessage.mock.calls).toEqual([[VOICE_CHAT, REPLY]]);
        expect(s.userState[VOICE_CHAT].voiceAB).toBeUndefined();
    });

    test('el audio fue hace más de 15 minutos (un recordatorio del scheduler): texto', async () => {
        const s = mkSeller({ userState: { [VOICE_CHAT]: afterAudio({ lastInboundAudioAt: Date.now() - 16 * 60 * 1000 }) } });
        await s.send(VOICE_CHAT, REPLY);

        expect(s.synthesize).not.toHaveBeenCalled();
        expect(s.client.sendMessage.mock.calls).toEqual([[VOICE_CHAT, REPLY]]);
    });

    test('función apagada: texto, sin grupo', async () => {
        const synthesize = jest.fn(async () => AUDIO);
        const s = mkSeller({ userState: { [VOICE_CHAT]: afterAudio() }, voice: { enabled: false, synthesize } });
        await s.send(VOICE_CHAT, REPLY);

        expect(synthesize).not.toHaveBeenCalled();
        expect(s.client.sendMessage.mock.calls).toEqual([[VOICE_CHAT, REPLY]]);
        expect(s.userState[VOICE_CHAT].voiceAB).toBeUndefined();
    });

    test('sin inyectar nada, en los tests no hay voz (no se llama a ElevenLabs)', async () => {
        const realFetch = global.fetch;
        global.fetch = jest.fn();
        try {
            const s = mkSeller({ userState: { [VOICE_CHAT]: afterAudio() }, voice: null });
            await s.send(VOICE_CHAT, REPLY);

            expect(global.fetch).not.toHaveBeenCalled();
            expect(s.client.sendMessage.mock.calls).toEqual([[VOICE_CHAT, REPLY]]);
        } finally {
            global.fetch = realFetch;
        }
    });

    test('se pausó durante el delay: no sale ni el audio ni el texto', async () => {
        const s = mkSeller({ userState: { [VOICE_CHAT]: afterAudio() } });
        const p = s.helpers.sendMessageWithDelay(VOICE_CHAT, REPLY);
        s.pausedUsers.add(VOICE_CHAT);
        await jest.advanceTimersByTimeAsync(9000);

        expect(await p).toBe(false);
        expect(s.client.sendMessage).not.toHaveBeenCalled();
        expect(chatLogRows()).toEqual([]);
        expect(s.userState[VOICE_CHAT].history).toEqual([]);
    });

    test('el primer mensaje del cliente fue un audio (no tenía estado): la marca pasa al estado que creó el flujo', async () => {
        const audioInboundNoState = new Map([[VOICE_CHAT, Date.now()]]);
        const userState = {};
        const s = mkSeller({ userState, sharedState: { audioInboundNoState } });
        userState[VOICE_CHAT] = { step: 'greeting', history: [] };   // lo que hace el flujo antes de contestar
        await s.send(VOICE_CHAT, '¡Hola! ¿Te paso los precios?');

        expect(s.client.sendMessage.mock.calls[0][2]).toEqual({ sendAudioAsVoice: true });
        expect(userState[VOICE_CHAT]).toMatchObject({ lastInboundWasAudio: true, voiceAB: 'voice' });
        expect(audioInboundNoState.has(VOICE_CHAT)).toBe(false);
    });
});

describe('modo remoto: la señal del audio entrante y el eco de la nota de voz', () => {
    const CONTACTS = { [LID]: VOICE_PHONE, [SELF_LID]: '5493410000000' };

    /**
     * Un seller remoto armado como en clientPool.startSeller. El "agente"
     * contesta como agent.js: en send_media manda primero el message_create de
     * la nota de voz (ptt, con media, sin cuerpo, `to` en @lid) y después el
     * ack — `ackDelayMs` más tarde y SIN id, que es lo que pasa en prod cuando
     * se manda al teléfono un chat que WhatsApp guarda bajo @lid.
     */
    function mkRemoteSeller(userState, { ackDelayMs = 0 } = {}) {
        const rc = new RemoteClient(SELLER);
        const botSends = trackBotSends(rc);
        const frames = [];

        let botSeq = 0;
        agentHub.send.mockImplementation((_, frame) => {
            frames.push(frame);
            Promise.resolve().then(() => {
                if (frame.t === 'get_contact') {
                    const number = CONTACTS[frame.contactId];
                    rc.onAgentFrame({ t: 'ack', id: frame.id, ok: true, result: number ? { found: true, id: `${number}@c.us`, number } : { found: false } });
                } else if (frame.t === 'download') {
                    rc.onAgentFrame({ t: 'ack', id: frame.id, ok: true, result: { mimetype: 'audio/ogg; codecs=opus', data: 'T2dnUw==' } });
                } else if (frame.t === 'send_media' || frame.t === 'send_text') {
                    const isMedia = frame.t === 'send_media';
                    const msgId = `true_${LID}_3EB0BOT${++botSeq}`;
                    rc.onAgentFrame({ t: 'outgoing', msg: {
                        id: { _serialized: msgId }, from: SELF_LID, to: LID, fromMe: true, timestamp: 2000000500 + botSeq,
                        body: isMedia ? '' : frame.text, type: isMedia ? 'ptt' : 'chat', hasMedia: isMedia,
                    } });
                    const ack = () => rc.onAgentFrame({ t: 'ack', id: frame.id, ok: true, result: { msgId: null } });
                    if (ackDelayMs) setTimeout(ack, ackDelayMs); else ack();
                }
            });
            return true;
        });

        const pausedUsers = new Set();
        const sharedState = { sellerId: SELLER, connectedAt: 1000000000, sessionAlerts: [], pausedUsers, io: null };
        const config = { alertNumbers: [], globalPause: false };
        const synthesize = jest.fn(async () => AUDIO);
        const helpers = createBotHelpers({ sellerId: SELLER, sharedState, client: rc, userState, config, pausedUsers, redlock: {}, voice: { synthesize } });
        const botQueue = { add: jest.fn(async () => {}) };
        const incoming = createMessageHandler({
            sellerId: SELLER, client: rc, sharedState, userState, config, pausedUsers, pendingMessages: new Map(),
            botQueue, logAndEmit: helpers.logAndEmit, notifyAdmin: jest.fn(async () => {}), handleAdminCommand: jest.fn(), saveState: jest.fn(),
            knowledge: null, dataDir: path.join(os.tmpdir(), 'voice_replies_test', 'data'),
        });
        const outgoing = createOutgoingMessageHandler({ sellerId: SELLER, client: rc, userState, pausedUsers, sharedState, botSends, logAndEmit: helpers.logAndEmit });

        const running = [];
        rc.on('message', (m) => running.push(incoming(m)));
        rc.on('message_create', (m) => running.push(outgoing(m)));
        const settle = async (ms) => { await jest.advanceTimersByTimeAsync(ms); await Promise.all(running.splice(0)); await jest.advanceTimersByTimeAsync(0); };

        let inSeq = 0;
        const fromClient = (o) => rc.onAgentFrame({ t: 'incoming', msg: { id: { _serialized: `false_${LID}_3EB0IN${++inSeq}` }, from: LID, to: SELF_LID, fromMe: false, timestamp: 2000000000 + inSeq, body: '', type: 'chat', ...o } });
        const audioFromClient = () => fromClient({ type: 'ptt', hasMedia: true });
        const pttFromSellerPhone = () => rc.onAgentFrame({ t: 'outgoing', msg: { id: { _serialized: `true_${LID}_3EB0PHONE` }, from: SELF_LID, to: LID, body: '', type: 'ptt', hasMedia: true, fromMe: true, timestamp: 2000000300 } });

        return { rc, helpers, userState, sharedState, pausedUsers, botQueue, synthesize, frames, settle, fromClient, audioFromClient, pttFromSellerPhone };
    }

    // fs real (el audio entrante se guarda en disco) no se lleva bien con los
    // timers de mentira: se dejan correr los microtasks hasta que el handler termina.
    const drain = async (s) => {
        jest.useRealTimers();
        await new Promise(r => setTimeout(r, 300));
        jest.useFakeTimers({ now: Date.now() });
        await s.settle(0);
    };

    test('un audio del cliente prende la señal en su estado; un texto la apaga', async () => {
        const s = mkRemoteSeller({ [VOICE_CHAT]: { step: 'waiting_weight', assignedScript: 'v7', history: [] } });

        s.audioFromClient();
        await drain(s);
        expect(s.userState[VOICE_CHAT].lastInboundWasAudio).toBe(true);
        expect(s.userState[VOICE_CHAT].lastInboundAudioAt).toEqual(expect.any(Number));
        expect(chatLogRows()[0][2]).toMatch(/\|TRANSCRIPTION:quiero bajar diez kilos$/);

        s.fromClient({ body: 'y cuánto sale?' });
        await s.settle(100);
        expect(s.userState[VOICE_CHAT].lastInboundWasAudio).toBe(false);
    });

    test('cliente sin estado: no se le inventa uno, la marca queda aparte', async () => {
        const s = mkRemoteSeller({});

        s.audioFromClient();
        await drain(s);
        expect(s.userState[VOICE_CHAT]).toBeUndefined();
        expect(s.sharedState.audioInboundNoState.has(VOICE_CHAT)).toBe(true);

        s.fromClient({ body: 'hola' });
        await s.settle(100);
        expect(s.userState[VOICE_CHAT]).toBeUndefined();
        expect(s.sharedState.audioInboundNoState.has(VOICE_CHAT)).toBe(false);
    });

    test.each([
        ['con el ack enseguida', {}],
        ['que le gana 400 ms al ack', { ackDelayMs: 400 }],
        ['que le gana 2 s al ack', { ackDelayMs: 2000 }],
    ])('la nota de voz viaja como send_media con isPtt, y su eco %s no pausa ni queda como manual', async (_, agent) => {
        const s = mkRemoteSeller({ [VOICE_CHAT]: afterAudio({ assignedScript: 'v7' }) }, agent);

        const sending = s.helpers.sendMessageWithDelay(VOICE_CHAT, REPLY);
        await s.settle(9000 + (agent.ackDelayMs || 0));
        expect(await sending).toBe(true);
        await s.settle(0);

        const media = s.frames.filter(f => f.t === 'send_media');
        expect(media).toHaveLength(1);
        expect(media[0]).toMatchObject({ chatId: VOICE_CHAT, mimetype: AUDIO.mimetype, data: AUDIO.base64, opts: { caption: '', isPtt: true } });
        expect(s.frames.some(f => f.t === 'send_text')).toBe(false);
        // El ack vuelve sin id, así que el eco se reconoce por contenido (media, sin cuerpo, mismo chat).
        expect(s.pausedUsers.size).toBe(0);
        expect(chatLogRows()).toEqual([[VOICE_PHONE, 'bot', `🎤 ${REPLY}`]]);
    });

    test('un audio que el VENDEDOR graba desde el celular sigue siendo manual y pausa', async () => {
        const s = mkRemoteSeller({ [VOICE_CHAT]: afterAudio({ assignedScript: 'v7' }) });

        s.pttFromSellerPhone();
        await s.settle(100);

        expect([...s.pausedUsers]).toEqual([VOICE_CHAT]);
        expect(chatLogRows()).toEqual([[VOICE_PHONE, 'admin', '🎤 Audio enviado']]);
    });
});
