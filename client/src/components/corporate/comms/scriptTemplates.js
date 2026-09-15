import { BANK_ALIAS, BANK_HOLDER, fillPricePlaceholders } from '../../../utils/scriptPlaceholders';

// Arma los textos del guion para insertarlos en el chat, con los datos de la
// charla. Solo cubre los placeholders que usa V7 (V5/V6 se archivaron en may-2026).
export function formatScriptMessage(text, { chat, prices }) {
    if (!text) return text;
    // Precios: SOLO desde /api/prices — NUNCA números inventados en código.
    // Si un precio no cargó, el placeholder {{PRICE_*}} queda visible tal
    // cual (el sweep final los preserva) para que el admin no mande un
    // valor viejo/falso al cliente sin darse cuenta.
    let result = fillPricePlaceholders(text, prices);
    const product = chat?.selectedProduct || chat?.cart?.[0]?.product || 'Producto';
    const plan = chat?.selectedPlan || chat?.cart?.[0]?.plan || '60';
    let total = chat?.totalPrice || '';
    if (!total && chat?.cart?.length > 0) {
        total = chat.cart
            .reduce((s, i) => s + parseInt((i.price || '0').toString().replace(/\D/g, '')), 0)
            .toLocaleString('es-AR');
    }
    result = result
        .replace(/{{PRODUCT}}/g, product)
        .replace(/{{PRODUCT_DETAIL}}/g, product)
        .replace(/{{PLAN}}/g, plan)
        .replace(/{{PLAN_DETAIL}}/g, `${plan} días`)
        .replace(/{{TOTAL}}/g, total ? total : '0');

    // Datos bancarios y entrega standard.
    // POSTDATADO_LINE: muestra la entrega estándar por Correo (4 días hábiles,
    // prepago). Para el preview no contamos con state.postdatado — el server lo
    // resuelve en runtime (y en reparto propio la línea va vacía).
    result = result
        .replace(/{{ALIAS}}/g, BANK_ALIAS)
        .replace(/{{TITULAR}}/g, BANK_HOLDER)
        .replace(/{{POSTDATADO_LINE}}/g, '✔ Entrega estimada: 4 días hábiles desde la confirmación\n')
        .replace(/{{ENVIO_LINE}}/g, '✔ Correo Argentino — envío a domicilio\n')
        .replace(/{{LOCALIDAD}}/g, 'tu localidad')
        .replace(/{{LINK}}/g, '(link se genera al confirmar el pago)');

    // Sweep defensivo: cualquier {{X}} residual queda invisible en el preview
    // (igual que hace el server-side _formatMessage antes de mandar al cliente)
    // — EXCEPTO los de precios: esos quedan visibles tal cual para que un
    // precio no cargado nunca se convierta en silencio o número inventado.
    result = result.replace(/\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g, (match, tag) =>
        /^(PRICE_|ADICIONAL_MAX$|COSTO_LOGISTICO$)/.test(tag) ? match : '');

    return result;
}

// Extrae product/plan/total del state primero, sino escanea mensajes.
// Plan SOLO se confía si el usuario lo dijo (el bot muestra ambos 60/120,
// escanear todo daría false positives). Total SOLO si el bot mencionó UN
// único precio (no una lista).
export function extractConfirmationContext(chat, messages) {
    let product = chat?.selectedProduct || chat?.cart?.[0]?.product || null;
    let plan = chat?.selectedPlan || chat?.cart?.[0]?.plan || null;
    let total = chat?.totalPrice || null;

    if (!product || !plan || !total) {
        const userText = messages.filter(m => !m.fromMe).map(m => m.body || '').join('\n');
        const botText  = messages.filter(m =>  m.fromMe).map(m => m.body || '').join('\n');
        const allText  = messages.map(m => m.body || '').join('\n');

        if (!product) {
            if (/c[áa]psulas?/i.test(allText)) product = 'Cápsulas de Nuez de la India';
            else if (/semillas?/i.test(allText)) product = 'Semillas de Nuez de la India';
            else if (/gotas?/i.test(allText))    product = 'Gotas de Nuez de la India';
        }
        if (!plan) {
            if (/\b120\b/.test(userText)) plan = '120';
            else if (/\b60\b/.test(userText)) plan = '60';
        }
        if (!total) {
            const priceMatches = botText.match(/\$\s*\d{2,3}[.,]\d{3}/g) || [];
            const uniquePrices = [...new Set(priceMatches)];
            if (uniquePrices.length === 1) {
                total = uniquePrices[0].replace(/\$\s*/, '').replace(',', '.');
            }
        }
    }
    return { product, plan, total };
}

export function buildConfirmMessage(template, { product, plan, total }, prices) {
    // Construimos un "fake chat" con los valores del modal para reusar
    // formatScriptMessage (cubre PRODUCT/PLAN/TOTAL + ALIAS, TITULAR,
    // POSTDATADO_LINE, PRODUCT_DETAIL, PLAN_DETAIL, etc.). Sin esto algunos
    // placeholders del order_confirmation_* quedaban literales.
    const totalClean = String(total || '').replace(/^\$+/, '').trim();
    const fakeChat = {
        selectedProduct: product || 'Producto',
        selectedPlan: plan || '60',
        totalPrice: totalClean,
        cart: [],
    };
    return formatScriptMessage(template, { chat: fakeChat, prices });
}
