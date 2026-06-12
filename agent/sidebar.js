/**
 * sidebar.js — Panel lateral (botonera) inyectado en la ventana de WhatsApp del agente.
 *
 * A la DERECHA, empuja WhatsApp (no la tapa), REDIMENSIONABLE (arrastrar el borde izq).
 * Replica el "Asistente IA" del chat del dashboard:
 *   - Pausar/Reactivar bot, Resumen, Limpiar chat
 *   - Guión: pasos clickeables (insertan el mensaje del paso en la caja)
 *   - Confirmar pedido CON mensaje / Solo registrar (SIN mensaje)
 *   - Enviar al chat abierto / a un número
 * El panel llama a funciones que el agente expone (hbAction / hbGetScript / hbSend*).
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
    // Labels legibles para el modal de relleno.
    const HB_LABELS = {
        PRODUCT_DETAIL: 'Producto', PLAN_DETAIL: 'Plan (días)',
        PRODUCT: 'Producto', PLAN: 'Plan (días)', TOTAL: 'Total ($)',
        LINK: 'Link de pago (Mercado Pago)', NOMBRE: 'Nombre del cliente',
        SALDO: 'Saldo ($)', SENA_AMOUNT: 'Seña ($)', SENA_REMAINDER: 'Saldo ($)',
    };

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

    // priceMap actual (se llena cuando carga el guion). Lo necesita el modal
    // para auto-completar TOTAL al elegir producto+plan.
    let currentPriceMap = {};

    // Modal para completar a mano los placeholders que el bot no detectó.
    // PRODUCT/PRODUCT_DETAIL → dropdown fijo (Cápsulas/Gotas/Semillas).
    // PLAN/PLAN_DETAIL → dropdown 60 días / 120 días / Otro (con input libre).
    // TOTAL → input editable, pre-llenado desde currentPriceMap según producto+plan.
    function showFillModal(placeholders, prefill, onConfirm) {
        const ov = document.createElement('div');
        ov.id = 'hb-modal-ov';
        let rows = '';
        placeholders.forEach((k) => {
            const val = (prefill && prefill[k]) || '';
            const lbl = '<label class="hb-m-l">' + placeholderLabel(k) + '</label>';
            if (k === 'PRODUCT_DETAIL' || k === 'PRODUCT') {
                const prods = ['Cápsulas', 'Gotas', 'Semillas'];
                const opts = prods.map((p) => '<option value="' + p + '"' + (val === p ? ' selected' : '') + '>' + p + '</option>').join('');
                rows += lbl + '<select class="hb-m-s" data-k="' + k + '" data-type="product">' + opts + '</select>';
            } else if (k === 'PLAN_DETAIL' || k === 'PLAN') {
                const raw = val ? val.replace(/ días$/, '') : '';
                const isOther = raw && raw !== '60' && raw !== '120';
                rows += lbl +
                    '<select class="hb-m-s" data-k="' + k + '" data-type="plan">' +
                    '<option value="60"' + (raw === '60' ? ' selected' : '') + '>60 días</option>' +
                    '<option value="120"' + (raw === '120' ? ' selected' : '') + '>120 días</option>' +
                    '<option value="otro"' + (isOther ? ' selected' : '') + '>Otro…</option>' +
                    '</select>' +
                    '<input class="hb-m-i hb-m-plan-other" placeholder="Cantidad de días" value="' + (isOther ? String(raw).replace(/"/g, '&quot;') : '') + '" style="display:' + (isOther ? 'block' : 'none') + ';margin-top:5px" />';
            } else if (k === 'TOTAL') {
                rows += lbl + '<input class="hb-m-i" data-k="' + k + '" data-type="total" value="' + String(val).replace(/"/g, '&quot;') + '" placeholder="ej. 49.900" />';
            } else {
                rows += lbl + '<input class="hb-m-i" data-k="' + k + '" value="' + String(val).replace(/"/g, '&quot;') + '" />';
            }
        });
        ov.innerHTML = '<div id="hb-modal">' +
            '<div class="hb-m-t">Completá los datos del pedido</div>' +
            '<div class="hb-m-sub">El bot no los detectó en la conversación.</div>' +
            rows +
            '<div class="hb-m-btns"><button id="hb-m-cancel">Cancelar</button><button id="hb-m-ok">Insertar en el chat</button></div>' +
            '</div>';
        document.body.appendChild(ov);

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

        const close = () => ov.remove();
        const submit = () => {
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
            close();
            onConfirm(values);
        };
        ov.querySelector('#hb-m-cancel').onclick = close;
        ov.querySelector('#hb-m-ok').onclick = submit;
        ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
        ov.querySelectorAll('.hb-m-i').forEach((inp) => {
            if (!inp.classList.contains('hb-m-plan-other')) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        });
        const first = ov.querySelector('.hb-m-s,.hb-m-i'); if (first) first.focus();
    }

    function build() {
        if (!document.body) { setTimeout(build, 300); return; }
        if (document.getElementById('hb-panel')) return;

        const style = document.createElement('style');
        // --hb-fs = multiplicador de tamaño de letra (slider). Todos los font-size
        // del panel se escalan con él para acomodar mala visión del vendedor.
        style.textContent = `
      #hb-panel{--hb-fs:1;position:fixed;top:0;right:0;height:100vh;background:#0b141a;color:#e9edef;
        font-family:system-ui,Segoe UI,sans-serif;z-index:99999;box-shadow:-2px 0 14px rgba(0,0,0,.5);
        display:flex;flex-direction:column;transition:transform .22s ease;border-left:1px solid #222d34}
      #hb-grip{position:absolute;left:0;top:0;width:6px;height:100%;cursor:ew-resize;background:transparent}
      #hb-grip:hover{background:#00a88455}
      #hb-bar{display:flex;align-items:center;gap:6px;padding:10px 12px;background:#111b21;border-bottom:1px solid #222d34;cursor:default}
      #hb-bar .hb-t{font-weight:600;font-size:calc(13px * var(--hb-fs))}.hb-sp{flex:1}
      #hb-bar .hb-az{font-size:13px;opacity:.75}
      #hb-bar #hb-fs{width:66px;accent-color:#00a884;cursor:pointer;flex-shrink:0}
      #hb-bar button{background:#202c33;color:#aebac1;border:0;border-radius:6px;width:26px;height:26px;cursor:pointer;flex-shrink:0}
      #hb-body{flex:1;min-height:0;padding:12px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}
      #hb-open{background:#111b21;border:1px solid #222d34;border-radius:8px;padding:8px 11px;font-size:calc(12px * var(--hb-fs));color:#aebac1}
      #hb-open b{color:#e9edef}
      .hb-acts{display:grid;grid-template-columns:repeat(5,1fr);gap:5px}
      .hb-act{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;background:#202c33;color:#e9edef;border:1px solid #2a3942;border-radius:7px;padding:7px 2px;font-size:calc(10px * var(--hb-fs));font-weight:500;cursor:pointer;text-align:center;line-height:1.15}
      .hb-act .ic{font-size:calc(15px * var(--hb-fs));line-height:1}
      .hb-act:hover{background:#2a3942}.hb-act:disabled{opacity:.5;cursor:default}
      .hb-act.warn{border-color:#f1b44c;color:#f1b44c}
      .hb-act.mp{border-color:#009ee3;color:#4cc3f0}
      .hb-sec{font-size:calc(11px * var(--hb-fs));text-transform:uppercase;letter-spacing:.5px;color:#8696a0;margin-top:8px}
      #hb-steps{display:flex;flex-direction:column;gap:6px;max-height:46vh;overflow-y:auto}
      .hb-step{background:#111b21;border:1px solid #222d34;border-radius:8px;padding:8px 10px;cursor:pointer}
      .hb-step:hover{border-color:#00a884;background:#16232b}
      .hb-step .k{font-size:calc(11px * var(--hb-fs));color:#8696a0;text-transform:uppercase}
      .hb-step .p{font-size:calc(12px * var(--hb-fs));color:#c8d0d4;margin-top:3px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}
      #hb-modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100001;display:flex;align-items:center;justify-content:center}
      #hb-modal{background:#0b141a;border:1px solid #2a3942;border-radius:12px;padding:18px;width:300px;max-width:90vw;box-shadow:0 8px 30px rgba(0,0,0,.6);display:flex;flex-direction:column}
      #hb-modal .hb-m-t{font-size:calc(14px * var(--hb-fs));font-weight:600;color:#e9edef}
      #hb-modal .hb-m-sub{font-size:calc(11px * var(--hb-fs));color:#8696a0;margin:4px 0 6px}
      #hb-modal .hb-m-l{font-size:calc(11px * var(--hb-fs));color:#8696a0;margin-top:8px}
      #hb-modal .hb-m-i,#hb-modal .hb-m-s{background:#202c33;border:1px solid #2a3942;border-radius:7px;color:#e9edef;padding:9px 11px;font-size:calc(13px * var(--hb-fs));outline:none;width:100%;box-sizing:border-box;margin-top:3px}
      #hb-modal .hb-m-i:focus,#hb-modal .hb-m-s:focus{border-color:#00a884}
      #hb-modal .hb-m-s{cursor:pointer;appearance:auto}
      #hb-modal .hb-m-btns{display:flex;gap:8px;margin-top:16px}
      #hb-modal .hb-m-btns button{flex:1;border:0;border-radius:8px;padding:10px;font-size:calc(13px * var(--hb-fs));font-weight:600;cursor:pointer}
      #hb-modal #hb-m-cancel{background:#202c33;color:#aebac1}
      #hb-modal #hb-m-ok{background:#00a884;color:#fff}
      .hb-ord{width:100%;text-align:left;border:1px dashed;border-radius:8px;padding:10px;cursor:pointer;background:transparent;font-size:calc(13px * var(--hb-fs))}
      .hb-ord.g{border-color:#00a884;color:#00d26a}.hb-ord.s{border-color:#3a4a54;color:#aebac1}.hb-ord:disabled{opacity:.5}
      #hb-feed{margin-top:8px;font-size:calc(13px * var(--hb-fs));white-space:pre-wrap;max-height:24vh;overflow-y:auto}
      #hb-feed.ok{color:#00d26a}#hb-feed.err{color:#f15c6d}
      #hb-tog{position:fixed;top:76px;right:0;z-index:100000;background:#00a884;color:#fff;border:0;border-radius:8px 0 0 8px;padding:8px 9px;cursor:pointer;font-size:16px;transition:right .22s ease;line-height:1}
      #hb-credit{flex-shrink:0;text-align:center;padding:7px 10px;border-top:1px solid #222d34;background:#111b21;color:#8696a0;font-size:calc(11px * var(--hb-fs));letter-spacing:.3px}
    `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'hb-panel';
        panel.className = 'hb-col';
        panel.innerHTML = `
      <div id="hb-grip" title="Arrastrar para redimensionar"></div>
      <div id="hb-bar">
        <span class="hb-t">🤖 Herbalis</span>
        <span class="hb-sp"></span>
        <span class="hb-az" title="Tamaño de letra">🔤</span>
        <input id="hb-fs" type="range" min="1" max="2.4" step="0.1" value="1" title="Tamaño de letra" />
        <button id="hb-close" title="Cerrar">✕</button>
      </div>
      <div id="hb-body">
        <div id="hb-open">Chat abierto: <b id="hb-openname">—</b></div>
        <div class="hb-acts">
          <button class="hb-act warn" data-act="pause"><span class="ic">⏸</span>Pausar</button>
          <button class="hb-act" data-act="resume"><span class="ic">▶</span>Activar</button>
          <button class="hb-act" data-act="summarize"><span class="ic">📝</span>Resumen</button>
          <button class="hb-act" data-act="reset"><span class="ic">🧹</span>Limpiar</button>
          <button class="hb-act mp" id="hb-mp"><span class="ic">💳</span>Cobro MP</button>
        </div>
        <div class="hb-sec">Guión (V7) — tocá un paso para ponerlo en el chat</div>
        <div id="hb-steps"><span style="color:#8696a0;font-size:calc(12px * var(--hb-fs))">Cargando guion…</span></div>
        <div class="hb-sec">Confirmar pedido</div>
        <button id="hb-ord-msg" class="hb-ord g">🚀 Pedido ingresado — envía confirmación al cliente</button>
        <button id="hb-ord-sil" class="hb-ord s">📋 Solo registrar — sin enviar mensaje</button>
        <div id="hb-feed"></div>
      </div>
      <div id="hb-credit">By Cristian Giosue</div>
    `;
        document.body.appendChild(panel);

        const tog = document.createElement('button');
        tog.id = 'hb-tog'; tog.textContent = '🤖'; tog.title = 'Panel Herbalis';
        document.body.appendChild(tog);

        // ── Tamaño / posición / push ──────────────────────────────────────────
        function isOpen() { return !panel.classList.contains('hb-col'); }
        function applyLayout() {
            panel.style.width = curW + 'px';
            panel.style.transform = isOpen() ? 'translateX(0)' : `translateX(${curW + 2}px)`;
            tog.style.right = isOpen() ? curW + 'px' : '0';
            const app = document.querySelector('#app');
            if (app) app.style.width = isOpen() ? `calc(100% - ${curW}px)` : '';
        }
        function setW(w) { curW = Math.max(300, Math.min(760, Math.round(w))); applyLayout(); }
        tog.onclick = () => { panel.classList.toggle('hb-col'); applyLayout(); };
        document.getElementById('hb-close').onclick = () => { panel.classList.add('hb-col'); applyLayout(); };
        applyLayout();

        // ── Tamaño de letra (slider) ──────────────────────────────────────────
        // Escala TODO el texto del panel vía la CSS var --hb-fs. Persistido en
        // localStorage (si WA bloquea storage, igual funciona en la sesión).
        const fsInput = document.getElementById('hb-fs');
        function applyFs(v) {
            const f = Math.max(1, Math.min(2.4, parseFloat(v) || 1));
            panel.style.setProperty('--hb-fs', f);
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

        // Redimensionar arrastrando el borde izquierdo.
        let dragging = false;
        document.getElementById('hb-grip').addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); document.body.style.userSelect = 'none'; });
        window.addEventListener('mousemove', (e) => { if (dragging) setW(window.innerWidth - e.clientX); });
        window.addEventListener('mouseup', () => { if (dragging) { dragging = false; document.body.style.userSelect = ''; } });

        // ── Helpers ───────────────────────────────────────────────────────────
        const feed = (msg, cls) => { const f = document.getElementById('hb-feed'); f.textContent = msg; f.className = cls || ''; };
        async function run(btn, fn) {
            if (btn && btn.disabled) return;
            if (btn) btn.disabled = true; feed('Procesando…', '');
            try {
                const r = await fn();
                if (r && r.ok) feed(r.data ? ((r.msg ? r.msg + ':\n\n' : '') + (typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2))) : ('✅ ' + (r.msg || 'Listo')), 'ok');
                else feed('✗ ' + ((r && r.error) || 'error'), 'err');
            } catch (e) { feed('✗ ' + (e.message || e), 'err'); }
            finally { if (btn) btn.disabled = false; }
        }

        // ── Acciones (pausar/activar/resumen/limpiar — el MP se maneja aparte) ─
        panel.querySelectorAll('.hb-act[data-act]').forEach((b) => {
            b.onclick = () => {
                const act = b.getAttribute('data-act');
                if (typeof window.hbAction !== 'function') { feed('Agente no conectado.', 'err'); return; }
                if (act === 'reset' && !window.confirm('¿Reiniciar el historial de este chat?')) return;
                run(b, () => window.hbAction(act));
            };
        });
        document.getElementById('hb-ord-msg').onclick = (e) => { if (window.confirm('¿Confirmar el pedido y ENVIAR la confirmación al cliente?')) run(e.target, () => window.hbAction('confirm')); };
        document.getElementById('hb-ord-sil').onclick = (e) => { if (window.confirm('¿Registrar el pedido SIN enviar mensaje?')) run(e.target, () => window.hbAction('confirm_silent')); };

        // ── Link de Mercado Pago (botón compacto → pide el monto) ─────────────
        const mpBtn = document.getElementById('hb-mp');
        mpBtn.onclick = () => {
            if (typeof window.hbMpLink !== 'function') { feed('Agente no conectado.', 'err'); return; }
            const raw = (window.prompt('Monto a cobrar con Mercado Pago (en pesos):', '') || '').replace(/\D/g, '');
            if (!raw) return;
            const fmt = parseInt(raw, 10).toLocaleString('es-AR');
            if (!window.confirm(`¿Generar link de Mercado Pago por $${fmt} y enviarlo al chat abierto?`)) return;
            run(mpBtn, () => window.hbMpLink(raw));
        };

        // ── Guión (pasos) ─────────────────────────────────────────────────────
        (async () => {
            const cont = document.getElementById('hb-steps');
            if (typeof window.hbGetScript !== 'function') { cont.innerHTML = '<span style="color:#8696a0;font-size:calc(12px * var(--hb-fs))">Agente no conectado.</span>'; return; }
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
                if (!r || !r.ok) { cont.innerHTML = '<span style="color:#f15c6d;font-size:calc(12px * var(--hb-fs))">No pude cargar el guion' + (r && r.error ? ': ' + r.error : '') + '</span>'; return; }
                const flow = r.flow || {};
                const keys = Object.keys(flow).filter((k) => flow[k] && flow[k].response);
                if (!keys.length) { cont.innerHTML = '<span style="color:#8696a0;font-size:calc(12px * var(--hb-fs))">Sin pasos.</span>'; return; }
                cont.innerHTML = '';
                keys.forEach((k) => {
                    const div = document.createElement('div');
                    div.className = 'hb-step';
                    const resp = resolvePrices(flow[k].response, priceMap);
                    div.innerHTML = `<div class="k">${k.replace(/_/g, ' ')}</div><div class="p"></div>`;
                    div.querySelector('.p').textContent = resp;
                    div.onclick = () => handleStepClick(resp);
                    cont.appendChild(div);
                });
            } catch (e) { cont.innerHTML = '<span style="color:#f15c6d;font-size:calc(12px * var(--hb-fs))">Error: ' + (e.message || e) + '</span>'; }
        })();

        setInterval(() => { const el = document.getElementById('hb-openname'); if (el) el.textContent = openChatName() || '— (ninguno abierto)'; }, 1000);
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
