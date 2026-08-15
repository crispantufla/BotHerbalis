/**
 * messageTemplates.ts — Shared message builders. Las plantillas viven en el
 * knowledge JSON activo (`knowledge_v7.json`) bajo `flow.*` para que el panel
 * Guiones del dashboard las muestre. Estos builders leen el JSON vía
 * _loadDefaultKnowledge() (cacheado) y sustituyen placeholders con _formatMessage.
 *
 * Si el caller tiene `knowledge` en mano (los step handlers la reciben como
 * parámetro), debería pasarla en el 2° argumento para evitar el load.
 */
import { _getPrice } from '../flows/utils/pricing';
import { _formatMessage } from '../flows/utils/messages';
import logger from './logger';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Detector compartido de "preguntas de precio" — si matchea, el caller debería
 * usar buildPersonalizedPriceResponse en lugar de delegar a IA.
 */
const PRICE_QUESTION_RE = /\b(cu[aá]nto|que precio|qu[eé] precio|cuesta|sale|costo|valor|vale|precio)\b/i;
function isPriceQuestion(text: string): boolean {
    return PRICE_QUESTION_RE.test(text || '');
}

/**
 * Cache del knowledge default (v7) leído del disco. mtime check para invalidar
 * cuando el archivo se edita en runtime (panel Guiones). Solo se usa cuando el
 * caller NO pasa knowledge (típicamente scheduler/auto-approve).
 *
 * Rev. 2026-05-26: V5/V6 fueron archivados a archive/. V7 es el único activo.
 */
let _knowledgeCache: { mtime: number; data: any } | null = null;
const _DEFAULT_KNOWLEDGE_PATH = path.join(__dirname, '..', '..', 'knowledge_v7.json');

function _loadDefaultKnowledge(): any {
    try {
        const stat = fs.statSync(_DEFAULT_KNOWLEDGE_PATH);
        const mtime = stat.mtimeMs;
        if (_knowledgeCache && _knowledgeCache.mtime === mtime) {
            return _knowledgeCache.data;
        }
        const data = JSON.parse(fs.readFileSync(_DEFAULT_KNOWLEDGE_PATH, 'utf8'));
        _knowledgeCache = { mtime, data };
        return data;
    } catch (e: any) {
        logger.error(`[messageTemplates] Failed to load default knowledge: ${e.message}`);
        return null;
    }
}

/**
 * Lee `flow[key].response`. Si la knowledge provista no tiene la entrada,
 * recurre al knowledge default cacheado (knowledge_v7.json del disco). Esto
 * permite que callers con knowledge mock parcial (e.g. tests unitarios) sigan
 * obteniendo el copy correcto sin tener que duplicar todo el JSON.
 */
function _getFlowResponse(knowledge: any, key: string): string | null {
    const direct = knowledge?.flow?.[key]?.response;
    if (direct) return direct;
    const fallback = _loadDefaultKnowledge();
    return fallback?.flow?.[key]?.response || null;
}

/**
 * Build a contextualized price response. Sustituye el rango genérico
 * "$37.000 a $69.000" por una recomendación específica al objetivo del cliente.
 *
 * Decisión por kilos: weightGoal >= 15 → recomienda plan 120 (4 meses sostenidos),
 * <15 → plan 60. Si no hay weightGoal, fallback genérico al producto.
 *
 * Producto: usa state.selectedProduct si está, si no acepta override
 * (extraído del texto del cliente, ej: "que precio las cápsulas").
 */
