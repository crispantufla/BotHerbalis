/**
 * leadClassifier.ts
 * Qué hacer cuando escribe alguien de quien todavía no tenemos estado.
 *
 * Esto vivía adentro de processSalesFlow como ~200 líneas de "CHECK 1 / CHECK 2"
 * con try/catch anidados y cuatro `return` tempranos, antes de que el router
 * llegara siquiera a rutear. Era el bloque más anidado del repo.
 *
 * Dos preguntas, en este orden:
 *
 *   CHECK 1 (Orders)  — ¿ya nos compró? Padrón histórico importado → derivar a
 *                       humano. Comprador real con intención → recompra sin
 *                       presentación. Comprador real sin intención → post-venta.
 *   CHECK 2 (Chat)    — ¿ya venía hablando con nosotros? Conversación anterior
 *                       al bot, mensajes de post-venta en el historial, o
 *                       historial extenso sin intención de compra → pausa.
 *
 * `stop: true` significa "ya se resolvió acá, el flujo no sigue".
 */

import { UserState, FlowStep } from '../types/state';
import { pauseUser } from '../services/pauseService';
import { _setStep, _cleanPhone, _pushHistory } from './utils/flowHelpers';
import logger from '../utils/logger';

const { prisma } = require('../../db');

// Keywords that signal clear purchase intent — if present, don't auto-pause
// Note: normalizedText is accent-stripped, so only unaccented variants are needed
const PURCHASE_INTENT_KEYWORDS = /\b(comprar|quiero comprar|quiero pedir|me interesa|precio|precios|cuanto sale|cuanto cuesta|quiero encargar|necesito comprar|hagan envios|hacen envios|quisiera pedir|quisiera comprar|quiero adquirir|quiero ordenar|tienen capsulas|tienen semillas|tienen gotas|nuez de la india|la direccion|mi direccion|te paso mis datos|mis datos|los datos|te paso la direccion|informacion|quiero saber|quiero mas info|bajar|adelgazar|kilos|kilo|capsulas|semillas|cemillas|semilla|gotas|gota|peso|perder peso|bajar de peso|10 kg|20 kg|mas de 20)\b/i;

export interface InitialStateOptions {
    step: string;
    adSource?: string | null;
    assignedScript?: string;
}

/**
 * Estado limpio para un chat nuevo. Único lugar donde se define la forma
 * inicial de UserState — playground.routes.js tenía su propia copia y se
 * desincronizaba cada vez que se agregaba un campo acá.
 */
export function createInitialUserState(opts: InitialStateOptions): UserState {
    return {
        step: opts.step,
        history: [],
        cart: [],
        summary: "",
        partialAddress: {},
        selectedProduct: null,
        selectedPlan: null,
        geoRejected: false,
        stepEnteredAt: Date.now(),
        addressAttempts: 0,
        fieldReaskCount: {},
        lastAddressMsg: null,
        postdatado: null,
        pendingOrder: null,
        currentWeight: undefined,
        lastActivityAt: Date.now(),
        adSource: opts.adSource ?? null,
        // Freeze the A/B assignment on first message so subsequent messages
        // don't re-roll the variant mid-conversation under 'rotacion' mode.
        assignedScript: opts.assignedScript,
    } as UserState;
}

const _instanceId = (dependencies: any): string =>
    dependencies.sellerId || dependencies.sharedState?.sellerId || process.env.INSTANCE_ID || 'default';

