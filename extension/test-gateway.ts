/**
 * test-gateway.ts — Harness LOCAL para probar la extensión (Fase 1).
 *
 * Monta SOLO el gateway (agentBridge) + el adaptador (remoteClient) y responde con un
 * eco. NO importa Prisma, Redis, BullMQ ni salesFlow → cero contacto con producción.
 * Sirve para validar que la extensión por DOM lee mensajes entrantes y puede enviar.
 *
 * Correr:  npx tsx extension/test-gateway.ts
 * Extensión → opciones:  gatewayUrl = ws://localhost:3100/agent
 *                        sellerId   = domtest
 *                        token      = (el de abajo)
 */
import http from 'http';
import { agentHub } from '../src/services/agentBridge';
import { RemoteClient } from '../src/services/remoteClient';

const SELLER = process.env.TEST_SELLER || 'domtest';
const TOKEN = process.env.TEST_TOKEN || 'test-token-123';
const PORT = Number(process.env.TEST_PORT || 3100);

// El gateway valida contra esta env var.
process.env[`WA_AGENT_TOKEN_${SELLER.toUpperCase()}`] = TOKEN;

const server = http.createServer((_req, res) => { res.writeHead(200); res.end('herbalis test gateway'); });
agentHub.attach(server);

const rc: any = new RemoteClient(SELLER);

rc.on('qr', () => console.log('[TEST] esperando login (escaneá el QR en la extensión)'));
rc.on('ready', () => console.log('[TEST] ✅ agente READY — sesión cargada en la extensión'));
rc.on('change_state', (s: string) => console.log('[TEST] estado:', s));
rc.on('disconnected', (r: string) => console.log('[TEST] agente desconectado:', r));

rc.on('message', async (m: any) => {
    console.log(`\n[TEST] ◀ ENTRANTE de ${m.from}: ${JSON.stringify(m.body)}`);
    try {
        const sent = await rc.sendMessage(m.from, `🤖 eco: ${m.body}`);
        console.log(`[TEST] ▶ respondido (msgId ${sent.id._serialized})`);
    } catch (e: any) {
        console.error('[TEST] ✗ error al responder:', e.message);
    }
});

rc.on('message_create', (m: any) => {
    if (!m.fromMe) return;
    console.log(`[TEST] ↪ saliente/manual de ${m.from}: ${JSON.stringify(m.body)}`);
});

rc.initialize();

server.listen(PORT, () => {
    console.log('────────────────────────────────────────────────────────');
    console.log(`[TEST] gateway de prueba escuchando en  ws://localhost:${PORT}/agent`);
    console.log(`[TEST] sellerId: ${SELLER}`);
    console.log(`[TEST] token:    ${TOKEN}`);
    console.log('[TEST] Configurá la extensión con esos 3 datos y mandá un WhatsApp.');
    console.log('────────────────────────────────────────────────────────');
});
