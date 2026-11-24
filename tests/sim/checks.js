/**
 * Chequeos automáticos de una charla simulada (tests/customer_sim.live.test.js).
 * Devuelven una lista de { level: 'alta'|'media'|'baja', code, detail }. Son
 * reglas que tienen que valer en CUALQUIER charla, más lo que declare el
 * personaje en `expect` (tests/sim/personas.js).
 */
const { _getPrices } = require('../../src/flows/utils/pricing');

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const short = (s, n = 110) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

const ASKS_LOCALITY = /de que (localidad|ciudad|pueblo|zona)|de donde sos|que ciudad o pueblo|vos de que ciudad/;
const ASKS_DATA = /pasame tu \*?nombre|nombre completo|calle y numero|tu direccion/;
const SELLING = /\$\s?\d{2}\.\d{3}|con cual (queres|vas|te gustaria)|60 o 120|pasame tu \*?nombre|de que localidad sos/;
const PAY_ON_DELIVERY = /(pagas|abonas|lo pagas|se paga|pagar)( recien)? (al recibir|cuando (lo )?recib|cuando te lo (llevamos|entregamos))|reparto propio a tu domicilio|llegamos con reparto propio|te lo llevamos nosotros a tu casa/;
const DOCTOR = /consult(a|ar|alo|es|e) (con |a )?(tu |un |el |su )?(medico|doctor|profesional)|habl(a|ar|alo) con tu medico/;

function knownPrices() {
    const out = new Set();
    const walk = (v) => {
        if (v && typeof v === 'object') Object.values(v).forEach(walk);
        else if (typeof v === 'string' && /^\d{1,3}(\.\d{3})+$/.test(v)) out.add(v);
    };
    try { walk(_getPrices()); } catch { /* sin precios: no se chequea */ }
    return out;
}

