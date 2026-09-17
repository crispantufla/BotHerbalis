/**
 * Lo que el vendedor escribe a mano desde el celular: un 'message_create' propio
 * (fromMe) que no mandó el bot. Tiene que quedar en ChatLog como 'admin' y
 * pausar el chat, para que el bot no lo pise (createOutgoingMessageHandler).
 *
 * Hasta el 2026-09-17 nada de eso pasaba en los chats @lid. whatsapp-web.js arma
 * el mensaje con `to: chat.id`, así que en un chat migrado a @lid el destino
 * llega como <lid>@lid, y el handler descartaba todo lo que no terminara en
 * @c.us. Con casi todos los chats entrantes ya en @lid, en prod no quedaba ni un
 * [MANUAL-CHAT] ni una fila 'admin' fuera de lo enviado desde el panel. Ahora el
 * destino se resuelve al teléfono con el mismo mecanismo que el entrante
 * (getContact + resolución pegajosa en Redis): el mensaje del cliente y la
 * respuesta del vendedor tienen que caer en la misma conversación.
 *
 * El primer deploy de eso (17-sep, 9003a85) se revirtió a los 5 minutos: en
 * remoto el eco del propio envío del bot llega antes que el ack con su id, y los
 * 100 ms fijos que se esperaban no alcanzaron — el saludo del bot pausó el chat
 * como si lo hubiera escrito el vendedor. Los tests de ecos reproducen ese orden.
 */
require('dotenv').config();

// queueService abre una conexión a Redis al importarse (y el .env apunta a prod).
jest.mock('../src/services/queueService', () => ({
    redisConnection: { set: jest.fn(), get: jest.fn() },
}));
jest.mock('../src/services/ai', () => ({
    aiService: { transcribeAudio: jest.fn(async () => null) },
}));
// La pausa y el ChatLog se escriben en la DB, que es la de producción.
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
// El RemoteClient habla con el agente por el AgentHub. Acá el "agente" es cada
// test, que contesta los frames que salen.
jest.mock('../src/services/agentBridge', () => ({
    agentHub: { bind: jest.fn(), dispose: jest.fn(), send: jest.fn(() => true) },
}));

const os = require('os');
const { redisConnection } = require('../src/services/queueService');
const { prisma } = require('../db');
const { agentHub } = require('../src/services/agentBridge');
const { createMessageHandler, createOutgoingMessageHandler, trackBotSends } = require('../src/handlers/messageHandler');
const { createBotHelpers } = require('../src/handlers/botHelpers');
const { RemoteClient } = require('../src/services/remoteClient');
const logger = require('../src/utils/logger');

const SELLER = 'horacio';
const LID = '99887766554433@lid';          // así nombra WhatsApp el chat del cliente
const PHONE = '5491155550000';
const TEL = `${PHONE}@c.us`;               // el mismo cliente, por su teléfono
const SELF_LID = '11223344556677@lid';     // el propio vendedor: `from` de lo que escribe en un chat @lid
const OTRO = '5491166660000@c.us';
// Lo que devuelve get_contact en el agente: el teléfono sale del id del modelo.
const CONTACTS = { [LID]: PHONE, [SELF_LID]: '5493410000000' };

const TOMA_CHARLA = 'Vendedor tomó la conversación a mano (bot en pausa para no pisar)';
const CHAT_NUEVO = 'Conversación iniciada manualmente por admin desde WhatsApp';

// Redis de mentira pero con memoria: la resolución que guarda el entrante la
// tiene que poder leer el saliente.
const redis = new Map();

beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-17T12:00:00Z') });
    jest.clearAllMocks();
    redis.clear();
    redisConnection.set.mockImplementation(async (key, value, ...opts) => {
        if (opts.includes('NX') && redis.has(key)) return null;
        redis.set(key, value);
        return 'OK';
    });
    redisConnection.get.mockImplementation(async (key) => redis.get(key) ?? null);
    agentHub.send.mockImplementation(() => true);
});
afterEach(() => { jest.useRealTimers(); });

function fakeClient(over = {}) {
    return {
        getContactById: jest.fn(async (id) => {
            if (!CONTACTS[id]) throw new Error(`contacto ${id} no encontrado`);
            return { id: { _serialized: `${CONTACTS[id]}@c.us` }, number: CONTACTS[id] };
        }),
        sendMessage: jest.fn(async () => ({ id: { _serialized: `true_${LID}_3EB0BOT` } })),
        ...over,
    };
}

