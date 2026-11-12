/**
 * POST /api/resume-chat: despausa un chat y encola lo que el cliente escribió
 * para que el bot conteste YA (botón "Retomar" del panel).
 *
 * Con `text` explícito se encola ese texto. Sin `text`, el servidor lo arma con
 * los mensajes del cliente posteriores a la última respuesta (bot o admin) en
 * ChatLog; si no hay ninguno responde 409 y NO despausa.
 *
 * La DB del .env es la de producción: `../db` va mockeado entero.
 */
const mockDb = {
    chatLog: { findMany: jest.fn() },
    user: { findUnique: jest.fn() },
};
jest.mock('../db', () => ({ prisma: mockDb }));
// Auth y resolución del vendedor no son lo que se prueba acá: el test arma `req`.
jest.mock('../src/api/routes/routeHelpers', () => ({
    withSeller: () => [],
    getInstanceId: (req) => req.sellerId || null,
    isOwnerOrAdmin: () => true,
}));
jest.mock('../src/services/ai', () => ({ aiService: {} }));
jest.mock('whatsapp-web.js', () => ({ MessageMedia: class {} }));
const mockUnpause = jest.fn(async () => {});
jest.mock('../src/services/pauseService', () => ({
    unpauseUser: (...args) => mockUnpause(...args),
    pauseUser: jest.fn(),
}));

const buildRouter = require('../src/api/routes/chat.routes');

const SELLER = 'horacio';
const PHONE = '5493415550000';
const CHAT = `${PHONE}@c.us`;

const router = buildRouter({});
const handler = router.stack
    .find(l => l.route && l.route.path === '/resume-chat' && l.route.methods.post)
    .route.stack.slice(-1)[0].handle;

function makeReq(body, { known = true } = {}) {
    const emit = jest.fn();
    const queue = { add: jest.fn(async () => ({})) };
    const sharedState = {
        userState: known ? { [CHAT]: { step: 'greeting', history: [] } } : {},
        pausedUsers: new Set([CHAT]),
        io: { to: jest.fn(() => ({ emit })) },
    };
    return {
        req: { body, sellerId: SELLER, sellerInstance: { sharedState, client: {}, queue } },
        queue, emit, sharedState,
    };
}

async function call(req) {
    const res = { statusCode: 200, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    await handler(req, res);
    return res;
}

// ChatLog llega del más nuevo al más viejo (orderBy timestamp desc).
const newestFirst = (...rows) => rows.reverse().map(([role, content]) => ({ role, content }));

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.chatLog.findMany.mockResolvedValue([]);
    mockDb.user.findUnique.mockResolvedValue(null);
});

