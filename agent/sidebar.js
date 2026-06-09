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

    function build() {
        if (!document.body) { setTimeout(build, 300); return; }
        if (document.getElementById('hb-panel')) return;

        const style = document.createElement('style');
        style.textContent = `
      #hb-panel{position:fixed;top:0;right:0;height:100vh;background:#0b141a;color:#e9edef;
        font-family:system-ui,Segoe UI,sans-serif;z-index:99999;box-shadow:-2px 0 14px rgba(0,0,0,.5);
        display:flex;flex-direction:column;transition:transform .22s ease;border-left:1px solid #222d34}
      #hb-grip{position:absolute;left:0;top:0;width:6px;height:100%;cursor:ew-resize;background:transparent}
      #hb-grip:hover{background:#00a88455}
      #hb-bar{display:flex;align-items:center;padding:12px 14px;background:#111b21;border-bottom:1px solid #222d34;cursor:default}
      #hb-bar .hb-t{font-weight:600;font-size:14px}.hb-sp{flex:1}
      #hb-bar button{background:#202c33;color:#aebac1;border:0;border-radius:6px;width:28px;height:28px;cursor:pointer}
      #hb-body{padding:14px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}
      #hb-open{background:#111b21;border:1px solid #222d34;border-radius:8px;padding:10px 12px;font-size:13px;color:#aebac1}
      #hb-open b{color:#e9edef}
      .hb-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      .hb-act{background:#202c33;color:#e9edef;border:1px solid #2a3942;border-radius:8px;padding:10px;font-size:13px;font-weight:500;cursor:pointer;text-align:center}
      .hb-act:hover{background:#2a3942}.hb-act:disabled{opacity:.5;cursor:default}
      .hb-act.warn{border-color:#f1b44c;color:#f1b44c}
      .hb-sec{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#8696a0;margin-top:10px}
      .hb-sep{border-top:1px solid #222d34;margin:10px 0 2px}
      #hb-steps{display:flex;flex-direction:column;gap:6px;max-height:26vh;overflow-y:auto}
      .hb-step{background:#111b21;border:1px solid #222d34;border-radius:8px;padding:8px 10px;cursor:pointer}
      .hb-step:hover{border-color:#00a884}
      .hb-step .k{font-size:11px;color:#8696a0;text-transform:uppercase}
      .hb-step .p{font-size:12px;color:#c8d0d4;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      #hb-body textarea{background:#202c33;border:1px solid #2a3942;border-radius:8px;color:#e9edef;padding:9px 11px;font-size:14px;font-family:inherit;resize:vertical;min-height:60px;outline:none;width:100%;box-sizing:border-box}
      #hb-body textarea:focus{border-color:#00a884}
      .hb-send{background:#00a884;color:#fff;border:0;border-radius:8px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;width:100%}.hb-send:disabled{opacity:.5}
      .hb-ord{width:100%;text-align:left;border:1px dashed;border-radius:8px;padding:10px;cursor:pointer;background:transparent;font-size:13px}
      .hb-ord.g{border-color:#00a884;color:#00d26a}.hb-ord.s{border-color:#3a4a54;color:#aebac1}
      #hb-feed{margin-top:8px;font-size:13px;white-space:pre-wrap;max-height:28vh;overflow-y:auto}
      #hb-feed.ok{color:#00d26a}#hb-feed.err{color:#f15c6d}
      #hb-body details summary{color:#8696a0;font-size:12px;cursor:pointer}
      #hb-body input{background:#202c33;border:1px solid #2a3942;border-radius:8px;color:#e9edef;padding:9px 11px;font-size:14px;outline:none;width:100%;box-sizing:border-box;margin-top:4px}
      #hb-tog{position:fixed;top:14px;right:0;z-index:100000;background:#00a884;color:#fff;border:0;border-radius:8px 0 0 8px;padding:8px 9px;cursor:pointer;font-size:16px;transition:right .22s ease;line-height:1}
    `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'hb-panel';
        panel.className = 'hb-col';
        panel.innerHTML = `
      <div id="hb-grip" title="Arrastrar para redimensionar"></div>
      <div id="hb-bar"><span class="hb-t">🤖 Herbalis · Panel</span><span class="hb-sp"></span><button id="hb-close" title="Cerrar">✕</button></div>
      <div id="hb-body">
        <div id="hb-open">Chat abierto: <b id="hb-openname">—</b></div>
        <div class="hb-grid">
          <button class="hb-act warn" data-act="pause">⏸ Pausar</button>
          <button class="hb-act" data-act="resume">▶ Reactivar</button>
          <button class="hb-act" data-act="summarize">📝 Resumen</button>
          <button class="hb-act" data-act="reset">🧹 Limpiar</button>
        </div>
        <div class="hb-sec">Guión (V7) — click para insertar</div>
        <div id="hb-steps"><span style="color:#8696a0;font-size:12px">Cargando guion…</span></div>
        <div class="hb-sep"></div>
        <label style="font-size:12px;color:#8696a0">Mensaje al chat abierto</label>
        <textarea id="hb-msg" placeholder="Escribí o insertá un paso del guion…"></textarea>
        <button id="hb-send-open" class="hb-send">Enviar al chat abierto</button>
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

        // ── Guión (pasos) ─────────────────────────────────────────────────────
        (async () => {
            const cont = document.getElementById('hb-steps');
            if (typeof window.hbGetScript !== 'function') { cont.innerHTML = '<span style="color:#8696a0;font-size:12px">Agente no conectado.</span>'; return; }
            try {
                const r = await window.hbGetScript();
                if (!r || !r.ok) { cont.innerHTML = '<span style="color:#f15c6d;font-size:12px">No pude cargar el guion' + (r && r.error ? ': ' + r.error : '') + '</span>'; return; }
                const flow = r.flow || {};
                const keys = Object.keys(flow).filter((k) => flow[k] && flow[k].response);
                if (!keys.length) { cont.innerHTML = '<span style="color:#8696a0;font-size:12px">Sin pasos.</span>'; return; }
                cont.innerHTML = '';
                keys.forEach((k) => {
                    const div = document.createElement('div');
                    div.className = 'hb-step';
                    const resp = flow[k].response;
                    div.innerHTML = `<div class="k">${k.replace(/_/g, ' ')}</div><div class="p"></div>`;
                    div.querySelector('.p').textContent = resp;
                    div.onclick = () => { document.getElementById('hb-msg').value = resp; document.getElementById('hb-msg').focus(); feed('Paso insertado — revisá y "Enviar al chat abierto". (Los {{…}} se completan a mano por ahora.)', ''); };
                    cont.appendChild(div);
                });
            } catch (e) { cont.innerHTML = '<span style="color:#f15c6d;font-size:12px">Error: ' + (e.message || e) + '</span>'; }
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