function mkSeller(over = {}) {
    const pausedUsers = over.pausedUsers || new Set();
    const userState = over.userState || {};
    const client = over.client || fakeClient();
    const sendMock = client.sendMessage;
    // El mismo envoltorio que clientPool le pone al cliente de cada seller.
    const botSends = trackBotSends(client);
    const sharedState = { sellerId: SELLER, connectedAt: 1000000000, sessionAlerts: over.sessionAlerts || [], pausedUsers, io: null };
    // logAndEmit real (con la DB mockeada), para ver la fila de ChatLog.
    const helpers = createBotHelpers({ sellerId: SELLER, sharedState, client, userState, config: { alertNumbers: [] }, pausedUsers, redlock: {} });
    const logAndEmit = jest.fn((...a) => helpers.logAndEmit(...a));
    const outgoing = createOutgoingMessageHandler({ sellerId: SELLER, client, userState, pausedUsers, sharedState, botSends, logAndEmit });
    return { client, sendMock, sharedState, userState, pausedUsers, logAndEmit, outgoing };
}

/** Un envío del bot cuyo ack vuelve `ms` después, con `id`. */
const ackIn = (ms, id) => () => new Promise(r => setTimeout(() => r({ id: { _serialized: id } }), ms));

let seq = 0;
/** Un mensaje que el vendedor escribió en el celular, como lo entrega el agente. */
function manual(o = {}) {
    seq++;
    return {
        id: { _serialized: `true_${LID}_3EB0MANUAL${seq}` },
        from: SELF_LID, to: LID,
        body: 'Hola! Te escribo yo, soy Horacio', type: 'chat', hasMedia: false,
        timestamp: 2000000000 + seq, fromMe: true,
        ...o,
    };
}

/** Entrega un mensaje y deja correr lo que dispara (el ChatLog se escribe en segundo plano). */
async function deliver(handler, msg) {
    const done = handler(msg);
    await jest.advanceTimersByTimeAsync(100);
    await done;
    await jest.advanceTimersByTimeAsync(0);
}

const pauseWrites = () => prisma.user.upsert.mock.calls.map(c => c[0]).filter(a => a.update.pauseReason);