describe('POST /resume-chat', () => {
    test('con text explícito: despausa y encola ese texto sin leer ChatLog', async () => {
        const { req, queue, emit } = makeReq({ chatId: CHAT, text: '  cuánto sale?  ' });
        const res = await call(req);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, chatId: CHAT });
        expect(mockDb.chatLog.findMany).not.toHaveBeenCalled();
        expect(mockUnpause).toHaveBeenCalledWith(CHAT, req.sellerInstance.sharedState, SELLER);
        expect(emit).toHaveBeenCalledWith('bot_status_change', { chatId: CHAT, paused: false, sellerId: SELLER });
        expect(queue.add).toHaveBeenCalledTimes(1);
        const [jobName, payload] = queue.add.mock.calls[0];
        expect(jobName).toBe('process-message');
        expect(payload).toMatchObject({ userId: CHAT, combinedText: 'cuánto sale?' });
    });

    test('sin text: arma el texto con lo que el cliente escribió después de la última respuesta', async () => {
        mockDb.chatLog.findMany.mockResolvedValue(newestFirst(
            ['user', 'esto ya fue contestado'],
            ['bot', '¡Hola! ¿Te paso los precios?'],
            ['user', 'hola'],
            ['system', 'Pausado manualmente por el panel'],
            ['user', 'MEDIA_AUDIO:/media/audio/aud_1_abc.ogg|TRANSCRIPTION:quiero saber el precio de las gotas'],
            ['user', '📷 Imagen recibida'],
            ['user', 'MEDIA_AUDIO:/media/audio/aud_2_def.ogg'],
            ['user', 'soy de Rosario'],
        ));
        const { req, queue } = makeReq({ chatId: CHAT });
        const res = await call(req);

        expect(res.statusCode).toBe(200);
        expect(queue.add.mock.calls[0][1].combinedText).toBe('hola quiero saber el precio de las gotas soy de Rosario');
        expect(mockUnpause).toHaveBeenCalledTimes(1);
    });

    test('sin text: una respuesta del vendedor (admin) también corta lo pendiente', async () => {
        mockDb.chatLog.findMany.mockResolvedValue(newestFirst(
            ['user', 'hola'],
            ['admin', 'Hola, ya te paso los precios'],
            ['user', 'dale gracias'],
        ));
        const { req, queue } = makeReq({ chatId: CHAT });
        await call(req);

        expect(queue.add.mock.calls[0][1].combinedText).toBe('dale gracias');
    });

    test('sin text: la consulta a ChatLog filtra por teléfono y por vendedor', async () => {
        mockDb.chatLog.findMany.mockResolvedValue(newestFirst(['user', 'hola']));
        const { req } = makeReq({ chatId: CHAT });
        await call(req);

        expect(mockDb.chatLog.findMany).toHaveBeenCalledTimes(1);
        const args = mockDb.chatLog.findMany.mock.calls[0][0];
        expect(args.where).toEqual({ userPhone: PHONE, instanceId: SELLER });
        expect(args.orderBy).toEqual({ timestamp: 'desc' });
    });

    test('sin pendientes: 409 con mensaje claro, no despausa ni encola', async () => {
        mockDb.chatLog.findMany.mockResolvedValue(newestFirst(
            ['user', 'hola'],
            ['bot', '¡Hola! ¿Te paso los precios?'],
        ));
        const { req, queue, emit } = makeReq({ chatId: CHAT });
        const res = await call(req);

        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({ error: 'No hay ningún mensaje del cliente sin responder' });
        expect(mockUnpause).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(queue.add).not.toHaveBeenCalled();
    });

    test('solo marcadores sin texto (imagen, audio sin transcribir): también 409', async () => {
        mockDb.chatLog.findMany.mockResolvedValue(newestFirst(
            ['bot', '¿Te paso los precios?'],
            ['user', '📷 Imagen recibida'],
            ['user', '🎤 Audio recibido (no se pudo descargar)'],
        ));
        const { req, queue } = makeReq({ chatId: CHAT });
        const res = await call(req);

        expect(res.statusCode).toBe(409);
        expect(mockUnpause).not.toHaveBeenCalled();
        expect(queue.add).not.toHaveBeenCalled();
    });

    test('rechaza un contacto que no es del vendedor: 403, sin despausar', async () => {
        const { req, queue } = makeReq({ chatId: CHAT, text: 'hola' }, { known: false });
        const res = await call(req);

        expect(res.statusCode).toBe(403);
        expect(res.body.error).toMatch(/no está asociado a este vendedor/);
        // El guard busca al contacto solo dentro de este vendedor.
        expect(mockDb.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({
            where: { phone_instanceId: { phone: PHONE, instanceId: SELLER } },
        }));
        expect(mockDb.chatLog.findMany).not.toHaveBeenCalled();
        expect(mockUnpause).not.toHaveBeenCalled();
        expect(queue.add).not.toHaveBeenCalled();
    });

    test('sin chatId: 400', async () => {
        const { req } = makeReq({});
        const res = await call(req);
        expect(res.statusCode).toBe(400);
        expect(mockUnpause).not.toHaveBeenCalled();
    });
});