function buildPersonalizedPriceResponse(state: any, productOverride?: string | null): string {
    const product = productOverride || state.selectedProduct || 'Cápsulas de nuez de la india';
    const productKey = product.includes('Gota') ? 'Gotas' : product.includes('Semilla') ? 'Semillas' : 'Cápsulas';
    const productLabel = productKey === 'Cápsulas' ? 'cápsulas' : productKey === 'Gotas' ? 'gotas' : 'semillas';

    // weightGoal se sigue usando para ELEGIR el plan, pero nunca se dice en voz
    // alta: si el cliente menciona kilos, eso son sus palabras; que el bot se
    // los repita convierte el mensaje en una declaración prohibida sobre la
    // magnitud de la pérdida de peso (Reg. CE 1924/2006, art. 12b).
    const weightGoal = typeof state.weightGoal === 'number' ? state.weightGoal : parseInt(String(state.weightGoal || 0), 10) || 0;
    const recommendsLong = weightGoal >= 15;
    const recommendedPlan = recommendsLong ? '120' : '60';
    const altPlan = recommendsLong ? '60' : '120';

    const priceStr = _getPrice(productKey, recommendedPlan);

    const justification = recommendsLong
        ? `es el plan completo, el que te deja mantener la rutina sin cortes ni recompras`
        : `son ideales para empezar con calma y coger el hábito, sin comprometerte a más de entrada`;

    return `Para lo que me cuentas, las ${productLabel} en plan de *${recommendedPlan} días* son la opción que mejor te encaja — ${justification}.\n\n` +
        `Sale *${priceStr} €*, con envío gratis a toda España.\n\n💵 _Pagas al recibirlo, contra reembolso._\n\n` +
        `¿Seguimos con ese, o te cuento el de ${altPlan} días primero?`;
}

/**
 * Detecta si el cliente menciona un producto específico en su pregunta de precio.
 */
function detectProductInText(text: string): string | null {
    const t = (text || '').toLowerCase();
    if (/\bc[aá]psulas?\b|\bpastillas?\b/.test(t)) return 'Cápsulas de nuez de la india';
    if (/\bgotas?\b/.test(t)) return 'Gotas de nuez de la india';
    if (/\bsemillas?\b|\binfusi[oó]n\b/.test(t)) return 'Semillas de nuez de la india';
    return null;
}

/**
 * TEXTO 4 — Menú de las 2 formas de recibir el pedido (ambas contrarreembolso).
 * Plantilla: knowledge.flow.payment_menu.response.
 */
function buildPaymentMessage(state: any, knowledge?: any): string {
    const k = knowledge || _loadDefaultKnowledge();
    const tpl = _getFlowResponse(k, 'payment_menu');
    if (!tpl) {
        logger.error('[messageTemplates] flow.payment_menu missing in knowledge — using empty fallback');
        return '¿Cómo prefieres recibir el pedido, en casa o en tu oficina de Correos?';
    }
    return _formatMessage(tpl, state);
}

/**
 * Build the order confirmation message sent to the client.
 * Plantilla: knowledge.flow.order_confirmation_{cod|fallback}.response.
 * Used by both handleAdminCommand (manual approval) and autoApproveOrders (scheduler).
 *
 * Aquí solo se cobra contrarreembolso, así que hay una sola plantilla buena.
 * El fallback existe para el estado corrupto: si un pedido llega sin
 * paymentMethod, mejor un texto genérico que una plantilla que prometa algo
 * que no es.
 */
function buildConfirmationMessage(state: any, knowledge?: any): string {
    const k = knowledge || _loadDefaultKnowledge();

    let key: string;
    if (state.paymentMethod === 'contrarembolso') {
        // Mismo pago (contra reembolso) pero dos despedidas: al de casa se le
        // habla del repartidor, al de recogida de su oficina. Con una sola
        // plantilla, la mitad de los pedidos se cerraban con el texto ajeno.
        key = state.shippingChoice === 'retiro' ? 'order_confirmation_pickup' : 'order_confirmation_cod';
    } else {
        logger.warn(`[CONFIRMATION] paymentMethod inesperado: "${state.paymentMethod}" — usando fallback`);
        key = 'order_confirmation_fallback';
    }

    const tpl = _getFlowResponse(k, key);
    if (!tpl) {
        logger.error(`[messageTemplates] flow.${key} missing in knowledge — usando fallback hardcoded`);
        return `📦 CONFIRMACIÓN DE ENVÍO\n\nTotal: ${state.totalPrice || '0'} € — lo pagas al recibirlo.\n\n¿Me confirmas que los datos están bien?`;
    }
    return _formatMessage(tpl, state);
}

/**
 * Resuelve un template del JSON conociendo `knowledge` o cayendo al default
 * cacheado. Export pública para que los step handlers también lean copy del JSON.
 */
function getFlowTemplate(key: string, knowledge?: any): string | null {
    return _getFlowResponse(knowledge, key);
}

export {
    buildConfirmationMessage,
    buildPaymentMessage,
    buildPersonalizedPriceResponse,
    isPriceQuestion,
    detectProductInText,
    getFlowTemplate,
};