describe('el vendedor contesta a mano un chat @lid', () => {
    test('queda en ChatLog como admin, bajo el teléfono real', async () => {
        const s = mkSeller({ userState: { [TEL]: { step: 'waiting_plan_choice' } } });
        const msg = manual({ body: 'Te paso el precio del de 120' });
        await deliver(s.outgoing, msg);

        expect(s.client.getContactById).toHaveBeenCalledWith(LID);
        expect(s.logAndEmit).toHaveBeenCalledWith(TEL, 'admin', 'Te paso el precio del de 120', 'waiting_plan_choice', msg.id._serialized, msg.timestamp * 1000);
        expect(prisma.chatLog.create).toHaveBeenCalledWith({
            data: { userPhone: PHONE, role: 'admin', content: 'Te paso el precio del de 120', instanceId: SELLER, timestamp: new Date(msg.timestamp * 1000) },
        });
    });

    test('pausa el chat que el bot venía atendiendo', async () => {
        const s = mkSeller({ userState: { [TEL]: { step: 'waiting_plan_choice' } } });
        await deliver(s.outgoing, manual());

        expect([...s.pausedUsers]).toEqual([TEL]);
        expect(pauseWrites()).toEqual([{
            where: { phone_instanceId: { phone: PHONE, instanceId: SELLER } },
            update: { pausedAt: expect.any(Date), pauseReason: TOMA_CHARLA },
            create: { phone: PHONE, instanceId: SELLER, pausedAt: expect.any(Date), pauseReason: TOMA_CHARLA },
        }]);
    });

    test('chat que abrió él (el bot nunca habló): pausa como conversación iniciada a mano', async () => {
        const s = mkSeller();
        await deliver(s.outgoing, manual());

        expect([...s.pausedUsers]).toEqual([TEL]);
        expect(pauseWrites().map(a => a.update.pauseReason)).toEqual([CHAT_NUEVO]);
    });

    test('descarta las alertas pendientes de ese cliente', async () => {
        const s = mkSeller({ sessionAlerts: [{ userPhone: TEL, reason: 'x' }, { userPhone: OTRO, reason: 'y' }] });
        await deliver(s.outgoing, manual());

        expect(s.sharedState.sessionAlerts.map(a => a.userPhone)).toEqual([OTRO]);
    });

    test('la resolución queda guardada en Redis, igual que en el entrante', async () => {
        const s = mkSeller();
        await deliver(s.outgoing, manual());

        expect(redisConnection.set).toHaveBeenCalledWith(`lidmap:${SELLER}:${LID}`, TEL, 'EX', 604800);
    });

    test('si el agente no resuelve el contacto, usa la resolución que dejó el entrante', async () => {
        redis.set(`lidmap:${SELLER}:${LID}`, TEL);
        const s = mkSeller({ client: fakeClient({ getContactById: jest.fn(async () => { throw new Error('r'); }) }) });
        await deliver(s.outgoing, manual());

        expect(s.logAndEmit.mock.calls.map(c => c.slice(0, 2))).toEqual([[TEL, 'admin']]);
        expect([...s.pausedUsers]).toEqual([TEL]);
    });

    test('sin resolución ni caché, queda bajo el id crudo (el entrante hace lo mismo)', async () => {
        const s = mkSeller({ client: fakeClient({ getContactById: jest.fn(async () => { throw new Error('r'); }) }) });
        await deliver(s.outgoing, manual());

        expect(s.logAndEmit.mock.calls.map(c => c.slice(0, 2))).toEqual([[LID, 'admin']]);
        expect([...s.pausedUsers]).toEqual([LID]);
    });

    test('ya pausado: se registra, pero la pausa no se vuelve a escribir', async () => {
        const s = mkSeller({ pausedUsers: new Set([TEL]) });
        await deliver(s.outgoing, manual());

        expect(s.logAndEmit).toHaveBeenCalledTimes(1);
        expect(pauseWrites()).toEqual([]);
    });

    test('foto sin texto: se registra con un marcador', async () => {
        const s = mkSeller();
        await deliver(s.outgoing, manual({ body: '', type: 'image', hasMedia: true }));

        expect(s.logAndEmit.mock.calls.map(c => c.slice(0, 3))).toEqual([[TEL, 'admin', '📷 Imagen enviada']]);
    });
});