function runChecks(r, knowledge) {
    const issues = [];
    const add = (level, code, detail) => issues.push({ level, code, detail });
    const ex = r.persona.expect || {};
    const log = r.log;
    const bots = log.filter((l) => l.role === 'bot');
    const idx = (pred) => log.findIndex(pred);

    // 1. Excepciones y silencios
    if (r.errors) add('alta', 'excepcion', `el flujo tiró ${r.errors} excepción(es)`);
    log.forEach((l, i) => {
        if (l.role === 'system' && /no respondió nada/.test(l.content)) {
            const prev = [...log.slice(0, i)].reverse().find((x) => x.role === 'user');
            const p = norm(prev?.content);
            // Callar ante un cierre o un "gracias" es correcto.
            if (!/^(ok|gracias|dale|bueno|listo|igual|chau|nada mas)[\s.!]*$/.test(p.trim()) && !/gracias|equivoque|nada mas|te aviso/.test(p)) {
                add('media', 'sin_respuesta', `el bot no contestó a: "${short(prev?.content)}"`);
            }
        }
    });

    // 2. Mensajes repetidos
    const seen = new Map();
    bots.forEach((b) => {
        const k = norm(b.content).slice(0, 70);
        if (k.length < 25) return;
        seen.set(k, (seen.get(k) || 0) + 1);
    });
    for (const [k, n] of seen) if (n > 1) add(n > 2 ? 'alta' : 'media', 'mensaje_repetido', `${n} veces: "${short(k, 80)}"`);

    // 3. Localidad: preguntada de más, o después de que el cliente ya la dijo
    const localityAsks = bots.filter((b) => ASKS_LOCALITY.test(norm(b.content)));
    if (localityAsks.length >= 3) add('media', 'localidad_3_veces', `preguntó la localidad ${localityAsks.length} veces`);
    const saidPlace = idx((l) => l.role === 'user' && /\b(soy|somos|vivo|estoy)\s+(de|en)\s+\w+/.test(norm(l.content)));
    if (saidPlace >= 0) {
        const after = log.slice(saidPlace + 1).filter((l) => l.role === 'bot' && ASKS_LOCALITY.test(norm(l.content)));
        if (after.length) add('alta', 'localidad_ya_dicha', `el cliente dijo "${short(log[saidPlace].content, 60)}" y después el bot preguntó: "${short(after[0].content.slice(-90))}"`);
    }

    // 4. Precios que no existen en la lista
    const prices = knownPrices();
    if (prices.size) {
        const bad = new Set();
        bots.forEach((b) => (b.content.match(/\$\s?\d{1,3}(?:\.\d{3})+/g) || []).forEach((p) => {
            const v = p.replace(/[^\d.]/g, '');
            if (!prices.has(v)) bad.add(v);
        }));
        // Un total de dos productos o una cuenta "por día" no están en la lista: se informan para mirar.
        if (bad.size) add('media', 'precio_fuera_de_lista', `montos que no están en la lista de precios: ${[...bad].map((v) => '$' + v).join(', ')}`);
    }

    // 5. Cosas que el bot no dice nunca
    bots.forEach((b) => {
        const n = norm(b.content);
        if (/\b(el|un|soy un|con el) bot\b/.test(n) && !/te paso a un asesor/.test(n)) add('media', 'dice_bot', `"${short(b.content)}"`);
        if (DOCTOR.test(n)) add('baja', 'deriva_al_medico', `"${short(b.content)}"`);
        if (/cuantos kilos/.test(n)) add('baja', 'pregunta_kilos', `"${short(b.content)}"`);
        if (b.content.length > 900) add('baja', 'mensaje_muy_largo', `${b.content.length} caracteres: "${short(b.content, 70)}"`);
        if (/\{\{|\}\}|undefined|\bnull\b|NaN/.test(b.content)) add('alta', 'placeholder_sin_llenar', `"${short(b.content)}"`);
    });

    // 6. Dos mensajes del bot seguidos que terminan los dos en pregunta distinta
    for (let i = 1; i < log.length; i++) {
        const a = log[i - 1], b = log[i];
        if (a.role === 'bot' && b.role === 'bot' && /\?\s*\S{0,4}$/.test(a.content.trim()) && /\?\s*\S{0,4}$/.test(b.content.trim())) {
            add('baja', 'dos_preguntas_seguidas', `"${short(a.content.slice(-70))}" + "${short(b.content.slice(-70))}"`);
        }
    }

    // 7. Pedido
    if (ex.noOrder && r.orders.length) add('alta', 'pedido_indebido', `se guardó un pedido que el cliente no hizo: ${JSON.stringify(r.orders[0]).slice(0, 160)}`);
    if (ex.order && !r.orders.length) add('baja', 'no_cerro', `el personaje compraba y no se guardó pedido (fin: ${r.final.step}${r.paused ? ', pausado' : ''})`);
    if (ex.payment && r.orders.length && r.orders[0].paymentMethod && r.orders[0].paymentMethod !== ex.payment) add('alta', 'pago_incorrecto', `pedido con pago "${r.orders[0].paymentMethod}", se esperaba "${ex.payment}"`);
    if (r.orders.length > 1) add('alta', 'pedido_duplicado', `${r.orders.length} pedidos guardados en una charla`);
    r.orders.forEach((o) => {
        if (!o.nombre || !o.calle) add('alta', 'pedido_sin_datos', `pedido guardado sin nombre o calle: ${JSON.stringify({ nombre: o.nombre, calle: o.calle })}`);
        const v = String(o.precio || '').replace(/[^\d.]/g, '');
        if (prices.size && v && !prices.has(v)) add('media', 'pedido_precio_raro', `pedido por $${v}, que no es un precio de lista`);
    });

    // 8. Fuera de zona: nada de pago al recibir ni reparto propio
    if (ex.noPayOnDelivery) {
        const said = idx((l) => l.role === 'user' && /\b(soy|vivo|estoy)\s+(de|en)\b|mendoza|cordoba|mataderos|uranga|chabas|lomas/.test(norm(l.content)));
        const from = said >= 0 ? said : 0;
        // La explicación general de las dos zonas no cuenta: tiene que estar afirmándoselo a él.
        const bad = log.slice(from + 1).filter((l) => l.role === 'bot' && PAY_ON_DELIVERY.test(norm(l.content)) && !/resto del pais|otra zona|si sos de|correo argentino/.test(norm(l.content)));
        if (bad.length) add('alta', 'pago_al_recibir_fuera_de_zona', `"${short(bad[0].content, 140)}"`);
        if (r.orders.some((o) => o.paymentMethod === 'contrarembolso')) add('alta', 'pedido_contrarembolso_fuera_de_zona', 'se guardó un pedido con pago al recibir fuera de la zona de reparto');
    }

    // 9. Edad 70-79: después de decirla, ni cápsulas ni semillas
    if (ex.onlyGotas) {
        const said = idx((l) => l.role === 'user' && /\b7\d\b/.test(l.content));
        if (said >= 0) {
            const bad = log.slice(said + 1).filter((l) => l.role === 'bot' && /(capsulas|semillas)[^.\n]{0,40}\$\s?\d|genial, las \*?(capsulas|semillas)/.test(norm(l.content)));
            if (bad.length) add('alta', 'edad_ofrece_otro_producto', `"${short(bad[0].content, 140)}"`);
        }
        if (r.orders.some((o) => !/gotas/i.test(String(o.producto)))) add('alta', 'edad_pedido_no_gotas', `pedido de ${r.orders[0].producto} a un cliente de 70 a 79 años`);
    }

    // 10. No se le vende: después del segundo mensaje del cliente, nada de precios ni datos
    if (ex.noSelling) {
        const users = log.map((l, i) => (l.role === 'user' ? i : -1)).filter((i) => i >= 0);
        const from = users[1] ?? users[0] ?? 0;
        const bad = log.slice(from + 1).filter((l) => l.role === 'bot' && SELLING.test(norm(l.content)));
        if (bad.length) add('alta', 'le_sigue_vendiendo', `"${short(bad[0].content, 140)}"`);
    }

    // 11. Lo que el personaje prohíbe
    (ex.forbid || []).forEach((src) => {
        const re = new RegExp(src, 'i');
        const from = ex.forbidAfterTurn ? log.map((l, i) => (l.role === 'user' ? i : -1)).filter((i) => i >= 0)[ex.forbidAfterTurn] || 0 : 0;
        const bad = log.slice(from).filter((l) => l.role === 'bot' && re.test(l.content));
        if (bad.length) add('alta', 'dijo_lo_prohibido', `/${src}/ → "${short(bad[0].content, 140)}"`);
    });

    // 12. Pide datos a quien dijo que compra más adelante
    const deferIdx = idx((l) => l.role === 'user' && /cuando cobr|mes que viene|te aviso|mas adelante|manana le hablo|todavia no/.test(norm(l.content)));
    if (deferIdx >= 0) {
        const bad = log.slice(deferIdx + 1, deferIdx + 3).filter((l) => l.role === 'bot' && ASKS_DATA.test(norm(l.content)) && !/agend|para dejarlo cargado|fecha/.test(norm(l.content)));
        if (bad.length) add('media', 'pide_datos_a_quien_posterga', `tras "${short(log[deferIdx].content, 60)}": "${short(bad[0].content, 110)}"`);
    }

    return issues;
}

module.exports = { runChecks };