/** CHECK 1 — ¿el teléfono ya tiene pedidos? */
async function _checkExistingOrders(
    userId: string,
    text: string,
    normalizedText: string,
    state: UserState,
    dependencies: any,
    saveState: (userId?: string) => void
): Promise<{ stop: boolean }> {
    // Si el phone tiene Order en este seller O en el namespace legacy
    // (__legacy_import__ — clientes históricos importados desde Clientes_AR.txt),
    // es un cliente conocido → ruta post-sale para que el bot no le hable.
    try {
        const cleanPhone = _cleanPhone(userId);
        const instanceId = _instanceId(dependencies);
        const existingOrder = await prisma.order.findFirst({
            where: {
                userPhone: cleanPhone,
                instanceId: { in: [instanceId, '__legacy_import__'] },
            },
            orderBy: { createdAt: 'desc' }
        });

        if (!existingOrder) return { stop: false };

        if (existingOrder.instanceId === '__legacy_import__') {
            // Contacto del padrón histórico importado (Clientes_AR.txt,
            // __legacy_import__): es un CLIENTE VIEJO, no un lead nuevo. El bot
            // NO lo atiende (ni saludo ni flujo de venta): se PAUSA y se alerta
            // al admin para que lo tome un humano. (rev 2026-06-04, reporte
            // 5493564578992 — antes el match amplio de PURCHASE_INTENT_KEYWORDS
            // lo mandaba a waiting_weight y la IA respondía "de nuevo, ¿cuántos
            // kilos?" en vez de derivarlo.)
            logger.info(`[ORDER-CHECK] User ${userId} es cliente del padrón histórico (import legacy) → mensaje de derivación + pausa + alerta admin.`);
            // Mensaje al cliente: avisarle que se lo deriva a una oficial de
            // atención (no dejarlo en visto). Después se pausa para que lo tome
            // un humano (rev 2026-06-04).
            const derivMsg = 'Teniendo en cuenta que ya sos cliente, te derivo con una oficial de atención al cliente que te va a ayudar enseguida 😊';
            await dependencies.sendMessageWithDelay(userId, derivMsg);
            await pauseUser(
                userId,
                '📇 Cliente del padrón histórico (import)',
                { sharedState: dependencies.sharedState, notifyAdmin: dependencies.notifyAdmin },
                `Teléfono del import histórico (Clientes_AR.txt). Volvió a escribir: "${text.substring(0, 100)}". Se le avisó la derivación y se pausó para atención humana.`
            );
            return { stop: true };
        }

        if (PURCHASE_INTENT_KEYWORDS.test(normalizedText)) {
            // Comprador real que VUELVE con intención de compra (pidió precio,
            // quiere comprar, etc.): NO lo pausamos como post-venta — es el
            // lead más tibio que hay. Lo atendemos como recompra pero SIN la
            // presentación (ya nos conoce): saltamos el greeting yendo directo
            // a waiting_weight, y el step responde su consulta.
            logger.info(`[ORDER-CHECK] User ${userId} es comprador real y muestra intención de compra → atender como recompra (sin presentación).`);
            _setStep(state, FlowStep.WAITING_WEIGHT);
            (state as any).isReturningClient = true;
            saveState(userId);
            return { stop: false };
        }

        logger.info(`[ORDER-CHECK] User ${userId} has existing order (status: ${existingOrder.status}). Routing to post-sale.`);
        _setStep(state, FlowStep.COMPLETED);
        state.selectedProduct = existingOrder.products;
        saveState(userId);
        // No frena: el guard de post-venta de salesFlow lo levanta más abajo.
        return { stop: false };
    } catch (err: any) {
        logger.error(`[ORDER-CHECK] Failed to query orders for ${userId}:`, err.message);
        return { stop: false };
    }
}

/**
 * Trae los últimos 15 mensajes del chat: primero de la DB local, y si está
 * vacía, de la API nativa de WhatsApp.
 *
 * Devuelve `preExisting: true` si detectó que la conversación es anterior a la
 * conexión del bot (ver CHECK 2b abajo).
 */
async function _recentMessages(
    userId: string,
    dependencies: any
): Promise<{ messages: any[]; preExistingSince: number | null }> {
    const INSTANCE_ID = _instanceId(dependencies);
    const cleanPhone = _cleanPhone(userId);

    let dbMessages = await prisma.chatLog.findMany({
        where: { userPhone: cleanPhone, instanceId: INSTANCE_ID },
        orderBy: { timestamp: 'desc' },
        take: 15
    });

    if (dbMessages.length > 0 || !dependencies.client) {
        return { messages: dbMessages, preExistingSince: null };
    }

    // Fallback to WhatsApp's native API if local DB has NO history
    try {
        const chat = await dependencies.client.getChatById(userId);
        if (!chat) return { messages: dbMessages, preExistingSince: null };

        const waMsgs = await chat.fetchMessages({ limit: 15 });
        const waMapped = waMsgs.map((wm: any) => ({
            id: wm.id._serialized,
            userPhone: cleanPhone,
            instanceId: INSTANCE_ID,
            role: wm.fromMe ? 'bot' : 'user',
            content: wm.body || '',
            timestamp: new Date(wm.timestamp * 1000)
        }));
        // Reverse to match DB descending order (latest first)
        dbMessages = waMapped.reverse();
        logger.info(`[SMART-DETECT] DB vacío para ${userId}. Recuperados ${waMapped.length} msjs nativos de WhatsApp.`);

        // --- CHECK 2b: Pre-existing chat detection ---
        // whatsapp-web.js does NOT sync old message bodies on a fresh session,
        // so fetchMessages() returns [] for old chats until the chat is opened manually.
        // However, chat.lastMessage.timestamp IS available immediately (it's metadata).
        // If that timestamp predates our bot's connection → pre-existing conversation → pause.
        if (waMsgs.length === 0 && dependencies.connectedAt) {
            try {
                const lastTs: number | undefined = chat?.lastMessage?.timestamp; // Unix seconds
                if (lastTs && lastTs < dependencies.connectedAt) {
                    return { messages: dbMessages, preExistingSince: lastTs };
                }
            } catch (metaErr: any) {
                logger.warn(`[PRE-EXISTING] Could not read chat metadata for ${userId}: ${metaErr.message}`);
            }
        }
    } catch (waErr: any) {
        logger.warn(`[SMART-DETECT] Error recuperando historial nativo WA de ${userId}: ${waErr.message}`);
    }

    return { messages: dbMessages, preExistingSince: null };
}

