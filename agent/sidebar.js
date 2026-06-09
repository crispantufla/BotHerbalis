/**
 * sidebar.js — Panel lateral (botonera) inyectado en la ventana de WhatsApp del agente.
 *
 * v1: enviar un mensaje (al chat abierto o a un número). El panel NO toca WhatsApp directo:
 * llama a window.hbSendToOpenChat / window.hbSendMessage (expuestas por el agente vía
 * page.exposeFunction), que ejecutan client.sendMessage en Node. Sin iframe, sin Railway.
 */
'use strict';

// Corre DENTRO de la página de WhatsApp.
function bootstrap() {
    if (window.__hbInit) return;
    window.__hbInit = true;

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
      #hb-panel{position:fixed;top:0;left:0;height:100vh;width:320px;background:#0b141a;color:#e9edef;
        font-family:system-ui,Segoe UI,sans-serif;z-index:99999;box-shadow:2px 0 14px rgba(0,0,0,.5);
        display:flex;flex-direction:column;transition:transform .22s ease;border-right:1px solid #222d34}
      #hb-panel.hb-col{transform:translateX(-321px)}
      #hb-bar{display:flex;align-items:center;padding:12px 14px;background:#111b21;border-bottom:1px solid #222d34}
      #hb-bar .hb-t{font-weight:600;font-size:14px}
      #hb-bar .hb-sp{flex:1}
      #hb-bar button{background:#202c33;color:#aebac1;border:0;border-radius:6px;width:28px;height:28px;cursor:pointer}
      #hb-body{padding:16px 14px;display:flex;flex-direction:column;gap:6px;overflow-y:auto}
      #hb-open{background:#111b21;border:1px solid #222d34;border-radius:8px;padding:10px 12px;font-size:13px;color:#aebac1}
      #hb-open b{color:#e9edef}
      #hb-body label{font-size:12px;color:#8696a0;margin-top:8px}
      #hb-body input,#hb-body textarea{background:#202c33;border:1px solid #2a3942;border-radius:8px;
        color:#e9edef;padding:9px 11px;font-size:14px;font-family:inherit;outline:none;resize:vertical;width:100%;box-sizing:border-box}
      #hb-body input:focus,#hb-body textarea:focus{border-color:#00a884}
      #hb-body textarea{min-height:80px}
      #hb-body button.hb-btn{margin-top:12px;background:#00a884;color:#fff;border:0;border-radius:8px;padding:11px;
        font-size:14px;font-weight:600;cursor:pointer;width:100%}
      #hb-body button.hb-btn:disabled{opacity:.5;cursor:default}
      #hb-feed{margin-top:12px;font-size:13px;min-height:18px}
      #hb-feed.ok{color:#00d26a}#hb-feed.err{color:#f15c6d}
      #hb-body details{margin-top:16px;border-top:1px solid #222d34;padding-top:8px}
      #hb-body summary{color:#8696a0;font-size:12px;cursor:pointer}
      #hb-tog{position:fixed;top:14px;left:0;z-index:100000;background:#00a884;color:#fff;border:0;
        border-radius:0 8px 8px 0;padding:8px 9px;cursor:pointer;font-size:16px;transition:left .22s ease;line-height:1}
      #hb-panel:not(.hb-col)~#hb-tog{left:320px}
    `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'hb-panel';
        panel.className = 'hb-col';
        panel.innerHTML = `
      <div id="hb-bar">
        <span class="hb-t">🤖 Herbalis · Panel</span>
        <span class="hb-sp"></span>
        <button id="hb-close" title="Cerrar">✕</button>
      </div>
      <div id="hb-body">
        <div id="hb-open">Chat abierto: <b id="hb-openname">—</b></div>
        <label for="hb-msg">Mensaje</label>
        <textarea id="hb-msg" placeholder="Escribí el mensaje…"></textarea>
        <button id="hb-send-open" class="hb-btn">Enviar al chat abierto</button>
        <div id="hb-feed"></div>
        <details>
          <summary>o enviar a un número</summary>
          <label for="hb-num">Número (con código de país, sin +)</label>
          <input id="hb-num" placeholder="34679278596" inputmode="numeric" />
          <button id="hb-send-num" class="hb-btn">Enviar al número</button>
        </details>
      </div>
    `;
        document.body.appendChild(panel);

        const tog = document.createElement('button');
        tog.id = 'hb-tog';
        tog.textContent = '🤖';
        tog.title = 'Panel Herbalis';
        tog.onclick = () => panel.classList.toggle('hb-col');
        document.body.appendChild(tog);
        document.getElementById('hb-close').onclick = () => panel.classList.add('hb-col');

        const feed = (msg, cls) => {
            const f = document.getElementById('hb-feed');
            f.textContent = msg; f.className = cls || '';
        };

        async function withButton(btn, fn) {
            if (btn.disabled) return;
            btn.disabled = true; feed('Enviando…', '');
            try {
                const r = await fn();
                if (r && r.ok) { feed('✅ Enviado', 'ok'); document.getElementById('hb-msg').value = ''; }
                else { feed('✗ ' + ((r && r.error) || 'error'), 'err'); }
            } catch (e) { feed('✗ ' + (e.message || e), 'err'); }
            finally { btn.disabled = false; }
        }

        document.getElementById('hb-send-open').onclick = (e) => {
            const msg = document.getElementById('hb-msg').value || '';
            if (!msg.trim()) { feed('Falta el mensaje.', 'err'); return; }
            if (typeof window.hbSendToOpenChat !== 'function') { feed('Agente no conectado.', 'err'); return; }
            withButton(e.target, () => window.hbSendToOpenChat(msg));
        };
        document.getElementById('hb-send-num').onclick = (e) => {
            const num = (document.getElementById('hb-num').value || '').replace(/\D/g, '');
            const msg = document.getElementById('hb-msg').value || '';
            if (!num) { feed('Falta el número.', 'err'); return; }
            if (!msg.trim()) { feed('Falta el mensaje.', 'err'); return; }
            if (typeof window.hbSendMessage !== 'function') { feed('Agente no conectado.', 'err'); return; }
            withButton(e.target, () => window.hbSendMessage(num, msg));
        };

        // Refresca el nombre del chat abierto.
        setInterval(() => {
            const el = document.getElementById('hb-openname');
            if (el) el.textContent = openChatName() || '— (ninguno abierto)';
        }, 1000);
    }

    build();
    setInterval(build, 3000);   // se reconstruye si WhatsApp lo borra
}

// ── API para el agente ───────────────────────────────────────────────────────
async function injectSidebar(page) {
    if (!page) return;
    await page.evaluateOnNewDocument(bootstrap);   // re-inyección en cada recarga
    await page.evaluate(bootstrap).catch(() => {}); // página actual
}

module.exports = { injectSidebar };
