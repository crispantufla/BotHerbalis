/**
 * Al apagar, los mensajes de clientes que estaban en la espera de agrupado
 * pasan a la cola de Redis en vez de perderse. Caso del 12-nov-2026: un deploy
 * reinició el bot con un audio recién llegado y la clienta quedó sin respuesta.
 *
 * Se prueba la función sola: importar clientPool levanta medio bot, así que todo
 * lo pesado va mockeado.
 */
jest.mock('../db', () => ({ prisma: {}, pool: {} }));
jest.mock('whatsapp-web.js', () => ({ Client: jest.fn(), LocalAuth: jest.fn(), MessageMedia: jest.fn() }));
jest.mock('../src/services/queueService', () => ({ createQueue: jest.fn(), createWorker: jest.fn(), shutdownSellerQueue: jest.fn() }));
jest.mock('../src/services/ai', () => ({ aiService: {} }));

let flushPendingToQueue;
try {
    ({ flushPendingToQueue } = require('../src/services/clientPool'));
} catch (e) {
    // Si el módulo no carga en el entorno de test, el motivo tiene que verse.
    throw new Error(`No pude cargar clientPool para el test: ${e.message}`);
}

function mkInstance(entries) {
    const calls = [];
    const pendingMessages = new Map(entries);
    return {
        calls,
        instance: {
            sellerId: 'horacio',
            pendingMessages,
            worker: { pause: jest.fn(async () => { calls.push('pause'); }) },
            queue: { add: jest.fn(async (name, data) => { calls.push(`add:${data.userId}`); }) },
        },
    };
}

describe('flushPendingToQueue', () => {
    test('pausa el worker y encola cada chat pendiente con sus mensajes en orden', async () => {
        const timer = setTimeout(() => { throw new Error('el debounce no debía dispararse'); }, 50);
        const { instance, calls } = mkInstance([
            ['5493410000001@c.us', { timer, startTime: 111, messages: [{ text: 'segundo', timestamp: 20 }, { text: 'primero', timestamp: 10 }] }],
            ['5493410000002@c.us', { timer: null, startTime: 222, messages: [{ text: 'hola', timestamp: 5 }] }],
        ]);
        const n = await flushPendingToQueue(instance);
        await new Promise((r) => setTimeout(r, 80)); // el timer cancelado no dispara

        expect(n).toBe(2);
        expect(calls[0]).toBe('pause');                       // el worker se pausa ANTES de encolar
        expect(instance.worker.pause).toHaveBeenCalledWith(true);
        expect(instance.queue.add).toHaveBeenCalledWith('process-message',
            { userId: '5493410000001@c.us', combinedText: 'primero segundo', effectiveScript: 'v7', startTime: 111 },
            { removeOnComplete: true, removeOnFail: 100 });
        expect(instance.pendingMessages.size).toBe(0);
    });

    test('sin pendientes no toca el worker ni la cola', async () => {
        const { instance } = mkInstance([]);
        expect(await flushPendingToQueue(instance)).toBe(0);
        expect(instance.worker.pause).not.toHaveBeenCalled();
        expect(instance.queue.add).not.toHaveBeenCalled();
    });

    test('si la cola falla para un chat, sigue con los demás', async () => {
        const { instance } = mkInstance([
            ['a@c.us', { messages: [{ text: 'uno', timestamp: 1 }] }],
            ['b@c.us', { messages: [{ text: 'dos', timestamp: 1 }] }],
        ]);
        instance.queue.add = jest.fn().mockRejectedValueOnce(new Error('redis caído')).mockResolvedValueOnce(undefined);
        expect(await flushPendingToQueue(instance)).toBe(1);
        expect(instance.queue.add).toHaveBeenCalledTimes(2);
    });

    test('una entrada sin texto no se encola', async () => {
        const { instance } = mkInstance([['a@c.us', { messages: [] }]]);
        expect(await flushPendingToQueue(instance)).toBe(0);
        expect(instance.queue.add).not.toHaveBeenCalled();
    });
});