describe('lo que mandó el bot no es manual', () => {
    const nothingHappened = (s) => {
        expect(s.logAndEmit).not.toHaveBeenCalled();
        expect(s.pausedUsers.size).toBe(0);
        expect(pauseWrites()).toEqual([]);
    };

    test('eco de un envío del bot: nada, y sin gastar un RPC al agente', async () => {
        const s = mkSeller({ userState: { [TEL]: { step: 'waiting_weight' } } });
        const msg = manual({ body: 'Contame cuántos kilos querés bajar' });
        s.sendMock.mockResolvedValueOnce({ id: { _serialized: msg.id._serialized } });
        await s.client.sendMessage(TEL, msg.body);
        await deliver(s.outgoing, msg);

        expect(s.client.getContactById).not.toHaveBeenCalled();
        nothingHappened(s);
    });

    test.each([100, 400, 5000])('el eco llega %i ms antes que el ack del envío: espera el ack y no cuenta', async (ms) => {
        const s = mkSeller({ userState: { [TEL]: { step: 'greeting' } } });
        const msg = manual({ body: '¡Hola! 😊 Soy Elena de Herbalis.' });
        s.sendMock.mockImplementationOnce(ackIn(ms, msg.id._serialized));
        const sending = s.client.sendMessage(TEL, msg.body);

        const done = s.outgoing(msg);
        await jest.advanceTimersByTimeAsync(ms);
        await done;
        await sending;

        expect(s.client.getContactById).not.toHaveBeenCalled();
        nothingHappened(s);
    });

    test('el ack vuelve sin id: lo reconoce por el contenido y lo deja en el log', async () => {
        const warn = jest.spyOn(logger, 'warn');
        const s = mkSeller({ userState: { [TEL]: { step: 'greeting' } } });
        s.sendMock.mockResolvedValueOnce({ id: { _serialized: 'remote_1789000000000' } });
        await s.client.sendMessage(TEL, '¡Hola! 😊 Soy Elena de Herbalis.\n\nTe ayudo a bajar de peso');
        await deliver(s.outgoing, manual({ body: '¡Hola! 😊 Soy Elena de Herbalis.\n\nTe ayudo a bajar de peso' }));

        nothingHappened(s);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Eco de un envío del bot'));
        warn.mockRestore();
    });

    test('imagen del bot cuyo ack vuelve sin id: tampoco', async () => {
        const s = mkSeller();
        s.sendMock.mockResolvedValueOnce({ id: { _serialized: 'remote_1789000000001' } });
        await s.client.sendMessage(TEL, { mimetype: 'image/jpeg', data: 'AAAA' }, { caption: '' });
        await deliver(s.outgoing, manual({ body: '', type: 'image', hasMedia: true }));

        nothingHappened(s);
    });

    test('el mismo texto que el bot le mandó a OTRO chat sí es manual', async () => {
        const s = mkSeller();
        s.sendMock.mockResolvedValueOnce({ id: { _serialized: 'remote_1789000000002' } });
        await s.client.sendMessage(OTRO, 'Te paso el precio');
        await deliver(s.outgoing, manual({ body: 'Te paso el precio' }));

        expect(s.logAndEmit.mock.calls.map(c => c.slice(0, 3))).toEqual([[TEL, 'admin', 'Te paso el precio']]);
        expect([...s.pausedUsers]).toEqual([TEL]);
    });

    test('el mismo texto que el bot mandó a este chat hace más de un minuto sí es manual', async () => {
        const s = mkSeller();
        s.sendMock.mockResolvedValueOnce({ id: { _serialized: 'remote_1789000000003' } });
        await s.client.sendMessage(TEL, 'Te paso el precio');
        await jest.advanceTimersByTimeAsync(61000);
        await deliver(s.outgoing, manual({ body: 'Te paso el precio' }));

        expect([...s.pausedUsers]).toEqual([TEL]);
    });

    test('un envío del bot a otro chat todavía en curso demora al manual hasta que vuelve, no lo frena', async () => {
        const s = mkSeller();
        s.sendMock.mockImplementationOnce(ackIn(800, 'true_otro_3EB0BOT'));
        const sending = s.client.sendMessage(OTRO, 'Hola, ¿cuántos kilos?');

        const done = s.outgoing(manual({ body: 'Soy Horacio, te escribo yo' }));
        await jest.advanceTimersByTimeAsync(700);
        expect(s.logAndEmit).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(100);
        await done;
        await sending;

        expect(s.logAndEmit.mock.calls.map(c => c.slice(0, 2))).toEqual([[TEL, 'admin']]);
        expect([...s.pausedUsers]).toEqual([TEL]);
    });

    test('un envío colgado no frena para siempre: a los 10 s el manual sigue', async () => {
        const s = mkSeller();
        s.sendMock.mockImplementationOnce(() => new Promise(() => {}));
        s.client.sendMessage(OTRO, 'esto nunca vuelve');

        const done = s.outgoing(manual());
        await jest.advanceTimersByTimeAsync(9999);
        expect(s.logAndEmit).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        await done;

        expect([...s.pausedUsers]).toEqual([TEL]);
    });
});

describe('lo que no es un chat con un cliente', () => {
    test.each([
        ['grupo', '120363000000000000@g.us'],
        ['estado', 'status@broadcast'],
        ['canal', '120363000000000001@newsletter'],
    ])('%s: se ignora', async (_, to) => {
        const s = mkSeller();
        await deliver(s.outgoing, manual({ to }));

        expect(s.client.getContactById).not.toHaveBeenCalled();
        expect(s.logAndEmit).not.toHaveBeenCalled();
        expect(s.pausedUsers.size).toBe(0);
    });

    test('mensaje que no es propio: se ignora', async () => {
        const s = mkSeller();
        await deliver(s.outgoing, manual({ fromMe: false, from: LID, to: SELF_LID }));

        expect(s.logAndEmit).not.toHaveBeenCalled();
        expect(s.pausedUsers.size).toBe(0);
    });

    test('anterior a la conexión (historial del teléfono): se ignora', async () => {
        const s = mkSeller();
        await deliver(s.outgoing, manual({ timestamp: 999 }));

        expect(s.logAndEmit).not.toHaveBeenCalled();
        expect(s.pausedUsers.size).toBe(0);
    });
});

