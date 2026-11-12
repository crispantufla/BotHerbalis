/**
 * En remoto el `body` de una imagen puede traer la miniatura en base64. El
 * 12-nov-2026 una de esas tiras entró al flujo como texto y el bot contestó con
 * la lista de precios. Ahora se trata como imagen sin epígrafe.
 */
// queueService abre una conexión a Redis al importarse.
jest.mock('../src/services/queueService', () => ({
    redisConnection: { set: jest.fn(async () => 'OK'), get: jest.fn(async () => null) },
}));
jest.mock('whatsapp-web.js', () => ({ MessageMedia: class {} }));
jest.mock('../db', () => ({ prisma: {} }));
jest.mock('../src/services/ai', () => ({ aiService: {} }));
jest.mock('../src/services/pauseService', () => ({ pauseUser: jest.fn().mockResolvedValue(undefined) }));

const { handleNonTextContent } = require('../src/handlers/incomingSteps');

const USER = '5493410000005@c.us';
const BLOB = '/9j/4AAQSkZJRgABAgAAAQABAAD' + 'A'.repeat(400);

function runtime(step) {
    return {
        sellerId: 'horacio',
        sharedState: { pausedUsers: new Set() },
        client: { sendMessage: jest.fn().mockResolvedValue(undefined) },
        userState: step ? { [USER]: { step, history: [] } } : {},
        logAndEmit: jest.fn(),
        notifyAdmin: jest.fn().mockResolvedValue(undefined),
    };
}

describe('imagen que llega como texto en base64', () => {
    test.each([
        ['con type image', { type: 'image', body: BLOB }],
        ['sin type de imagen', { type: 'chat', body: BLOB }],
    ])('%s: no sigue al flujo y queda registrada como imagen, sin la tira', async (_n, msg) => {
        const rt = runtime('waiting_weight');
        const out = await handleNonTextContent(msg, USER, msg.body, rt);
        expect(out).toBeNull();
        expect(rt.logAndEmit).toHaveBeenCalledWith(USER, 'user', '📷 Imagen recibida', 'waiting_weight');
    });

    test('en el paso de pago se toma como comprobante: avisa al admin', async () => {
        const rt = runtime('waiting_transfer_confirmation');
        expect(await handleNonTextContent({ type: 'chat', body: BLOB }, USER, BLOB, rt)).toBeNull();
        expect(rt.notifyAdmin).toHaveBeenCalled();
    });

    test('un texto normal sigue al flujo sin cambios', async () => {
        const rt = runtime('waiting_weight');
        expect(await handleNonTextContent({ type: 'chat', body: 'hola, cuanto sale' }, USER, 'hola, cuanto sale', rt)).toBe('hola, cuanto sale');
    });

    test('una imagen con epígrafe real conserva el epígrafe', async () => {
        const rt = runtime('waiting_weight');
        expect(await handleNonTextContent({ type: 'image', body: 'este es mi comprobante' }, USER, 'este es mi comprobante', rt)).toMatch(/este es mi comprobante/);
    });
});
