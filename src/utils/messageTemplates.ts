/**
 * messageTemplates.ts — Shared message builders. Las plantillas viven en los
 * knowledge JSONs (`knowledge_v5.json` / `knowledge_v6.json`) bajo `flow.*` para
 * que el panel Guiones del dashboard las muestre. Estos builders leen el JSON
 * vía _loadDefaultKnowledge() (cacheado) y sustituyen placeholders con _formatMessage.
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
 * Cache del knowledge default (v6) leído del disco. mtime check para invalidar
 * cuando el archivo se edita en runtime (panel Guiones). Solo se usa cuando el
 * caller NO pasa knowledge (típicamente scheduler/auto-approve).
 */
let _knowledgeCache: { mtime: number; data: any } | null = null;
const _DEFAULT_KNOWLEDGE_PATH = path.join(__dirname, '..', '..', 'knowledge_v6.json');

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
 * recurre al knowledge default cacheado (knowledge_v6.json del disco). Esto
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

    const weightGoal = typeof state.weightGoal === 'number' ? state.weightGoal : parseInt(String(state.weightGoal || 0), 10) || 0;
    const recommendsLong = weightGoal >= 15;
    const recommendedPlan = recommendsLong ? '120' : '60';
    const altPlan = recommendsLong ? '60' : '120';

    const priceStr = _getPrice(productKey, recommendedPlan);

    const savingsLine = '\n\n💳 _Pagás con Mercado Pago: tarjeta, débito, app MP o efectivo en Pago Fácil/Rapipago._';

    let justification: string;
    if (weightGoal >= 20) {
        justification = `cubren los 4 meses que el cuerpo necesita para un descenso sostenido de +20 kg, sin rebote`;
    } else if (weightGoal >= 15) {
        justification = `son las que mejor andan para tu objetivo — el descenso es progresivo y sostenido`;
    } else if (weightGoal > 0) {
        justification = `son ideales para empezar y ver cómo te va, antes de extender el tratamiento si lo necesitás`;
    } else {
        justification = `son las que más recomiendan nuestros clientes`;
    }

    const objetivoFrase = weightGoal > 0
        ? `Para tu objetivo (${weightGoal >= 20 ? '+20 kg' : weightGoal >= 15 ? `~${weightGoal} kg` : `hasta ${weightGoal} kg`})`
        : 'Para tu caso';

    return `${objetivoFrase}, las ${productLabel} en plan de *${recommendedPlan} días* son las que mejor andan — ${justification}.\n\n` +
        `Sale *$${priceStr}*.${savingsLine}\n\n` +
        `¿Avanzamos con ese, o te cuento del de ${altPlan} días primero?`;
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
 * TEXTO 4 — Menú de las 3 opciones de pago. Plantilla: knowledge.flow.payment_menu.response.
 */
function buildPaymentMessage(state: any, knowledge?: any): string {
    const k = knowledge || _loadDefaultKnowledge();
    const tpl = _getFlowResponse(k, 'payment_menu');
    if (!tpl) {
        logger.error('[messageTemplates] flow.payment_menu missing in knowledge — using empty fallback');
        return '¿Cómo preferís realizar el pago?';
    }
    return _formatMessage(tpl, state);
}

/**
 * Build the order confirmation message sent to the client.
 * Plantilla: knowledge.flow.order_confirmation_{mp|transfer|cod|fallback}.response.
 * Used by both handleAdminCommand (manual approval) and autoApproveOrders (scheduler).
 */
function buildConfirmationMessage(state: any, knowledge?: any): string {
    const k = knowledge || _loadDefaultKnowledge();

    let key: string;
    if (state.paymentMethod === 'mercadopago') {
        key = 'order_confirmation_mp';
    } else if (state.paymentMethod === 'transferencia') {
        key = 'order_confirmation_transfer';
    } else if (state.paymentMethod === 'contrarembolso') {
        // Modelo nuevo (may-2026): contrarrembolso = retiro en sucursal, paga total al retirar.
        // Modelo legacy (pre-may-2026): contrarrembolso = seña $10k + saldo al cartero.
        // En ambos casos se usa la misma plantilla 'order_confirmation_cod' (el texto fue
        // reescrito para el modelo nuevo; senaAmount=0 en retiro hace que {{CARTO_LINE}}
        // quede vacío).
        key = 'order_confirmation_cod';
    } else {
        logger.warn(`[CONFIRMATION] paymentMethod inesperado: "${state.paymentMethod}" (senaPaid=${state.senaPaid}, senaAmount=${state.senaAmount}) — usando fallback`);
        key = 'order_confirmation_fallback';
    }

    const tpl = _getFlowResponse(k, key);
    if (!tpl) {
        logger.error(`[messageTemplates] flow.${key} missing in knowledge — usando fallback hardcoded`);
        return `📦 CONFIRMACIÓN DE ENVÍO\n\nTotal: $${state.totalPrice || '0'}\n\n¿Me confirmás que podés retirar en sucursal si fuera necesario?`;
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
