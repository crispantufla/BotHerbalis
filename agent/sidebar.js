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
        let r = String(text == null ? '' : text);
        Object.keys(map).forEach((k) => {
            const v = map[k];
            if (v != null && v !== '') r = r.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), v);
        });
        return r;
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
      #hb-bar{display:flex;align-items:center;padding:12px 14px;background:#111b21;border-bottom:1px solid #222d34;cursor:default}
      #hb-bar .hb-t{font-weight:600;font-size:calc(14px * var(--hb-fs))}.hb-sp{flex:1}
      #hb-bar button{background:#202c33;color:#aebac1;border:0;border-radius:6px;width:28px;height:28px;cursor:pointer}
      #hb-body{padding:14px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}
      #hb-fsrow{display:flex;align-items:center;gap:8px;background:#111b21;border:1px solid #222d34;border-radius:8px;padding:8px 10px}
      #hb-fsrow label{font-size:calc(11px * var(--hb-fs));color:#8696a0;white-space:nowrap}
      #hb-fsrow input[type=range]{flex:1;accent-color:#00a884;cursor:pointer}
      #hb-fsval{font-size:calc(11px * var(--hb-fs));color:#00a884;font-weight:600;min-width:38px;text-align:right}
      #hb-open{background:#111b21;border:1px solid #222d34;border-radius:8px;padding:10px 12px;font-size:calc(13px * var(--hb-fs));color:#aebac1}
      #hb-open b{color:#e9edef}
      .hb-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .hb-act{background:#202c33;color:#e9edef;border:1px solid #2a3942;border-radius:8px;padding:10px;font-size:calc(13px * var(--hb-fs));font-weight:500;cursor:pointer;text-align:center}
      .hb-act:hover{background:#2a3942}.hb-act:disabled{opacity:.5;cursor:default}
      .hb-act.warn{border-color:#f1b44c;color:#f1b44c}
      .hb-sec{font-size:calc(11px * var(--hb-fs));text-transform:uppercase;letter-spacing:.5px;color:#8696a0;margin-top:10px}
      .hb-sep{border-top:1px solid #222d34;margin:10px 0 2px}
      #hb-steps{display:flex;flex-direction:column;gap:6px;max-height:26vh;overflow-y:auto}
      .hb-step{background:#111b21;border:1px solid #222d34;border-radius:8px;padding:8px 10px;cursor:pointer}
      .hb-step:hover{border-color:#00a884}
      .hb-step .k{font-size:calc(11px * var(--hb-fs));color:#8696a0;text-transform:uppercase}
      .hb-step .p{font-size:calc(12px * var(--hb-fs));color:#c8d0d4;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      #hb-body textarea{background:#202c33;border:1px solid #2a3942;border-radius:8px;color:#e9edef;padding:9px 11px;font-size:calc(14px * var(--hb-fs));font-family:inherit;resize:vertical;min-height:60px;outline:none;width:100%;box-sizing:border-box}
      #hb-body textarea:focus{border-color:#00a884}
      .hb-send{background:#00a884;color:#fff;border:0;border-radius:8px;padding:11px;font-size:calc(14px * var(--hb-fs));font-weight:600;cursor:pointer;width:100%}.hb-send:disabled{opacity:.5}
      .hb-ord{width:100%;text-align:left;border:1px dashed;border-radius:8px;padding:10px;cursor:pointer;background:transparent;font-size:calc(13px * var(--hb-fs))}
      .hb-ord.g{border-color:#00a884;color:#00d26a}.hb-ord.s{border-color:#3a4a54;color:#aebac1}
      #hb-feed{margin-top:8px;font-size:calc(13px * var(--hb-fs));white-space:pre-wrap;max-height:28vh;overflow-y:auto}
      #hb-feed.ok{color:#00d26a}#hb-feed.err{color:#f15c6d}
      #hb-body details summary{color:#8696a0;font-size:calc(12px * var(--hb-fs));cursor:pointer}
      #hb-body input{background:#202c33;border:1px solid #2a3942;border-radius:8px;color:#e9edef;padding:9px 11px;font-size:calc(14px * var(--hb-fs));outline:none;width:100%;box-sizing:border-box;margin-top:4px}
      #hb-tog{position:fixed;top:76px;right:0;z-index:100000;background:#00a884;color:#fff;border:0;border-radius:8px 0 0 8px;padding:8px 9px;cursor:pointer;font-size:16px;transition:right .22s ease;line-height:1}
    `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'hb-panel';
        panel.className = 'hb-col';
        panel.innerHTML = `
      <div id="hb-grip" title="Arrastrar para redimensionar"></div>
      <div id="hb-bar"><span class="hb-t">🤖 Herbalis · Panel</span><span class="hb-sp"></span><button id="hb-close" title="Cerrar">✕</button></div>
      <div id="hb-body">
        <div id="hb-fsrow">
          <label>🔤 Texto</label>
          <input id="hb-fs" type="range" min="1" max="2.4" step="0.1" value="1" />
          <span id="hb-fsval">100%</span>
        </div>
        <div id="hb-open">Chat abierto: <b id="hb-openname">—</b></div>
        <div class="hb-grid">
          <button class="hb-act warn" data-act="pause">⏸ Pausar</button>
          <button class="hb-act" data-act="resume">▶ Reactivar</button>
          <button class="hb-act" data-act="summarize">📝 Resumen</button>
          <button class="hb-act" data-act="reset">🧹 Limpiar</button>
        </div>
        <div class="hb-sec">Guión (V7) — click para insertar</div>
        <div id="hb-steps"><span style="color:#8696a0;font-size:calc(12px * var(--hb-fs))">Cargando guion…</span></div>
        <div class="hb-sep"></div>
        <label style="font-size:calc(12px * var(--hb-fs));color:#8696a0">Mensaje al chat abierto</label>
        <textarea id="hb-msg" placeholder="Escribí o insertá un paso del guion…"></textarea>
        <button id="hb-send-open" class="hb-send">Enviar al chat abierto</button>
        <div class="hb-sec">💳 Cobrar con Mercado Pago</div>
        <input id="hb-mp-amount" placeholder="Monto, ej: 46900" inputmode="numeric" />
        <button id="hb-mp-link" class="hb-send" style="margin-top:8px;background:#009ee3">Generar y enviar link MP</button>
        <div class="hb-sec">Confirmar pedido</div>
        <button id="hb-ord-msg" class="hb-ord g">🚀 Pedido ingresado — envía confirmación al cliente</button>
        <button id="hb-ord-sil" class="hb-ord s">📋 Solo registrar — sin enviar mensaje</button>
        <details><summary>o enviar a un número</summary>
          <input id="hb-num" placeholder="34679278596" inputmode="numeric" />
          <button id="hb-send-num" class="hb-send" style="margin-top:8px">Enviar al número</button>
        </details>
        <div id="hb-feed"></div>
      </div>
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
        const fsVal = document.getElementById('hb-fsval');
        function applyFs(v) {
            const f = Math.max(1, Math.min(2.4, parseFloat(v) || 1));
            panel.style.setProperty('--hb-fs', f);
            fsInput.value = f;
            fsVal.textContent = Math.round(f * 100) + '%';
            try { localStorage.setItem('hbFontScale', String(f)); } catch (e) { /* storage bloqueado */ }
        }
        let savedFs = 1;
        try { savedFs = localStorage.getItem('hbFontScale') || 1; } catch (e) { /* idem */ }
        applyFs(savedFs);
        fsInput.addEventListener('input', (e) => applyFs(e.target.value));

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

        // ── Acciones ──────────────────────────────────────────────────────────
        panel.querySelectorAll('.hb-act').forEach((b) => {
            b.onclick = () => {
                const act = b.getAttribute('data-act');
                if (typeof window.hbAction !== 'function') { feed('Agente no conectado.', 'err'); return; }
                if (act === 'reset' && !window.confirm('¿Reiniciar el historial de este chat?')) return;
                run(b, () => window.hbAction(act));
            };
        });
        document.getElementById('hb-ord-msg').onclick = (e) => { if (window.confirm('¿Confirmar el pedido y ENVIAR la confirmación al cliente?')) run(e.target, () => window.hbAction('confirm')); };
        document.getElementById('hb-ord-sil').onclick = (e) => { if (window.confirm('¿Registrar el pedido SIN enviar mensaje?')) run(e.target, () => window.hbAction('confirm_silent')); };

        // ── Envío ─────────────────────────────────────────────────────────────
        document.getElementById('hb-send-open').onclick = (e) => {
            const msg = document.getElementById('hb-msg').value || '';
            if (!msg.trim()) { feed('Falta el mensaje.', 'err'); return; }
            if (typeof window.hbSendToOpenChat !== 'function') { feed('Agente no conectado.', 'err'); return; }
            run(e.target, async () => { const r = await window.hbSendToOpenChat(msg); if (r && r.ok) document.getElementById('hb-msg').value = ''; return r; });
        };
        document.getElementById('hb-send-num').onclick = (e) => {
            const num = (document.getElementById('hb-num').value || '').replace(/\D/g, '');
            const msg = document.getElementById('hb-msg').value || '';
            if (!num || !msg.trim()) { feed('Falta número o mensaje.', 'err'); return; }
            if (typeof window.hbSendMessage !== 'function') { feed('Agente no conectado.', 'err'); return; }
            run(e.target, () => window.hbSendMessage(num, msg));
        };

        // ── Link de Mercado Pago ──────────────────────────────────────────────
        document.getElementById('hb-mp-link').onclick = (e) => {
            const raw = (document.getElementById('hb-mp-amount').value || '').replace(/\D/g, '');
            if (!raw) { feed('Falta el monto.', 'err'); return; }
            if (typeof window.hbMpLink !== 'function') { feed('Agente no conectado.', 'err'); return; }
            const fmt = parseInt(raw, 10).toLocaleString('es-AR');
            if (!window.confirm(`¿Generar link de Mercado Pago por $${fmt} y enviarlo al chat abierto?`)) return;
            run(e.target, async () => { const r = await window.hbMpLink(raw); if (r && r.ok) document.getElementById('hb-mp-amount').value = ''; return r; });
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
                    if (pr && pr.ok) priceMap = buildPriceMap(pr.prices);
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
                    div.onclick = () => { document.getElementById('hb-msg').value = resp; document.getElementById('hb-msg').focus(); feed('Paso insertado — revisá y "Enviar al chat abierto". (Precios ya cargados; los {{…}} del cliente se completan a mano.)', ''); };
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