test('un chat @c.us sigue igual, sin pasar por la resolución', async () => {
    const s = mkSeller({ userState: { [TEL]: { step: 'waiting_zone' } } });
    await deliver(s.outgoing, manual({ to: TEL, from: '5493410000000@c.us', id: { _serialized: `true_${TEL}_3EB0CUS` } }));

    expect(s.client.getContactById).not.toHaveBeenCalled();
    expect(s.logAndEmit.mock.calls.map(c => c.slice(0, 2))).toEqual([[TEL, 'admin']]);
    expect([...s.pausedUsers]).toEqual([TEL]);
    expect(pauseWrites().map(a => a.update.pauseReason)).toEqual([TOMA_CHARLA]);
});

describe('modo remoto, con los frames del agente', () => {
    /**
     * Un seller remoto armado como en clientPool.startSeller: RemoteClient con
     * trackBotSends, y los dos handlers colgados de sus eventos. El "agente"
     * contesta como agent.js: get_contact con el teléfono, y en send_text primero
     * el message_create (frame outgoing, con `to` en @lid aunque el bot mande al
     * teléfono) y después el ack, `ackDelayMs` más tarde y con o sin el id. En
     * prod el 17-sep el eco le ganó al ack por más de 100 ms.
     */
    function mkRemoteSeller(userState, { ackDelayMs = 0, ackWithoutId = false } = {}) {
        const rc = new RemoteClient(SELLER);
        const botSends = trackBotSends(rc);

        let botSeq = 0;
        agentHub.send.mockImplementation((_, frame) => {
            Promise.resolve().then(() => {
                if (frame.t === 'get_contact') {
                    const number = CONTACTS[frame.contactId];
                    rc.onAgentFrame({ t: 'ack', id: frame.id, ok: true, result: number ? { found: true, id: `${number}@c.us`, number } : { found: false } });
                } else if (frame.t === 'send_text') {
                    const msgId = `true_${LID}_3EB0BOT${++botSeq}`;
                    rc.onAgentFrame({ t: 'outgoing', msg: { id: { _serialized: msgId }, from: SELF_LID, to: LID, body: frame.text, type: 'chat', fromMe: true, timestamp: 2000000500 + botSeq } });
                    const ack = () => rc.onAgentFrame({ t: 'ack', id: frame.id, ok: true, result: ackWithoutId ? { msgId: null } : { msgId } });
                    if (ackDelayMs) setTimeout(ack, ackDelayMs); else ack();
                }
            });
            return true;
        });

        const pausedUsers = new Set();
        const sharedState = { sellerId: SELLER, connectedAt: 1000000000, sessionAlerts: [], pausedUsers, io: null };
        const config = { alertNumbers: [], globalPause: false };
        const helpers = createBotHelpers({ sellerId: SELLER, sharedState, client: rc, userState, config, pausedUsers, redlock: {} });
        const botQueue = { add: jest.fn(async () => {}) };
        const notifyAdmin = jest.fn(async () => {});
        const incoming = createMessageHandler({
            sellerId: SELLER, client: rc, sharedState, userState, config, pausedUsers, pendingMessages: new Map(),
            botQueue, logAndEmit: helpers.logAndEmit, notifyAdmin, handleAdminCommand: jest.fn(), saveState: jest.fn(),
            knowledge: null, dataDir: os.tmpdir(),
        });
        const outgoing = createOutgoingMessageHandler({ sellerId: SELLER, client: rc, userState, pausedUsers, sharedState, botSends, logAndEmit: helpers.logAndEmit });

        const running = [];
        rc.on('message', (m) => running.push(incoming(m)));
        rc.on('message_create', (m) => running.push(outgoing(m)));
        const settle = async (ms) => { await jest.advanceTimersByTimeAsync(ms); await Promise.all(running.splice(0)); await jest.advanceTimersByTimeAsync(0); };

        let inSeq = 0;
        const fromClient = (body) => rc.onAgentFrame({ t: 'incoming', msg: { id: { _serialized: `false_${LID}_3EB0IN${++inSeq}` }, from: LID, to: SELF_LID, body, type: 'chat', fromMe: false, timestamp: 2000000000 + inSeq } });
        const fromSellerPhone = (body) => rc.onAgentFrame({ t: 'outgoing', msg: { id: { _serialized: `true_${LID}_3EB0PHONE` }, from: SELF_LID, to: LID, body, type: 'chat', fromMe: true, timestamp: 2000000300 } });

        return { rc, pausedUsers, botQueue, notifyAdmin, settle, fromClient, fromSellerPhone };
    }

    const roles = () => prisma.chatLog.create.mock.calls.map(c => [c[0].data.userPhone, c[0].data.role, c[0].data.content]);

    test('el cliente escribe, el vendedor contesta desde el celular y el bot ya no le responde', async () => {
        const userState = { [TEL]: { step: 'waiting_plan_choice', assignedScript: 'v7', history: [] } };
        const s = mkRemoteSeller(userState);

        s.fromClient('cuánto sale el de 120?');
        await s.settle(10000);
        expect(s.botQueue.add).toHaveBeenCalledTimes(1);
        expect(s.botQueue.add.mock.calls[0][1].userId).toBe(TEL);

        s.fromSellerPhone('Te lo paso yo, dame un minuto');
        await s.settle(100);
        expect([...s.pausedUsers]).toEqual([TEL]);
        expect(pauseWrites().map(a => a.update.pauseReason)).toEqual([TOMA_CHARLA]);

        s.fromClient('dale, gracias');
        await s.settle(30000);
        expect(s.botQueue.add).toHaveBeenCalledTimes(1);
        expect(s.notifyAdmin).toHaveBeenCalledWith('💬 Cliente en pausa te escribió', TEL, expect.any(String));

        expect(roles()).toEqual([
            [PHONE, 'user', 'cuánto sale el de 120?'],
            [PHONE, 'admin', 'Te lo paso yo, dame un minuto'],
            [PHONE, 'user', 'dale, gracias'],
        ]);
    });

    test('lo que manda el bot al teléfono vuelve como eco @lid y no pausa nada', async () => {
        const s = mkRemoteSeller({ [TEL]: { step: 'waiting_plan_choice', assignedScript: 'v7', history: [] } });

        await s.rc.sendMessage(TEL, 'El de 120 cápsulas sale...');
        await s.settle(100);

        expect(agentHub.send.mock.calls.map(c => c[1].t)).toEqual(['send_text']);
        expect(s.pausedUsers.size).toBe(0);
        expect(roles()).toEqual([]);
    });

    test.each([
        ['le gana 400 ms al ack (lo que pasó en prod el 17-sep)', { ackDelayMs: 400 }],
        ['le gana 2 s al ack', { ackDelayMs: 2000 }],
        ['vuelve con un ack sin id', { ackWithoutId: true }],
        ['le gana 400 ms a un ack sin id', { ackDelayMs: 400, ackWithoutId: true }],
    ])('el eco del saludo del bot %s: no pausa ni queda como admin', async (_, agent) => {
        const s = mkRemoteSeller({ [TEL]: { step: 'greeting', assignedScript: 'v7', history: [] } }, agent);

        const sending = s.rc.sendMessage(TEL, '¡Hola! 😊 Soy Elena de Herbalis.');
        await s.settle((agent.ackDelayMs || 0) + 100);
        await sending;
        await s.settle(0);

        expect(s.pausedUsers.size).toBe(0);
        expect(roles()).toEqual([]);
    });

    test('con el bot mandando, lo que el vendedor escribe desde el celular igual pausa', async () => {
        const s = mkRemoteSeller({ [TEL]: { step: 'waiting_plan_choice', assignedScript: 'v7', history: [] } }, { ackDelayMs: 400 });

        const sending = s.rc.sendMessage(TEL, 'El de 120 cápsulas sale...');
        s.fromSellerPhone('Esperá que te lo confirmo yo');
        await s.settle(500);
        await sending;
        await s.settle(0);

        expect([...s.pausedUsers]).toEqual([TEL]);
        expect(roles()).toEqual([[PHONE, 'admin', 'Esperá que te lo confirmo yo']]);
    });
});
