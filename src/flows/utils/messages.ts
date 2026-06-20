import { _getPrices } from './pricing';
import { _formatPrice } from './cartHelpers';
import logger from '../../utils/logger';

function _formatMessage(text: string | string[], state: any): string {
    if (!text) return "";

    // Si es un array de respuestas, elige una al azar para dar variabilidad
    let textToFormat = Array.isArray(text) ? text[Math.floor(Math.random() * text.length)] : text;

    const prices = _getPrices();

    // Para anclaje de valor en planes: precio por día del 120. Devuelve string
    // formateado con punto de miles (ej: "1.234"). Vacío si el precio es inválido.
    const _perDay = (priceStr: string | undefined, days: number): string => {
        if (!priceStr) return '';
        const parsed = parseInt(priceStr.replace(/\./g, ''), 10);
        if (isNaN(parsed) || days <= 0) return '';
        return _formatPrice(Math.round(parsed / days));
    };

    // Normaliza el formato de un precio guardado en prices.json: tolera valores
    // con o sin punto de miles ("49900" o "49.900") y SIEMPRE devuelve dotted
    // ("49.900"). Sin esto, si un precio se carga sin punto desde el dashboard,
    // se mostraba feo ("$49900") en prices_both mientras otros salían "$36.900".
    const _fmt = (priceStr: string | undefined): string => {
        if (!priceStr) return '';
        const n = parseInt(String(priceStr).replace(/\./g, ''), 10);
        return isNaN(n) ? String(priceStr) : _formatPrice(n);
    };

    let formatted = textToFormat;
    // Replace {{PRICE_PRODUCT_PLAN}}
    formatted = formatted.replace(/{{PRICE_CAPSULAS_60}}/g, _fmt(prices['Cápsulas']?.['60']));
    formatted = formatted.replace(/{{PRICE_CAPSULAS_120}}/g, _fmt(prices['Cápsulas']?.['120']));
    formatted = formatted.replace(/{{PRICE_SEMILLAS_60}}/g, _fmt(prices['Semillas']?.['60']));
    formatted = formatted.replace(/{{PRICE_SEMILLAS_120}}/g, _fmt(prices['Semillas']?.['120']));
    formatted = formatted.replace(/{{PRICE_GOTAS_60}}/g, _fmt(prices['Gotas']?.['60']));
    formatted = formatted.replace(/{{PRICE_GOTAS_120}}/g, _fmt(prices['Gotas']?.['120']));
    // Anclaje de valor: precio/día para los planes 120 (justifica el ticket vs el de 60).
    formatted = formatted.replace(/{{PRICE_PER_DAY_CAPSULAS_120}}/g, _perDay(prices['Cápsulas']?.['120'], 120));
    formatted = formatted.replace(/{{PRICE_PER_DAY_SEMILLAS_120}}/g, _perDay(prices['Semillas']?.['120'], 120));
    formatted = formatted.replace(/{{PRICE_PER_DAY_GOTAS_120}}/g, _perDay(prices['Gotas']?.['120'], 120));
    // Placeholder genérico — resuelve segun selectedProduct (default Cápsulas).
    // Útil para FAQ/copy de venta donde no se sabe de antemano el producto.
    {
        const sp = state?.selectedProduct || '';
        const pkey: 'Cápsulas' | 'Gotas' | 'Semillas' =
            sp.includes('Gota') ? 'Gotas' :
            sp.includes('Semilla') ? 'Semillas' : 'Cápsulas';
        formatted = formatted.replace(/{{PRICE_PER_DAY_120}}/g, _perDay(prices[pkey]?.['120'], 120));
    }
    // Política mayo 2026: el adicional por contra reembolso fue eliminado, por lo
    // que {{PRICE_TOTAL_*_60}} ahora es idéntico a {{PRICE_*_60}}. Se mantienen
    // los placeholders sólo por compatibilidad con plantillas legacy.
    formatted = formatted.replace(/{{PRICE_TOTAL_CAPSULAS_60}}/g, _fmt(prices['Cápsulas']?.['60']));
    formatted = formatted.replace(/{{PRICE_TOTAL_SEMILLAS_60}}/g, _fmt(prices['Semillas']?.['60']));
    formatted = formatted.replace(/{{PRICE_TOTAL_GOTAS_60}}/g, _fmt(prices['Gotas']?.['60']));
    formatted = formatted.replace(/{{ADICIONAL_MAX}}/g, '0');
    formatted = formatted.replace(/{{COSTO_LOGISTICO}}/g, _fmt(prices.costoLogistico) || '18.000');

    // Replace dynamic order placeholders if state is provided
    if (state) {
        if (state.selectedProduct) {
            formatted = formatted.replace(/{{PRODUCT}}/g, state.selectedProduct);
        }
        if (state.selectedPlan) {
            formatted = formatted.replace(/{{PLAN}}/g, state.selectedPlan);
            // PLAN_MONTHS: forma humana del plan ("2 meses" / "4 meses" / "{N} meses").
            // Usado por preference_X en V5 cuando se le indica la dosis al cliente.
            const planNum = parseInt(String(state.selectedPlan), 10);
            const months = isNaN(planNum) ? '' : `${Math.round(planNum / 30)} meses`;
            formatted = formatted.replace(/{{PLAN_MONTHS}}/g, months);
        }
        // DOSAGE_REASON: comentario sobre la dosis recomendada en V5 según los kilos
        // a bajar. Texto pedido por horacio (corrección 2026-05-26):
        //   - tier 1 (≤10 kg, plan 60d): "alcanza para tu objetivo"
        //   - tier 2 (10-20 kg, plan 120d): "te puede sobrar pero muchas usan el sobrante de mantenimiento"
        //   - tier 3 (>20 kg, plan 120d): "es lo que el cuerpo necesita"
        {
            const w = typeof state.weightGoal === 'number' ? state.weightGoal : parseInt(String(state.weightGoal || 0), 10) || 0;
            let reason = '';
            if (w > 0 && w <= 10) reason = 'Con el plan de 60 días te alcanza para tu objetivo.';
            else if (w > 10 && w <= 20) reason = 'Con el plan de 120 días te puede sobrar un poco; muchas clientas usan el sobrante como mantenimiento.';
            else if (w > 20) reason = 'El plan de 120 días es el tiempo que tu cuerpo necesita para bajar tranqui, sin rebote.';
            formatted = formatted.replace(/{{DOSAGE_REASON}}/g, reason);
        }
        if (state.totalPrice) {
            formatted = formatted.replace(/{{TOTAL}}/g, state.totalPrice);
        }
        // Precios del producto seleccionado (para TEXTO 3: muestra plan 60 vs 120).
        // Si no hay selectedProduct (state inconsistente), default a Cápsulas — es
        // el producto más recomendado y evita que el placeholder salga literal al
        // cliente. Caso real: conversación de Silvina 14/05 10:39 — bot recomendó
        // cápsulas, cliente cambió a gotas via AI, state.selectedProduct quedó
        // null y el bot mandó "${{PRICE_60}}" textual.
        {
            const sp = state.selectedProduct || '';
            const productKey: 'Cápsulas' | 'Gotas' | 'Semillas' =
                sp.includes('Gota') ? 'Gotas' :
                sp.includes('Semilla') ? 'Semillas' : 'Cápsulas';
            formatted = formatted.replace(/{{PRICE_60}}/g, prices[productKey]?.['60'] || '');
            formatted = formatted.replace(/{{PRICE_120}}/g, prices[productKey]?.['120'] || '');
        }
        // Mercado Pago link.
        formatted = formatted.replace(/{{LINK}}/g, state.mpPaymentLinkUrl || '');
        // Seña / anticipo para flujos contra reembolso.
        const totalInt = parseInt(String(state.totalPrice || '0').replace(/\./g, ''), 10) || 0;
        const fmtNum = (n: number) => n.toLocaleString('es-AR').replace(/,/g, '.');
        if (state.senaAmount && state.senaAmount > 0) {
            const sena = state.senaAmount;
            const remainder = Math.max(0, totalInt - sena);
            formatted = formatted.replace(/{{SENA_AMOUNT}}/g, fmtNum(sena));
            formatted = formatted.replace(/{{SENA_AMOUNT_FMT}}/g, fmtNum(sena));
            formatted = formatted.replace(/{{SENA_REMAINDER}}/g, fmtNum(remainder));
            formatted = formatted.replace(/{{SALDO}}/g, fmtNum(remainder));
        } else {
            // Anticipo fijo $10k para el flujo COD "anticipo al alias" cuando aún no se setea senaAmount.
            const remainder10k = Math.max(0, totalInt - 10000);
            formatted = formatted.replace(/{{SALDO}}/g, fmtNum(remainder10k));
        }
        // Cart-aware: producto + plan combinados cuando hay multi-item.
        const cart = Array.isArray(state.cart) ? state.cart : [];
        if (cart.length > 0) {
            const productDetail = cart.map((i: any) => i.product).join(' + ') || state.selectedProduct || 'Nuez de la India';
            const planDetail = cart.map((i: any) => `${i.plan} días`).join(' + ') || (state.selectedPlan ? `${state.selectedPlan} días` : '60 días');
            formatted = formatted.replace(/{{PRODUCT_DETAIL}}/g, productDetail);
            formatted = formatted.replace(/{{PLAN_DETAIL}}/g, planDetail);
        } else {
            formatted = formatted.replace(/{{PRODUCT_DETAIL}}/g, state.selectedProduct || 'Nuez de la India');
            formatted = formatted.replace(/{{PLAN_DETAIL}}/g, state.selectedPlan ? `${state.selectedPlan} días` : '60 días');
        }
        // Línea condicional postdatado vs entrega estándar (confirmación final).
        // Modelo jun-2026: domicilio PREPAGO (tarjeta/transferencia) 6-7 días; retiro 7-10.
        const _isRetiro = state.shippingChoice === 'retiro' || state.paymentMethod === 'contrarembolso';
        const _entrega = _isRetiro ? '7 a 10 días hábiles' : '6 a 7 días hábiles';
        const postdatadoLine = state.postdatado
            ? `📅 Envío programado: ${state.postdatado}\n`
            : `✔ Entrega estimada: ${_entrega} desde la confirmación\n`;
        formatted = formatted.replace(/{{POSTDATADO_LINE}}/g, postdatadoLine);
        // Línea condicional saldo al cartero vs retiro en sucursal (confirmación COD).
        const isSucursal = state.pendingOrder?.calle?.toLowerCase() === 'a sucursal';
        if (state.senaAmount && state.senaAmount > 0) {
            const remainder = Math.max(0, totalInt - state.senaAmount);
            const remainderFmt = fmtNum(remainder);
            const cartoLine = isSucursal
                ? `✔ Retiro en sucursal — pagás el saldo *$${remainderFmt}* en efectivo al retirar`
                : `✔ Saldo al cartero: *$${remainderFmt}* en efectivo al recibir`;
            formatted = formatted.replace(/{{CARTO_LINE}}/g, cartoLine);
        } else {
            formatted = formatted.replace(/{{CARTO_LINE}}/g, '');
        }
    }

    // Alias bancario + titular oficiales (constantes).
    formatted = formatted.replace(/{{ALIAS}}/g, 'HERBALIS.TIENDA');
    formatted = formatted.replace(/{{TITULAR}}/g, 'BIO ORIGEN S.A.S.');
    formatted = formatted.replace(/{{ANTICIPO}}/g, '10.000');

    // Sweep defensivo final: si quedó algún placeholder {{X}} sin resolver
    // (state corrupto, key nueva sin handler, etc.), NO lo enviamos literal
    // al cliente. Logueamos warning con el placeholder específico y lo
    // borramos del texto. Es preferible un mensaje incompleto que un
    // "${{PRICE_60}}" mostrado al cliente.
    const leakedPlaceholders = formatted.match(/\{\{\s*[A-Z_][A-Z0-9_]*\s*\}\}/g);
    if (leakedPlaceholders) {
        logger.warn(`[FORMAT_MESSAGE] Placeholders sin resolver detectados — borrando antes de enviar: ${leakedPlaceholders.join(', ')}`);
        formatted = formatted.replace(/\{\{\s*[A-Z_][A-Z0-9_]*\s*\}\}/g, '');
    }

    return formatted;
}

