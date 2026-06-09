/**
 * sidebar.js — Panel lateral (botonera) inyectado en la ventana de WhatsApp del agente.
 *
 * A la DERECHA, empuja la ventana de WhatsApp (no la tapa). Replica los botones del
 * asistente de IA del chat del dashboard (Pausar/Reactivar, Resumen, Confirmar pedido,
 * Limpiar) + envío de mensajes. El panel NO toca WhatsApp ni la API directo: llama a
 * funciones que el agente expone (hbAction / hbSendToOpenChat / hbSendMessage), que
 * ejecutan wwebjs o la API de Railway en Node (sin CORS).
 */
'use strict';

const PANEL_W = 360;

function bootstrap(W) {
    if (window.__hbInit) return;
    window.__hbInit = true;

    function openChatName() {
        const h = document.querySelector('#main header');
        if (!h) return null;
        const t = (h.innerText || '').split('\n')[0].trim();
        return t || null;
    }
    function setPush(on) {
        const app = document.querySelector('#app');
        if (app) app.style.width = on ? `calc(100% - ${W}px)` : '';
    }

    function build() {
        if (!document.body) { setTimeout(build, 300); return; }
        if (document.getElementById('hb-panel')) return;

        const style = document.createElement('style');
        style.textContent = `
      #hb-panel{position:fixed;top:0;right:0;height:100vh;width:${W}px;background:#0b141a;color:#e9edef;
        font-family:system-ui,Segoe UI,sans-serif;z-index:99999;box-shadow:-2px 0 14px rgba(0,0,0,.5);
        display:flex;flex-direction:column;transition:transform .22s ease;border-left:1px solid #222d34}
      #hb-panel.hb-col{transform:translateX(${W + 1}px)}
      #hb-bar{display:flex;align-items:center;padding:12px 14px;background:#111b21;border-bottom:1px solid #222d34}
      #hb-bar .hb-t{font-weight:600;font-size:14px}.hb-sp{flex:1}
      #hb-bar button{background:#202c33;color:#aebac1;border:0;border-radius:6px;width:28px;height:28px;cursor:pointer}
      #hb-body{padding:14px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}
      #hb-open{background:#111b21;border:1px solid #222d34;border-radius:8px;padding:10px 12px;font-size:13px;color:#aebac1}
      #hb-open b{color:#e9edef}
      .hb-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px}
      .hb-act{background:#202c33;color:#e9edef;border:1px solid #2a3942;border-radius:8px;padding:10px;font-size:13px;
        font-weight:500;cursor:pointer;text-align:center}
      .hb-act:hover{background:#2a3942}.hb-act:disabled{opacity:.5;cursor:default}
      .hb-act.warn{border-color:#f1b44c;color:#f1b44c}.hb-act.good{border-color:#00a884;color:#00d26a}
      .hb-sep{border-top:1px solid #222d34;margin:12px 0 4px}
      #hb-body label{font-size:12px;color:#8696a0}
      #hb-body textarea{background:#202c33;border:1px solid #2a3942;border-radius:8px;color:#e9edef;padding:9px 11px;
        font-size:14px;font-family:inherit;resize:vertical;min-height:64px;outline:none;width:100%;box-sizing:border-box}
      #hb-body textarea:focus{border-color:#00a884}
      .hb-send{margin-top:8px;background:#00a884;color:#fff;border:0;border-radius:8px;padding:11px;font-size:14px;
        font-weight:600;cursor:pointer;width:100%}.hb-send:disabled{opacity:.5}
      #hb-feed{margin-top:10px;font-size:13px;white-space:pre-wrap;max-height:30vh;overflow-y:auto}
      #hb-feed.ok{color:#00d26a}#hb-feed.err{color:#f15c6d}
      #hb-body details{margin-top:10px}#hb-body summary{color:#8696a0;font-size:12px;cursor:pointer}
      #hb-body input{background:#202c33;border:1px solid #2a3942;border-radius:8px;color:#e9edef;padding:9px 11px;
        font-size:14px;outline:none;width:100%;box-sizing:border-box;margin-top:4px}
      #hb-tog{position:fixed;top:14px;right:0;z-index:100000;background:#00a884;color:#fff;border:0;
        border-radius:8px 0 0 8px;padding:8px 9px;cursor:pointer;font-size:16px;transition:right .22s ease;line-height:1}
      #hb-panel:not(.hb-col)~#hb-tog{right:${W}px}
    `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'hb-panel';
        panel.className = 'hb-col';
        panel.innerHTML = `
      <div id="hb-bar">
        <span class="hb-t">🤖 Herbalis · Panel</span><span class="hb-sp"></span>
        <button id="hb-close" title="Cerrar">✕</button>
      </div>
      <div id="hb-body">
        <div id="hb-open">Chat abierto: <b id="hb-openname">—</b></div>
        <div class="hb-grid">
          <button class="hb-act warn" data-act="pause">⏸ Pausar bot</button>
          <button class="hb-act" data-act="resume">▶ Reactivar</button>
          <button class="hb-act" data-act="summarize">📝 Resumen</button>
          <button class="hb-act good" data-act="confirm">✅ Confirmar pedido</button>
          <button class="hb-act" data-act="reset">🧹 Limpiar chat</button>
        </div>
        <div class="hb-sep"></div>
        <label for="hb-msg">Mensaje al chat abierto</label>
        <textarea id="hb-msg" placeholder="Escribí el mensaje…"></textarea>
        <button id="hb-send-open" class="hb-send">Enviar al chat abierto</button>
        <details>
          <summary>o enviar a un número</summary>
          <input id="hb-num" placeholder="34679278596" inputmode="numeric" />
          <button id="hb-send-num" class="hb-send">Enviar al número</button>
        </details>
        <div id="hb-feed"></div>
      </div>
    `;
        document.body.appendChild(panel);

        const tog = document.createElement('button');
        tog.id = 'hb-tog'; tog.textContent = '🤖'; tog.title = 'Panel Herbalis';
        document.body.appendChild(tog);

        const feed = (msg, cls) => { const f = document.getElementById('hb-feed'); f.textContent = msg; f.className = cls || ''; };
        const toggle = () => {
            panel.classList.toggle('hb-col');
            setPush(!panel.classList.contains('hb-col'));
        };
        tog.onclick = toggle;
        document.getElementById('hb-close').onclick = () => { panel.classList.add('hb-col'); setPush(false); };

        async function run(btn, fn, okMsg) {
            if (btn.disabled) return;
            btn.disabled = true; feed('Procesando…', '');
            try {
                const r = await fn();
                if (r && r.ok) {
                    if (r.data) feed((r.msg ? r.msg + ':\n\n' : '') + (typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2)), 'ok');
                    else feed('✅ ' + (r.msg || okMsg || 'Listo'), 'ok');
                } else feed('✗ ' + ((r && r.error) || 'error'), 'err');
            } catch (e) { feed('✗ ' + (e.message || e), 'err'); }
            finally { btn.disabled = false; }
        }

        panel.querySelectorAll('.hb-act').forEach((b) => {
            b.onclick = () => {
                const act = b.getAttribute('data-act');
                if (typeof window.hbAction !== 'function') { feed('Agente no conectado.', 'err'); return; }
                if (act === 'reset' && !window.confirm('¿Reiniciar el historial de este chat?')) return;
                if (act === 'confirm' && !window.confirm('¿Confirmar/completar el pedido de este chat?')) return;
                run(b, () => window.hbAction(act));
            };
        });

        document.getElementById('hb-send-open').onclick = (e) => {
            const msg = document.getElementById('hb-msg').value || '';
            if (!msg.trim()) { feed('Falta el mensaje.', 'err'); return; }
            if (typeof window.hbSendToOpenChat !== 'function') { feed('Agente no conectado.', 'err'); return; }
            run(e.target, async () => { const r = await window.hbSendToOpenChat(msg); if (r && r.ok) document.getElementById('hb-msg').value = ''; return r; }, 'Enviado');
        };
        document.getElementById('hb-send-num').onclick = (e) => {
            const num = (document.getElementById('hb-num').value || '').replace(/\D/g, '');
            const msg = document.getElementById('hb-msg').value || '';
            if (!num) { feed('Falta el número.', 'err'); return; }
            if (!msg.trim()) { feed('Falta el mensaje.', 'err'); return; }
            if (typeof window.hbSendMessage !== 'function') { feed('Agente no conectado.', 'err'); return; }
            run(e.target, () => window.hbSendMessage(num, msg), 'Enviado');
        };

        setInterval(() => {
            const el = document.getElementById('hb-openname');
            if (el) el.textContent = openChatName() || '— (ninguno abierto)';
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
