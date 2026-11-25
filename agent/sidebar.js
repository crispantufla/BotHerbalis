/**
 * sidebar.js — Panel lateral (botonera) inyectado en la ventana de WhatsApp del agente.
 *
 * A la DERECHA, empuja WhatsApp (no la tapa), REDIMENSIONABLE (arrastrar el borde izq).
 * Replica el "Asistente IA" del chat del dashboard:
 *   - Pausar/Reactivar bot, Resumen, Reiniciar chat, Cobro por Mercado Pago
 *   - Guion: pasos clickeables (insertan el mensaje del paso en la caja)
 *   - Confirmar pedido CON mensaje / Solo registrar (SIN mensaje)
 * El panel llama a funciones que el agente expone (hbAction / hbGetScript / hbMpLink…).
 *
 * Todo lo que se abre (confirmaciones, monto a cobrar, datos del pedido) es un
 * diálogo PROPIO: los window.prompt/confirm nativos no escalaban con el tamaño
 * de letra y el monto pasaba por un replace(/\D/g) que leía "49.900,50" como
 * 4.990.050.
 */
'use strict';

const PANEL_W = 360;

function bootstrap(initW) {
    if (window.__hbInit) return;
    window.__hbInit = true;
    let curW = initW || 360;

    function openChatName() {
        const h = document.querySelector('#main header');
        if (!h) return null;
        const t = (h.innerText || '').split('\n')[0].trim();
        return t || null;
    }

    // Resolución de placeholders de PRECIO del guion con los precios reales de
    // /api/prices. Solo precios (globales y conocidos); los placeholders que
    // dependen del cliente ({{NOMBRE}}, {{LINK}}, {{TOTAL}}…) se dejan literales
    // a propósito para que el vendedor los complete a mano.
    function buildPriceMap(prices) {
        const P = prices || {};
        const cap = P['Cápsulas'] || {}, sem = P['Semillas'] || {}, got = P['Gotas'] || {};
        // Normaliza a "49.900" tolere o no punto de miles el valor guardado
        // (mismo criterio que _fmt/_formatPrice del runtime — sin esto salía
        // "$49900" para unos productos y "$36.900" para otros).
        const fmt = (v) => { const n = parseInt(String(v == null ? '' : v).replace(/\D/g, ''), 10); return isNaN(n) ? '' : n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); };
        const perDay = (v, days) => { const n = parseInt(String(v == null ? '' : v).replace(/\D/g, ''), 10); return n ? fmt(Math.round(n / days)) : ''; };
        return {
            PRICE_CAPSULAS_60: fmt(cap['60']), PRICE_CAPSULAS_120: fmt(cap['120']),
            PRICE_SEMILLAS_60: fmt(sem['60']), PRICE_SEMILLAS_120: fmt(sem['120']),
            PRICE_GOTAS_60: fmt(got['60']), PRICE_GOTAS_120: fmt(got['120']),
            PRICE_TOTAL_CAPSULAS_60: fmt(cap['60']), PRICE_TOTAL_SEMILLAS_60: fmt(sem['60']), PRICE_TOTAL_GOTAS_60: fmt(got['60']),
            PRICE_PER_DAY_CAPSULAS_120: perDay(cap['120'], 120), PRICE_PER_DAY_SEMILLAS_120: perDay(sem['120'], 120), PRICE_PER_DAY_GOTAS_120: perDay(got['120'], 120),
            PRICE_60: fmt(cap['60']), PRICE_120: fmt(cap['120']),
            COSTO_LOGISTICO: fmt(P.costoLogistico) || '18.000', ADICIONAL_MAX: '0',
        };
    }
    function resolvePrices(text, map) {
        return resolveMap(text, map);
    }

    // Constantes del negocio (siempre resolubles — nunca van al modal).
    const HB_CONST = { ALIAS: 'HERBALIS.TIENDA', TITULAR: 'BIO ORIGEN S.A.S.', ANTICIPO: '10.000' };
    // Labels legibles para el modal de relleno y para la vista previa del paso.
    const HB_LABELS = {
        PRODUCT_DETAIL: 'Producto', PLAN_DETAIL: 'Plan (días)',
        PRODUCT: 'Producto', PLAN: 'Plan (días)', TOTAL: 'Total ($)',
        LINK: 'Link de pago (Mercado Pago)', NOMBRE: 'Nombre del cliente',
        SALDO: 'Saldo ($)', SENA_AMOUNT: 'Seña ($)', SENA_REMAINDER: 'Saldo ($)',
        POSTDATADO_LINE: 'Fecha de entrega',
    };
    // Nombre legible de cada paso del guion (la clave interna es inglés técnico:
    // "WAITING ZONE" no le dice nada al vendedor). Una clave que no esté acá cae
    // al formato genérico de stepLabel.
    const HB_STEP_LABELS = {
        greeting: 'Saludo',
        recommendation_1: 'Recomendación (hasta 10 kg)', recommendation_2: 'Recomendación (más de 10 kg)',
        prices_60: 'Precios — 60 días', prices_120: 'Precios — 120 días', prices_both: 'Precios — los dos planes',
        prices_club: 'Lista de precios',
        preference_capsulas: 'Eligió cápsulas', preference_gotas: 'Eligió gotas', preference_semillas: 'Eligió semillas',
        payment_menu: 'Formas de pago',
        zone_km: 'Zona — a cuántos km está', zone_reask: 'Zona — volver a preguntar la localidad',
        zone_no_local: 'Zona — no dijo la localidad', zone_in: 'Zona — con reparto propio', zone_out: 'Zona — envío por Correo',
        payment_domicilio_choice: 'Pago — envío a domicilio', payment_sucursal_choice: 'Pago — retiro en sucursal',
        prepay_objection: 'No quiere pagar por adelantado', prepay_refusal_close: 'Cierre si no acepta el pago previo',
        payment_transfer_alias: 'Datos para transferir',
        payment_mp_link: 'Link de Mercado Pago', payment_mp_link_sucursal: 'Link de Mercado Pago (sucursal)',
        payment_mp_failed: 'El pago con tarjeta falló', payment_mp_retry: 'Reintentar el pago con tarjeta',
        transfer_received: 'Transferencia recibida',
        closing: 'Cierre', closing_sucursal: 'Cierre (sucursal)',
        order_confirmation_mp: 'Pedido confirmado — tarjeta', order_confirmation_transfer: 'Pedido confirmado — transferencia',
        order_confirmation_reparto: 'Pedido confirmado — reparto', order_confirmation_cod: 'Pedido confirmado — paga al recibir',
        order_confirmation_fallback: 'Pedido confirmado',
        promo_product_confirm: 'Promo — confirmar producto', promo_declined: 'Promo — no le interesa',
        promo_opted_out: 'Promo — no quiere más mensajes', promo_other_product: 'Promo — pide otro producto',
        promo_product_confirm_list: 'Promo — otro producto a precio de lista',
    };
    // Etapas del guion: 38 pasos en una lista plana no se podían recorrer.
    const HB_STAGES = [['saludo', 'Saludo'], ['precios', 'Precios'], ['producto', 'Producto'], ['zona', 'Zona y envío'], ['pago', 'Pago'], ['cierre', 'Cierre y confirmación'], ['promo', 'Promo'], ['otros', 'Otros']];
    function stageOfKey(k) {
        if (/^(greeting|recommendation)/.test(k)) return 'saludo';
        if (/^prices/.test(k)) return 'precios';
        if (/^preference/.test(k)) return 'producto';
        if (/^zone/.test(k)) return 'zona';
        if (/^(payment|prepay|transfer)/.test(k)) return 'pago';
        if (/^(closing|order_confirmation)/.test(k)) return 'cierre';
        if (/^promo/.test(k)) return 'promo';
        return 'otros';
    }
    // En qué etapa está el chat abierto, según el paso del flujo (state.step).
    function stageOfStep(step) {
        const st = String(step || '');
        if (!st) return null;
        if (/promo/.test(st)) return 'promo';
        if (/greeting|weight|^new$/.test(st)) return 'saludo';
        if (/preference|plan/.test(st)) return 'producto';
        if (/zone/.test(st)) return 'zona';
        if (/payment|transfer/.test(st)) return 'pago';
        if (/data|maps|confirmation|validation|waiting_ok|completed/.test(st)) return 'cierre';
        return null;
    }
    const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    function stepLabel(k) {
        return HB_STEP_LABELS[k] || k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    }

    // Mapa de placeholders del CLIENTE desde el state del chat (lo que el bot
    // capturó en la conversación). Los que queden vacíos los pide el modal.
    function buildClientMap(state) {
        const s = state || {};
        const cart = Array.isArray(s.cart) ? s.cart : [];
        const productDetail = cart.length ? cart.map((i) => i.product).filter(Boolean).join(' + ') : (s.selectedProduct || '');
        const planDetail = cart.length ? cart.map((i) => i.plan + ' días').join(' + ') : (s.selectedPlan ? s.selectedPlan + ' días' : '');
        const totalDigits = s.totalPrice != null ? String(s.totalPrice).replace(/\D/g, '') : '';
        const totalFmt = totalDigits ? parseInt(totalDigits, 10).toLocaleString('es-AR') : '';
        return {
            PRODUCT_DETAIL: productDetail,
            PLAN_DETAIL: planDetail,
            PRODUCT: s.selectedProduct || '',
            PLAN: s.selectedPlan ? String(s.selectedPlan) : '',
            TOTAL: totalFmt,
            LINK: s.mpPaymentLinkUrl || '',
            // Línea fija (no es input): se resuelve siempre, nunca va al modal.
            POSTDATADO_LINE: s.postdatado ? ('📅 Envío programado: ' + s.postdatado) : '✔ Entrega estimada: 7 a 10 días hábiles desde la confirmación',
        };
    }

    // Reemplaza {{K}} con map[K] SOLO si tiene valor (los vacíos quedan para el modal).
    function resolveMap(text, map) {
        let r = String(text == null ? '' : text);
        Object.keys(map).forEach((k) => {
            const v = map[k];
            if (v != null && v !== '') r = r.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), v);
        });
        return r;
    }

    function placeholderLabel(k) {
        return HB_LABELS[k] || k.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
    }

    // Texto del paso tal como se MUESTRA en el panel: lo que el vendedor todavía
    // tiene que completar sale como ‹Nombre del cliente›, no como {{NOMBRE}}.
    function previewText(text) {
        return resolveMap(text, HB_CONST).replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (_m, k) => '‹' + placeholderLabel(k).replace(/ \([^)]*\)$/, '') + '›');
    }

    // Monto en pesos enteros desde lo que tipea el vendedor, en formato argentino:
    // "49.900" → 49900, "49.900,50" → 49901, "$ 49900" → 49900, "49900.5" → 49901.
    // Un punto seguido de exactamente 3 dígitos es separador de miles; la coma,
    // decimal. Devuelve 0 si no se entiende.
    function parseAmount(raw) {
        let s = String(raw == null ? '' : raw).replace(/[^\d.,]/g, '');
        if (!s) return 0;
        if (s.indexOf(',') !== -1) {
            s = s.replace(/\./g, '').replace(/,/, '.').replace(/,/g, '');
        } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
            s = s.replace(/\./g, '');
        } else if (!/^\d+(\.\d{1,2})?$/.test(s)) {
            s = s.replace(/\./g, '');
        }
        const n = Math.round(parseFloat(s));
        return isFinite(n) && n > 0 ? n : 0;
    }
    const fmtPesos = (n) => Number(n).toLocaleString('es-AR');
    const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

    // Iconos propios (trazo, heredan el color del texto). Antes eran emojis: se
    // veían distintos en cada Windows y no escalaban parejo con la letra.
    const HB_ICONS = {
        pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
        play: '<path d="M7 5l12 7-12 7z"/>',
        note: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h7M9 8h3"/>',
        reset: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
        card: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>',
        send: '<path d="M21 3L10 14M21 3l-7 18-4-7-7-4z"/>',
        clip: '<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V3h6v2M9 11h6M9 15h6"/>',
        x: '<path d="M6 6l12 12M18 6L6 18"/>',
        panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
        text: '<path d="M3 18l4.5-12L12 18M4.5 14h6M14 18l3-8 3 8M15 15.5h4"/>',
    };
    const icon = (name) => '<svg class="hb-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + HB_ICONS[name] + '</svg>';

    // priceMap actual (se llena cuando carga el guion). Lo necesita el modal
    // para auto-completar TOTAL al elegir producto+plan.
    let currentPriceMap = {};
    // El mensaje de estado del panel; lo define build().
    let feed = () => {};

    // ── Diálogo propio ────────────────────────────────────────────────────────
    // Un solo armado para los tres usos (confirmar, monto, datos del pedido):
    // rol de diálogo, foco adentro y atrapado, Escape y clic afuera cierran, y
    // al cerrar el foco vuelve a donde estaba. Va colgado de <body> (tiene que
    // tapar también WhatsApp), por eso --hb-fs vive en :root y no en el panel.
    // onOk devuelve false para dejarlo abierto (validación).
    function openDialog(opts) {
        const prev = document.getElementById('hb-modal-ov');
        if (prev) prev.remove();
        const returnTo = document.activeElement;
        const ov = document.createElement('div');
        ov.id = 'hb-modal-ov';
        ov.innerHTML = '<div id="hb-modal" role="dialog" aria-modal="true" aria-labelledby="hb-m-t"' + (opts.sub ? ' aria-describedby="hb-m-sub"' : '') + '>' +
            '<div class="hb-m-t" id="hb-m-t">' + esc(opts.title) + '</div>' +
            (opts.sub ? '<div class="hb-m-sub" id="hb-m-sub">' + esc(opts.sub) + '</div>' : '') +
            (opts.bodyHtml || '') +
            '<div class="hb-m-err" id="hb-m-err" role="alert"></div>' +
            '<div class="hb-m-btns"><button type="button" id="hb-m-cancel">Cancelar</button>' +
            '<button type="button" id="hb-m-ok"' + (opts.danger ? ' class="danger"' : '') + '>' + esc(opts.okLabel || 'Aceptar') + '</button></div>' +
            '</div>';
        document.body.appendChild(ov);
        const box = ov.querySelector('#hb-modal');
        let done = false;
        const close = (accepted) => {
            if (done) return;
            done = true;
            document.removeEventListener('keydown', onKey, true);
            ov.remove();
            if (returnTo && typeof returnTo.focus === 'function' && document.contains(returnTo)) returnTo.focus();
            if (!accepted && opts.onCancel) opts.onCancel();
        };
        const setError = (msg) => { ov.querySelector('#hb-m-err').textContent = msg || ''; };
        const submit = () => { if (opts.onOk && opts.onOk(ov, setError) === false) return; close(true); };
        function onKey(e) {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); return; }
            if (e.key !== 'Tab') return;
            const f = Array.from(box.querySelectorAll('button,input,select,textarea')).filter((el) => !el.disabled && el.offsetParent !== null);
            if (!f.length) return;
            const first = f[0], last = f[f.length - 1];
            if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
            else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
        document.addEventListener('keydown', onKey, true);
        ov.querySelector('#hb-m-cancel').onclick = () => close(false);
        ov.querySelector('#hb-m-ok').onclick = submit;
        ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(false); });
        box.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
        });
        if (opts.onOpen) opts.onOpen(ov, setError);
        // Lo destructivo arranca con el foco en Cancelar; el resto, en el primer campo.
        const firstField = box.querySelector('input,select');
        (opts.danger || !firstField ? ov.querySelector(opts.danger ? '#hb-m-cancel' : '#hb-m-ok') : firstField).focus();
        return ov;
    }

    // ¿Seguro? → Promise<boolean>.
    function askConfirm(title, sub, okLabel, danger) {
        return new Promise((resolve) => {
            openDialog({ title, sub, okLabel, danger: !!danger, onOk: () => { resolve(true); }, onCancel: () => resolve(false) });
        });
    }

    // Monto a cobrar → Promise<number|null>. Muestra, mientras se tipea, cuánto
    // se va a cobrar de verdad: es la confirmación (antes eran prompt + confirm).
    function askAmount() {
        return new Promise((resolve) => {
            openDialog({
                title: 'Cobrar con Mercado Pago',
                sub: 'Se genera el link y se envía al chat abierto.',
                okLabel: 'Generar y enviar',
                bodyHtml: '<label class="hb-m-l" for="hb-m-amt">Monto en pesos</label>' +
                    '<input class="hb-m-i" id="hb-m-amt" inputmode="decimal" autocomplete="off" placeholder="ej. 49.900" />' +
                    '<div class="hb-m-hint" id="hb-m-amt-hint" aria-live="polite"></div>',
                onOpen: (ov, setError) => {
                    const inp = ov.querySelector('#hb-m-amt');
                    const hint = ov.querySelector('#hb-m-amt-hint');
                    inp.addEventListener('input', () => {
                        setError('');
                        const n = parseAmount(inp.value);
                        hint.textContent = n ? 'Se va a cobrar $' + fmtPesos(n) : '';
                    });
                },
                onOk: (ov, setError) => {
                    const n = parseAmount(ov.querySelector('#hb-m-amt').value);
                    if (!n) { setError('Escribí el monto en pesos, por ejemplo 49.900.'); ov.querySelector('#hb-m-amt').focus(); return false; }
                    resolve(n);
                    return true;
                },
                onCancel: () => resolve(null),
            });
        });
    }

    // Modal para completar a mano los placeholders que el bot no detectó.
    // PRODUCT/PRODUCT_DETAIL → dropdown fijo (Cápsulas/Gotas/Semillas).
    // PLAN/PLAN_DETAIL → dropdown 60 días / 120 días / Otro (con input libre).
    // TOTAL → input editable, pre-llenado desde currentPriceMap según producto+plan.
    function showFillModal(placeholders, prefill, onConfirm) {
        let rows = '';
        placeholders.forEach((k, i) => {
            const val = (prefill && prefill[k]) || '';
            const id = 'hb-m-f' + i;
            const lbl = '<label class="hb-m-l" for="' + id + '">' + esc(placeholderLabel(k)) + '</label>';
            if (k === 'PRODUCT_DETAIL' || k === 'PRODUCT') {
                const prods = ['Cápsulas', 'Gotas', 'Semillas'];
                const opts = prods.map((p) => '<option value="' + p + '"' + (val === p ? ' selected' : '') + '>' + p + '</option>').join('');
                rows += lbl + '<select class="hb-m-s" id="' + id + '" data-k="' + k + '" data-type="product">' + opts + '</select>';
            } else if (k === 'PLAN_DETAIL' || k === 'PLAN') {
                const raw = val ? val.replace(/ días$/, '') : '';
                const isOther = raw && raw !== '60' && raw !== '120';
                rows += lbl +
                    '<select class="hb-m-s" id="' + id + '" data-k="' + k + '" data-type="plan">' +
                    '<option value="60"' + (raw === '60' ? ' selected' : '') + '>60 días</option>' +
                    '<option value="120"' + (raw === '120' ? ' selected' : '') + '>120 días</option>' +
                    '<option value="otro"' + (isOther ? ' selected' : '') + '>Otro…</option>' +
                    '</select>' +
                    '<input class="hb-m-i hb-m-plan-other" aria-label="Cantidad de días" placeholder="Cantidad de días" value="' + (isOther ? esc(raw) : '') + '" style="display:' + (isOther ? 'block' : 'none') + ';margin-top:5px" />';
            } else if (k === 'TOTAL') {
                rows += lbl + '<input class="hb-m-i" id="' + id + '" data-k="' + k + '" data-type="total" inputmode="decimal" value="' + esc(val) + '" placeholder="ej. 49.900" />';
            } else {
                rows += lbl + '<input class="hb-m-i" id="' + id + '" data-k="' + k + '" value="' + esc(val) + '" />';
            }
        });

        openDialog({
            title: 'Completá los datos del pedido',
            sub: 'El bot no los detectó en la conversación.',
            okLabel: 'Insertar en el chat',
            bodyHtml: rows,
            onCancel: () => feed('', ''),
            onOpen: (ov) => {
                // Auto-llena TOTAL cuando cambia producto o plan (solo estándares).
                function updateTotal() {
                    const totalInput = ov.querySelector('[data-type="total"]');
                    if (!totalInput || !Object.keys(currentPriceMap).length) return;
                    const prodSel = ov.querySelector('[data-type="product"]');
                    const planSel = ov.querySelector('[data-type="plan"]');
                    if (!prodSel || !planSel || planSel.value === 'otro') return;
                    const keyMap = { 'Cápsulas': 'CAPSULAS', 'Gotas': 'GOTAS', 'Semillas': 'SEMILLAS' };
                    const prodKey = keyMap[prodSel.value];
                    if (!prodKey) return;
                    const price = currentPriceMap['PRICE_' + prodKey + '_' + planSel.value];
                    if (price) totalInput.value = price;
                }
                ov.querySelectorAll('[data-type="plan"]').forEach((sel) => {
                    sel.addEventListener('change', () => {
                        const other = sel.nextElementSibling;
                        if (other && other.classList.contains('hb-m-plan-other')) other.style.display = sel.value === 'otro' ? 'block' : 'none';
                        updateTotal();
                    });
                });
                ov.querySelectorAll('[data-type="product"]').forEach((sel) => sel.addEventListener('change', updateTotal));
                updateTotal();
            },
            onOk: (ov) => {
                const values = {};
                ov.querySelectorAll('.hb-m-i').forEach((inp) => {
                    if (inp.classList.contains('hb-m-plan-other')) return;
                    const k = inp.getAttribute('data-k');
                    if (k) values[k] = inp.value.trim();
                });
                ov.querySelectorAll('.hb-m-s[data-k]').forEach((sel) => {
                    const k = sel.getAttribute('data-k');
                    if (sel.value === 'otro') {
                        const other = sel.nextElementSibling;
                        const raw = (other && other.classList.contains('hb-m-plan-other')) ? other.value.trim() : '';
                        values[k] = (k === 'PLAN_DETAIL' && raw) ? raw + ' días' : raw;
                    } else {
                        values[k] = k === 'PLAN_DETAIL' ? sel.value + ' días' : sel.value;
                    }
                });
                onConfirm(values);
                return true;
            },
        });
    }

    function build() {
        if (!document.body) { setTimeout(build, 300); return; }
        if (document.getElementById('hb-panel')) return;

        const style = document.createElement('style');
        // --hb-fs = multiplicador de tamaño de letra (slider). Todos los font-size
        // del panel Y de sus diálogos se escalan con él para acomodar mala visión
        // del vendedor. Vive en :root porque los diálogos cuelgan de <body>: cuando
        // estaba en #hb-panel sus calc() eran inválidos y salían a 16px fijos.
        // Al agrandar la letra nada se achica ni se corta: la fila de acciones pasa
        // a varias filas y el cuerpo del panel scrollea (antes el guion llegaba a
        // medir 0px con la letra al máximo).
        style.textContent = `
      :root{--hb-fs:1}
      #hb-panel{position:fixed;top:0;right:0;height:100vh;background:#0b141a;color:#e9edef;
        font-family:system-ui,Segoe UI,sans-serif;z-index:99999;box-shadow:-2px 0 14px rgba(0,0,0,.5);
        display:flex;flex-direction:column;transition:transform .22s cubic-bezier(.16,1,.3,1);border-left:1px solid #222d34}
      #hb-panel *,#hb-modal *{box-sizing:border-box}
      #hb-panel button,#hb-modal button,#hb-tog{font-family:inherit}
      #hb-panel :focus-visible,#hb-modal :focus-visible,#hb-tog:focus-visible{outline:2px solid #00d26a;outline-offset:2px}
      .hb-ic{width:calc(16px * var(--hb-fs));height:calc(16px * var(--hb-fs));flex-shrink:0;display:block}
      #hb-grip{position:absolute;left:-3px;top:0;width:9px;height:100%;cursor:ew-resize;background:transparent;touch-action:none;z-index:1}
      #hb-grip:hover,#hb-grip:focus-visible,#hb-grip.drag{background:#00a88466}
      #hb-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#111b21;border-bottom:1px solid #222d34;flex-shrink:0}
      #hb-bar .hb-t{font-weight:600;font-size:calc(14px * var(--hb-fs))}.hb-sp{flex:1}
      #hb-bar .hb-az{display:flex;align-items:center;gap:6px;color:#aebac1;cursor:pointer}
      #hb-bar #hb-fs{width:72px;accent-color:#00a884;cursor:pointer;flex-shrink:0;margin:0}
      #hb-bar #hb-close{display:flex;align-items:center;justify-content:center;background:#202c33;color:#d1d7db;border:0;border-radius:8px;width:32px;height:32px;cursor:pointer;flex-shrink:0}
      #hb-bar #hb-close:hover{background:#2a3942}
      #hb-body{flex:1;min-height:0;padding:12px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;overflow-x:hidden}
      #hb-body>*{flex-shrink:0}
      #hb-open{background:#111b21;border:1px solid #222d34;border-radius:8px;padding:8px 11px;font-size:calc(12px * var(--hb-fs));color:#aebac1;overflow-wrap:anywhere}
      #hb-open b{color:#e9edef}
      .hb-acts{display:grid;grid-template-columns:repeat(auto-fit,minmax(calc(60px * var(--hb-fs)),1fr));gap:6px}
      .hb-act{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;min-width:0;min-height:48px;background:#202c33;color:#e9edef;border:1px solid #2a3942;border-radius:8px;padding:8px 2px;font-size:calc(11px * var(--hb-fs));font-weight:500;cursor:pointer;text-align:center;line-height:1.15}
      .hb-act:hover{background:#2a3942}.hb-act:disabled{opacity:.5;cursor:default}
      .hb-act.warn{border-color:#f1b44c;color:#f1b44c}
      .hb-act.mp{border-color:#009ee3;color:#4cc3f0}
      #hb-feed{font-size:calc(13px * var(--hb-fs));line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere;max-height:30vh;overflow-y:auto;background:#111b21;border:1px solid #222d34;border-radius:8px;padding:8px 11px;color:#c8d0d4}
      #hb-feed:empty{display:none}
      #hb-feed.ok{color:#00d26a;border-color:#0f5c46}#hb-feed.err{color:#ff8a98;border-color:#7a2f3a}
      .hb-sec{font-size:calc(12px * var(--hb-fs));font-weight:600;color:#aebac1;margin-top:8px}
      .hb-sec small{display:block;font-size:calc(11px * var(--hb-fs));font-weight:400;color:#8696a0;margin-top:2px}
      #hb-steps{display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-height:min(220px,45vh);overflow-y:auto}
      #hb-steps>*{flex-shrink:0}
      #hb-botstate{display:flex;align-items:center;gap:6px;margin-top:5px;font-size:calc(12px * var(--hb-fs));color:#00d26a}
      #hb-botstate:empty{display:none}
      #hb-botstate i{width:8px;height:8px;border-radius:50%;background:currentColor;flex-shrink:0}
      #hb-botstate.off{color:#f1b44c}
      #hb-q{background:#202c33;border:1px solid #3b4a54;border-radius:8px;color:#e9edef;padding:8px 10px;font-size:calc(13px * var(--hb-fs));font-family:inherit;width:100%}
      #hb-q::placeholder{color:#8696a0}
      .hb-step[hidden],.hb-grp[hidden],#hb-q-none[hidden]{display:none}
      .hb-grp{border:1px solid #222d34;border-radius:8px;background:#0f1a20}
      .hb-grp>summary{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;cursor:pointer;padding:9px 10px;font-size:calc(12px * var(--hb-fs));font-weight:600;color:#d1d7db;list-style:none;border-radius:8px}
      .hb-grp>summary::-webkit-details-marker{display:none}
      .hb-grp>summary::before{content:'';width:6px;height:6px;border-right:2px solid #8696a0;border-bottom:2px solid #8696a0;transform:rotate(-45deg);transition:transform .15s;flex-shrink:0;margin:0 2px}
      .hb-grp[open]>summary::before{transform:rotate(45deg)}
      .hb-grp .n{color:#8696a0;font-weight:400}
      .hb-grp .now{margin-left:auto;font-size:calc(11px * var(--hb-fs));font-weight:600;color:#06120e;background:#00d26a;border-radius:999px;padding:1px 8px;display:none}
      .hb-grp.cur{border-color:#00a884}.hb-grp.cur .now{display:inline}
      .hb-grp .hb-gl{display:flex;flex-direction:column;gap:6px;padding:0 8px 8px}
      .hb-msg{color:#8696a0;font-size:calc(12px * var(--hb-fs))}.hb-msg.err{color:#ff8a98}
      .hb-step{display:block;width:100%;text-align:left;color:inherit;background:#111b21;border:1px solid #222d34;border-radius:8px;padding:8px 10px;cursor:pointer}
      .hb-step:hover{border-color:#00a884;background:#16232b}
      .hb-step .k{display:block;font-size:calc(11px * var(--hb-fs));font-weight:600;color:#8fa3ad}
      .hb-step .p{font-size:calc(12px * var(--hb-fs));color:#c8d0d4;margin-top:3px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}
      #hb-modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100001;display:flex;align-items:center;justify-content:center;padding:16px}
      #hb-modal{background:#0b141a;color:#e9edef;font-family:system-ui,Segoe UI,sans-serif;border:1px solid #2a3942;border-radius:12px;padding:18px;width:min(100%,calc(320px * var(--hb-fs)));max-height:100%;overflow-y:auto;box-shadow:0 8px 30px rgba(0,0,0,.6);display:flex;flex-direction:column}
      #hb-modal .hb-m-t{font-size:calc(15px * var(--hb-fs));font-weight:600;color:#e9edef}
      #hb-modal .hb-m-sub{font-size:calc(12px * var(--hb-fs));color:#aebac1;margin:4px 0 2px;line-height:1.4}
      #hb-modal .hb-m-l{font-size:calc(12px * var(--hb-fs));color:#aebac1;margin-top:10px}
      #hb-modal .hb-m-i,#hb-modal .hb-m-s{background:#202c33;border:1px solid #3b4a54;border-radius:8px;color:#e9edef;padding:9px 11px;font-size:calc(14px * var(--hb-fs));font-family:inherit;width:100%;margin-top:4px}
      #hb-modal .hb-m-i:focus,#hb-modal .hb-m-s:focus{border-color:#00a884}
      #hb-modal .hb-m-i::placeholder{color:#8696a0}
      #hb-modal .hb-m-s{cursor:pointer;appearance:auto}
      #hb-modal .hb-m-hint{font-size:calc(13px * var(--hb-fs));color:#00d26a;font-weight:600;margin-top:8px;min-height:1.4em}
      #hb-modal .hb-m-err{font-size:calc(12px * var(--hb-fs));color:#ff8a98;margin-top:6px}
      #hb-modal .hb-m-err:empty{display:none}
      #hb-modal .hb-m-btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
      #hb-modal .hb-m-btns button{flex:1 1 calc(110px * var(--hb-fs));border:0;border-radius:8px;padding:10px;min-height:40px;font-size:calc(13px * var(--hb-fs));font-weight:600;cursor:pointer}
      #hb-modal #hb-m-cancel{background:#202c33;color:#d1d7db}
      #hb-modal #hb-m-ok{background:#00a884;color:#06120e}
      #hb-modal #hb-m-ok.danger{background:#f15c6d;color:#1a0508}
      .hb-ord{display:flex;align-items:flex-start;gap:8px;width:100%;text-align:left;border:1px solid;border-radius:8px;padding:10px;cursor:pointer;background:transparent;font-size:calc(13px * var(--hb-fs));line-height:1.3}
      .hb-ord small{display:block;font-size:calc(11px * var(--hb-fs));font-weight:400;opacity:.85;margin-top:2px}
      .hb-ord .hb-ic{margin-top:1px}
      .hb-ord.g{border-color:#00a884;color:#00d26a}.hb-ord.g:hover{background:#00a88418}
      .hb-ord.s{border-color:#3b4a54;color:#c8d0d4}.hb-ord.s:hover{background:#ffffff0d}
      .hb-ord:disabled{opacity:.5;cursor:default}
      #hb-tog{position:fixed;top:76px;right:0;z-index:100000;display:flex;align-items:center;justify-content:center;width:40px;height:40px;background:#00a884;color:#06120e;border:0;border-radius:8px 0 0 8px;cursor:pointer;transition:right .22s cubic-bezier(.16,1,.3,1)}
      #hb-tog .hb-ic{width:20px;height:20px}
      #hb-credit{flex-shrink:0;text-align:center;padding:6px 10px;border-top:1px solid #222d34;background:#111b21;color:#8696a0;font-size:11px}
      @media (prefers-reduced-motion: reduce){#hb-panel,#hb-tog,.hb-grp>summary::before{transition:none}}
    `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'hb-panel';
        panel.className = 'hb-col';
        panel.setAttribute('role', 'complementary');
        panel.setAttribute('aria-label', 'Panel Herbalis');
        panel.innerHTML = `
      <div id="hb-grip" role="separator" aria-orientation="vertical" aria-label="Ancho del panel (flechas izquierda y derecha)" tabindex="0" title="Arrastrar para cambiar el ancho"></div>
      <div id="hb-bar">
        <span class="hb-t">Herbalis</span>
        <span class="hb-sp"></span>
        <label class="hb-az" title="Tamaño de letra">${icon('text')}
          <input id="hb-fs" type="range" min="1" max="2.4" step="0.1" value="1" aria-label="Tamaño de letra" />
        </label>
        <button type="button" id="hb-close" aria-label="Cerrar panel" title="Cerrar panel">${icon('x')}</button>
      </div>
      <div id="hb-body">
        <div id="hb-open">Chat abierto: <b id="hb-openname">—</b><div id="hb-botstate" role="status"></div></div>
        <div class="hb-acts">
          <button type="button" class="hb-act warn" id="hb-botsw">${icon('pause')}Pausar bot</button>
          <button type="button" class="hb-act" data-act="summarize">${icon('note')}Resumen</button>
          <button type="button" class="hb-act" data-act="reset">${icon('reset')}Reiniciar</button>
          <button type="button" class="hb-act mp" id="hb-mp">${icon('card')}Cobro MP</button>
        </div>
        <div id="hb-feed" role="status" aria-live="polite"></div>
        <div class="hb-sec">Guion<small>Tocá un paso para ponerlo en el chat.</small></div>
        <input id="hb-q" type="search" autocomplete="off" placeholder="Buscar en el guion…" aria-label="Buscar en el guion" />
        <div id="hb-steps"><span class="hb-msg">Cargando guion…</span></div>
        <div class="hb-sec">Confirmar pedido</div>
        <button type="button" id="hb-ord-msg" class="hb-ord g">${icon('send')}<span>Pedido ingresado<small>Envía la confirmación al cliente.</small></span></button>
        <button type="button" id="hb-ord-sil" class="hb-ord s">${icon('clip')}<span>Solo registrar<small>No se le envía ningún mensaje.</small></span></button>
      </div>
      <div id="hb-credit">By Cristian Giosue</div>
    `;
        document.body.appendChild(panel);

        const tog = document.createElement('button');
        tog.type = 'button';
        tog.id = 'hb-tog'; tog.innerHTML = icon('panel'); tog.title = 'Panel Herbalis';
        document.body.appendChild(tog);

        // ── Tamaño / posición / push ──────────────────────────────────────────
        function isOpen() { return !panel.classList.contains('hb-col'); }
        function applyLayout() {
            panel.style.width = curW + 'px';
            panel.style.transform = isOpen() ? 'translateX(0)' : `translateX(${curW + 2}px)`;
            // Cerrado queda fuera de pantalla: que tampoco reciba foco ni lo lea un lector.
            panel.inert = !isOpen();
            tog.style.right = isOpen() ? curW + 'px' : '0';
            tog.setAttribute('aria-expanded', isOpen() ? 'true' : 'false');
            tog.setAttribute('aria-label', isOpen() ? 'Cerrar panel Herbalis' : 'Abrir panel Herbalis');
            const app = document.querySelector('#app');
            if (app) app.style.width = isOpen() ? `calc(100% - ${curW}px)` : '';
        }
        function setW(w) { curW = Math.max(300, Math.min(760, Math.round(w))); applyLayout(); }
        tog.onclick = () => { panel.classList.toggle('hb-col'); applyLayout(); };
        document.getElementById('hb-close').onclick = () => { panel.classList.add('hb-col'); applyLayout(); tog.focus(); };
        applyLayout();

        // ── Tamaño de letra (slider) ──────────────────────────────────────────
        // Escala TODO el texto del panel y de sus diálogos vía la CSS var --hb-fs.
        // Persistido en localStorage (si WA bloquea storage, igual funciona en la sesión).
        const fsInput = document.getElementById('hb-fs');
        function applyFs(v) {
            const f = Math.max(1, Math.min(2.4, parseFloat(v) || 1));
            document.documentElement.style.setProperty('--hb-fs', f);
            if (fsInput) fsInput.value = f;
            try { localStorage.setItem('hbFontScale', String(f)); } catch (e) { /* storage bloqueado */ }
        }
        let savedFs = 1;
        try { savedFs = localStorage.getItem('hbFontScale') || 1; } catch (e) { /* idem */ }
        applyFs(savedFs);
        fsInput.addEventListener('input', (e) => applyFs(e.target.value));

        // Inserta texto en el CUADRO NATIVO de WhatsApp (editor Lexical). El paste
        // sintético es la vía que Lexical reconoce y que preserva los saltos de
        // línea (execCommand insertText los colapsa). Devuelve true si pudo apuntar
        // al composer; el contenido real se verifica luego (Lexical renderiza async).
        function insertIntoComposer(text) {
            const box = document.querySelector('#main footer [contenteditable=true]');
            if (!box) return false;
            box.focus();
            try {
                document.execCommand('selectAll', false, null);
                box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
            } catch (e) { /* sigue: el paste suele bastar */ }
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            return true;
        }

        // Inserta el texto en el cuadro de WhatsApp con verificación + fallback.
        function doInsert(box, text) {
            insertIntoComposer(text);
            setTimeout(() => {
                if (box.innerText.trim()) {
                    feed('Listo — revisá el mensaje en el chat y enviá con Enter.', 'ok');
                } else {
                    try { navigator.clipboard.writeText(text); feed('No pude escribir directo; lo copié al portapapeles, pegalo con Ctrl+V.', 'err'); }
                    catch (e2) { feed('No pude escribir en el cuadro de WhatsApp. Copiá el paso a mano.', 'err'); }
                }
            }, 150);
        }

        // Flujo al tocar un paso: precios (ya resueltos) → constantes → state del
        // cliente → modal por lo que falte → insertar en el chat.
        async function handleStepClick(textWithPrices) {
            const box = document.querySelector('#main footer [contenteditable=true]');
            if (!box) { feed('Abrí un chat primero.', 'err'); return; }
            let text = resolveMap(textWithPrices, HB_CONST);
            // ¿Hay placeholders de cliente en este paso? Si no, insertar directo.
            if (/\{\{[A-Z_][A-Z0-9_]*\}\}/.test(text)) {
                feed('Buscando datos del pedido…', '');
                let clientMap = {};
                try {
                    if (typeof window.hbGetChatState === 'function') {
                        const cs = await window.hbGetChatState();
                        if (cs && cs.ok) clientMap = buildClientMap(cs.state);
                    }
                } catch (e) { /* sin state → todo va al modal */ }
                text = resolveMap(text, clientMap);
                const remaining = Array.from(new Set((text.match(/\{\{[A-Z_][A-Z0-9_]*\}\}/g) || []).map((s) => s.replace(/[{}]/g, ''))));
                if (remaining.length) {
                    feed('Faltan datos del pedido: completalos en el cuadro.', '');
                    showFillModal(remaining, clientMap, (values) => {
                        let final = text;
                        Object.keys(values).forEach((k) => { if (values[k]) final = final.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), values[k]); });
                        // Lo que el vendedor dejó en blanco → borrar el placeholder (no mandar literal).
                        final = final.replace(/\{\{[A-Z_][A-Z0-9_]*\}\}/g, '');
                        doInsert(box, final);
                    });
                    return;
                }
            }
            doInsert(box, text);
        }

        // Redimensionar: arrastrando el borde izquierdo (mouse, lápiz o dedo) o,
        // con el foco en el borde, con las flechas.
        const grip = document.getElementById('hb-grip');
        let dragging = false;
        const stopDrag = () => { if (!dragging) return; dragging = false; grip.classList.remove('drag'); document.body.style.userSelect = ''; };
        grip.addEventListener('pointerdown', (e) => {
            dragging = true; grip.classList.add('drag'); e.preventDefault(); document.body.style.userSelect = 'none';
            try { grip.setPointerCapture(e.pointerId); } catch (err) { /* sin captura igual sirve el listener de window */ }
        });
        window.addEventListener('pointermove', (e) => { if (dragging) setW(window.innerWidth - e.clientX); });
        window.addEventListener('pointerup', stopDrag);
        window.addEventListener('pointercancel', stopDrag);
        window.addEventListener('blur', stopDrag);
        grip.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); setW(curW + 20); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); setW(curW - 20); }
        });

        // ── Helpers ───────────────────────────────────────────────────────────
        // El estado va ARRIBA, pegado a las acciones: abajo de todo quedaba fuera
        // de vista apenas había scroll.
        feed = (msg, cls) => {
            const f = document.getElementById('hb-feed');
            if (!f) return;
            f.textContent = msg; f.className = cls || '';
            if (msg) { const b = document.getElementById('hb-body'); if (b) b.scrollTop = 0; }
        };
        async function run(btn, fn) {
            if (btn && btn.disabled) return;
            if (btn) btn.disabled = true; feed('Procesando…', '');
            try {
                const r = await fn();
                if (r && r.ok) feed((r.msg || 'Listo') + (typeof r.data === 'string' && r.data ? ':\n\n' + r.data : ''), 'ok');
                else feed('No se pudo: ' + ((r && r.error) || 'error desconocido'), 'err');
            } catch (e) { feed('No se pudo: ' + (e.message || e), 'err'); }
            finally {
                if (btn) {
                    btn.disabled = false;
                    // Deshabilitarlo le sacó el foco: se lo devuelve si nadie más lo tomó.
                    if (document.activeElement === document.body) btn.focus();
                }
            }
        }
        const connected = (fnName) => {
            if (typeof window[fnName] === 'function') return true;
            feed('El agente no está conectado. Cerrá y volvé a abrir el programa.', 'err');
            return false;
        };

        // ── Estado del chat abierto ───────────────────────────────────────────
        // Un solo botón para pausar/activar, que dice lo que va a hacer, y una
        // línea con el estado real (antes había dos botones y ninguna pista de
        // si el bot estaba pausado en ese chat). También marca en el guion la
        // etapa en la que está la charla.
        const botSw = document.getElementById('hb-botsw');
        let chatState = null;
        function paintChatState(openStage) {
            const st = document.getElementById('hb-botstate');
            const known = chatState && typeof chatState.paused === 'boolean';
            const paused = !!(chatState && chatState.paused);
            st.className = known && paused ? 'off' : '';
            st.innerHTML = known ? '<i></i>' : '';
            if (known) st.appendChild(document.createTextNode(paused ? 'Bot pausado en este chat' : 'Bot activo en este chat'));
            botSw.className = 'hb-act' + (paused ? '' : ' warn');
            botSw.innerHTML = paused ? icon('play') + 'Activar bot' : icon('pause') + 'Pausar bot';
            const cur = chatState ? stageOfStep(chatState.step) : null;
            document.querySelectorAll('.hb-grp').forEach((g) => {
                const is = g.getAttribute('data-stage') === cur;
                g.classList.toggle('cur', is);
                if (openStage && is && !document.getElementById('hb-q').value) g.open = true;
            });
        }
        async function refreshChatState(openStage) {
            let next = null;
            if (openChatName() && typeof window.hbGetChatState === 'function') {
                try { const r = await window.hbGetChatState(); if (r && r.ok) next = r.state || null; } catch (e) { /* sin estado: el botón queda en "Pausar bot" */ }
            }
            chatState = next;
            paintChatState(openStage);
        }
        botSw.onclick = async () => {
            if (!connected('hbAction')) return;
            const act = chatState && chatState.paused ? 'resume' : 'pause';
            await run(botSw, () => window.hbAction(act));
            // Refleja el cambio ya, y después lo confirma con el servidor.
            chatState = Object.assign({}, chatState, { paused: act === 'pause' });
            paintChatState(false);
            refreshChatState(false);
        };

        // ── Acciones (resumen/reiniciar — el MP se maneja aparte) ─────────────
        panel.querySelectorAll('.hb-act[data-act]').forEach((b) => {
            b.onclick = async () => {
                const act = b.getAttribute('data-act');
                if (!connected('hbAction')) return;
                if (act === 'reset' && !(await askConfirm('¿Reiniciar este chat?', 'El bot olvida lo conversado con este cliente y empieza de cero. No se puede deshacer.', 'Reiniciar chat', true))) return;
                await run(b, () => window.hbAction(act));
                if (act === 'reset') refreshChatState(true);
            };
        });
        const ordMsg = document.getElementById('hb-ord-msg');
        const ordSil = document.getElementById('hb-ord-sil');
        ordMsg.onclick = async () => {
            if (!connected('hbAction')) return;
            if (await askConfirm('¿Confirmar el pedido?', 'Se registra el pedido y se le envía la confirmación al cliente del chat abierto.', 'Confirmar y enviar')) run(ordMsg, () => window.hbAction('confirm'));
        };
        ordSil.onclick = async () => {
            if (!connected('hbAction')) return;
            if (await askConfirm('¿Registrar el pedido?', 'Se registra el pedido. Al cliente no se le envía ningún mensaje.', 'Registrar')) run(ordSil, () => window.hbAction('confirm_silent'));
        };

        // ── Link de Mercado Pago (botón compacto → pide el monto) ─────────────
        const mpBtn = document.getElementById('hb-mp');
        mpBtn.onclick = async () => {
            if (!connected('hbMpLink')) return;
            const amount = await askAmount();
            if (!amount) return;
            run(mpBtn, () => window.hbMpLink(String(amount)));
        };

        // ── Guion (pasos) ─────────────────────────────────────────────────────
        (async () => {
            const cont = document.getElementById('hb-steps');
            const say = (msg, isErr) => { cont.innerHTML = ''; const s = document.createElement('span'); s.className = 'hb-msg' + (isErr ? ' err' : ''); s.textContent = msg; cont.appendChild(s); };
            if (typeof window.hbGetScript !== 'function') { say('El agente no está conectado.', true); return; }
            // Precios reales para resolver los {{PRICE_*}}. Si falla, seguimos: los
            // placeholders quedan literales (mejor que romper la carga del guion).
            let priceMap = {};
            try {
                if (typeof window.hbGetPrices === 'function') {
                    const pr = await window.hbGetPrices();
                    if (pr && pr.ok) { priceMap = buildPriceMap(pr.prices); currentPriceMap = priceMap; }
                }
            } catch (e) { /* sin precios → placeholders literales */ }
            try {
                const r = await window.hbGetScript();
                if (!r || !r.ok) { say('No pude cargar el guion' + (r && r.error ? ': ' + r.error : '') + '. Cerrá y volvé a abrir el panel.', true); return; }
                const flow = r.flow || {};
                const keys = Object.keys(flow).filter((k) => flow[k] && flow[k].response);
                if (!keys.length) { say('El guion no tiene pasos cargados.', false); return; }
                cont.innerHTML = '';
                HB_STAGES.forEach(([id, title]) => {
                    const mine = keys.filter((k) => stageOfKey(k) === id);
                    if (!mine.length) return;
                    const grp = document.createElement('details');
                    grp.className = 'hb-grp';
                    grp.setAttribute('data-stage', id);
                    const sum = document.createElement('summary');
                    sum.appendChild(document.createTextNode(title));
                    const n = document.createElement('span'); n.className = 'n'; n.textContent = String(mine.length);
                    const cur = document.createElement('span'); cur.className = 'now'; cur.textContent = 'Etapa de este chat';
                    sum.appendChild(n); sum.appendChild(cur);
                    const list = document.createElement('div'); list.className = 'hb-gl';
                    mine.forEach((k) => {
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.className = 'hb-step';
                        const resp = resolvePrices(flow[k].response, priceMap);
                        const kEl = document.createElement('span'); kEl.className = 'k'; kEl.textContent = stepLabel(k);
                        const pEl = document.createElement('span'); pEl.className = 'p'; pEl.textContent = previewText(resp);
                        btn.appendChild(kEl); btn.appendChild(pEl);
                        btn.setAttribute('data-q', norm(stepLabel(k) + ' ' + pEl.textContent));
                        btn.onclick = () => handleStepClick(resp);
                        list.appendChild(btn);
                    });
                    grp.appendChild(sum); grp.appendChild(list);
                    cont.appendChild(grp);
                });
                const none = document.createElement('span'); none.className = 'hb-msg'; none.id = 'hb-q-none'; none.hidden = true;
                cont.appendChild(none);
                // Buscador: filtra los pasos y abre las etapas donde hay coincidencias.
                const q = document.getElementById('hb-q');
                const applySearch = () => {
                    const term = norm(q.value).trim();
                    let total = 0;
                    cont.querySelectorAll('.hb-grp').forEach((g) => {
                        let hits = 0;
                        g.querySelectorAll('.hb-step').forEach((b) => {
                            const ok = !term || b.getAttribute('data-q').indexOf(term) !== -1;
                            b.hidden = !ok; if (ok) hits++;
                        });
                        g.hidden = hits === 0;
                        g.open = term ? hits > 0 : g.classList.contains('cur');
                        total += hits;
                    });
                    none.hidden = total > 0;
                    none.textContent = total > 0 ? '' : 'Ningún paso dice "' + q.value.trim() + '". Probá con otra palabra.';
                };
                q.addEventListener('input', applySearch);
                refreshChatState(true);
            } catch (e) { say('No pude cargar el guion: ' + (e.message || e), true); }
        })();

        let lastChat = null;
        setInterval(() => {
            const el = document.getElementById('hb-openname');
            const name = openChatName();
            if (el) el.textContent = name || '— (ninguno abierto)';
            if (name !== lastChat) { lastChat = name; refreshChatState(true); }
        }, 1000);
    }

    build();
    setInterval(build, 3000);
}

// ── API para el agente ───────────────────────────────────────────────────────
async function injectSidebar(page) {
    if (!page) return;
    await page.evaluateOnNewDocument(bootstrap, PANEL_W);
    await page.evaluate(bootstrap, PANEL_W).catch(() => {});
}

module.exports = { injectSidebar };