/**
 * _isDuplicate
 * Checks if the proposed message is identical or near-identical to the last bot message.
 * Prevents the bot from sending the same text twice in a row.
 */
function _isDuplicate(proposedMsg: string, history: any[]): boolean {
    if (!history || history.length === 0) return false;
    // Find last bot message
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'bot') {
            const lastMsg = history[i].content.trim().toLowerCase();
            const newMsg = proposedMsg.trim().toLowerCase();
            // Exact match or very similar (within 10 chars difference)
            if (lastMsg === newMsg) return true;
            // Also catch near-duplicates (same start, same core message)
            if (lastMsg.length > 30 && newMsg.length > 30 && lastMsg.substring(0, 50) === newMsg.substring(0, 50)) return true;
            break; // Only check the LAST bot message
        }
    }
    return false;
}


interface QuickReplyItem {
    label: string;
    message: string;
}

/**
 * _getAdminSuggestions
 * Returns contextual quick-reply suggestions for the admin based on the step and user message.
 * Legacy string[] return for backwards compat with _pauseAndAlert display.
 */
function _getAdminSuggestions(step: string, userMessage: string): string[] {
    return _getQuickReplies(step, userMessage).map(qr => qr.message);
}

/**
 * _getQuickReplies
 * Returns actionable quick replies the admin can trigger with "Xr1", "Xr2", "Xr3".
 * Each reply has a label (shown in alert) and a message (sent to client).
 */