/** ¿Alguno de los mensajes salientes es de post-venta? */
function _hasPostSaleMessage(outgoing: any[]): boolean {
    return outgoing.some((m: any) => {
        const body = (m.content || '').trim().toUpperCase();
        if (body.includes('MENSAJE DE HERBALIS')) return true;
        if (body.includes('CONFIRMACIÓN DE ENVÍO') || body.includes('CONFIRMACION DE ENVIO')) return true;
        if (body.includes('PEDIDO INGRESADO')) return true;
        if (/^CO\d{9}$/i.test(body)) return true;
        return false;
    });
}

/** CHECK 2 — ¿ya venía una conversación con este teléfono? */
async function _checkChatHistory(
    userId: string,
    text: string,
    normalizedText: string,
    dependencies: any
): Promise<{ stop: boolean }> {
    const pauseDeps = { sharedState: dependencies.sharedState, notifyAdmin: dependencies.notifyAdmin };

    try {
        const { messages, preExistingSince } = await _recentMessages(userId, dependencies);

        if (preExistingSince) {
            logger.info(`[PRE-EXISTING] User ${userId}: last chat msg at ${new Date(preExistingSince * 1000).toISOString()}, bot connected at ${new Date(dependencies.connectedAt * 1000).toISOString()}. Auto-pausing.`);
            await pauseUser(
                userId,
                '📋 Conversación pre-existente (anterior al bot)',
                pauseDeps,
                `Conversación iniciada antes de que el bot se conectara. Último mensaje: ${new Date(preExistingSince * 1000).toLocaleString('es-AR')}`
            );
            return { stop: true };
        }

        const outgoing = messages.filter((m: any) => m.role === 'bot' || m.role === 'admin' || m.role === 'system');

        if (_hasPostSaleMessage(outgoing)) {
            logger.info(`[POST-SALE] User ${userId} has post-sale messages in local DB. Auto-pausing.`);
            await pauseUser(userId, '📦 Cliente post-venta (historial en DB)', pauseDeps, `El usuario tiene mensajes post-venta en el historial. No ha iniciado conversación nueva.`);
            return { stop: true };
        }

        // If no post-sale message exists, let's see if there's extensive prior interaction
        // 1-4 outgoing = likely bots replying to ads. 5+ means extensive interaction history.
        if (outgoing.length >= 5) {
            if (PURCHASE_INTENT_KEYWORDS.test(normalizedText)) {
                logger.info(`[SMART-DETECT] User ${userId} has prior history (outgoing bot: ${outgoing.length}) but shows purchase intent. Allowing sales flow.`);
                return { stop: false };
            }
            logger.info(`[SMART-DETECT] User ${userId}: has ${outgoing.length} msgs and NO purchase intent. Auto-pausing.`);
            await pauseUser(
                userId,
                `😴 Cliente con historial extenso (${outgoing.length}+ mensajes)`,
                pauseDeps,
                `${outgoing.length} mensajes previos. Volvió a escribir: "${text.substring(0, 100)}"`
            );
            return { stop: true };
        }

        if (outgoing.length > 0) {
            logger.info(`[SMART-DETECT] User ${userId} has ${outgoing.length} prior message(s) (< 10 threshold) in DB. Treating as active prospect.`);
        }
        return { stop: false };
    } catch (err: any) {
        logger.error(`[SMART-DETECT] Failed to fetch local chat history DB for ${userId}:`, err.message);
        return { stop: false };
    }
}

/**
 * Corre los dos checks sobre un lead recién inicializado. Puede mutar `state`
 * (step, selectedProduct, isReturningClient) y/o pausar al usuario.
 */
export async function classifyNewLead(
    userId: string,
    text: string,
    normalizedText: string,
    state: UserState,
    dependencies: any,
    saveState: (userId?: string) => void
): Promise<{ stop: boolean }> {
    const orders = await _checkExistingOrders(userId, text, normalizedText, state, dependencies, saveState);
    if (orders.stop) return orders;

    // Only run this if we didn't already route to post-sale via Orders
    if (state.step === 'completed') return { stop: false };

    return await _checkChatHistory(userId, text, normalizedText, dependencies);
}