function _getQuickReplies(step: string, userMessage: string): QuickReplyItem[] {
    const normalized = (userMessage || '').toLowerCase();

    // Rejection / refusal
    if (/no (quiero|puedo|acepto|me interesa)|no gracias|dejá|dej[aá]/i.test(normalized)) {
        return [
            { label: 'Dejar puerta abierta', message: 'Tranqui, si cambiás de idea acá estamos 😊' },
            { label: 'Preguntar duda', message: '¿Hay algo puntual que te genere duda? Estoy para ayudarte.' },
            { label: 'Ofrecer descuento', message: 'Mirá, te puedo hacer un precio especial si te decidís hoy. ¿Te interesa?' },
        ];
    }

    // Trust / scam concerns
    if (/estafa|trucho|mentira|robo|engaño|chanta|falso|fraude/i.test(normalized)) {
        return [
            { label: 'Mostrar trayectoria', message: 'Llevamos 13 años con más de 50.000 clientes satisfechos. ¿Querés que te pase testimonios?' },
            { label: 'Aclarar pago', message: 'Entiendo tu preocupación. El pago con tarjeta de crédito tiene protección al comprador: si no recibís el producto te devuelven el 100%.' },
            { label: 'Dejar abierto', message: 'Respeto tu decisión. Si querés verificar, podés buscarnos en Google o Instagram. Acá estamos cuando quieras.' },
        ];
    }

    // Price / payment concerns
    if (/caro|precio|plata|dinero|pagar|costoso|barato|descuento|cuota/i.test(normalized)) {
        return [
            { label: 'Justificar valor', message: 'El precio incluye tratamiento completo + envío gratis + seguimiento personalizado. Es una inversión en tu salud.' },
            { label: 'Ofrecer plan corto', message: '¿Querés que te muestre un plan más corto para arrancar? Así probás y si te gusta seguís.' },
            { label: 'Descuento hoy', message: 'Te hago un descuento especial si confirmás hoy. ¿Te interesa?' },
        ];
    }

    // Waiting for data — privacy concern
    if (step === 'waiting_data') {
        return [
            { label: 'Aclarar privacidad', message: 'Tus datos solo se usan para el envío, no los compartimos con nadie.' },
            { label: 'Retiro en sucursal', message: 'Si preferís, podés retirar en sucursal y no necesitás dar dirección.' },
            { label: 'Ayudar con datos', message: '¿Necesitás ayuda para completar los datos? Te guío paso a paso.' },
        ];
    }

    // Waiting for OK — close the sale
    if (step === 'waiting_ok') {
        return [
            { label: 'Opciones de envío', message: 'Podés recibir en tu domicilio o retirar en sucursal, lo que te quede mejor.' },
            { label: 'Urgencia amable', message: 'Te comento que este precio es por tiempo limitado. ¿Seguimos?' },
            { label: 'Resolver duda', message: '¿Tenés alguna duda antes de confirmar? Estoy para ayudarte.' },
        ];
    }

    // Waiting for plan choice
    if (step === 'waiting_plan_choice') {
        return [
            { label: 'Recomendar 120', message: 'Te recomiendo el plan de 120 días: es el tratamiento completo y el resultado se sostiene sin rebote.' },
            { label: 'Explicar diferencias', message: '¿Querés que te explique las diferencias entre el plan de 60 y el de 120 días?' },
            { label: 'Probar con 60', message: 'Si preferís arrancar más liviano, el plan de 60 días es una buena opción para probar.' },
        ];
    }

    // Generic fallback
    return [
        { label: 'Preguntar si necesita ayuda', message: '¡Hola! ¿Necesitás ayuda con algo? Estoy acá para lo que necesites.' },
        { label: 'Recordar producto', message: 'Te recuerdo que estabamos viendo los productos de Herbalis. ¿Seguimos?' },
        { label: 'Cerrar amable', message: 'Cualquier duda que tengas, acá estamos. ¡Éxitos!' },
    ];
}

export { _formatMessage, _isDuplicate, _getAdminSuggestions, _getQuickReplies };

