/**
 * sidebar.js — Panel lateral (botonera) inyectado en la ventana de WhatsApp del agente.
 *
 * v1: enviar un mensaje. El panel NO toca WhatsApp directo: llama a window.hbSendMessage
 * (expuesta por el agente vía page.exposeFunction), que ejecuta client.sendMessage en Node.
 * Sin iframe, sin Railway, sin CSP — autocontenido.
 */
'use strict';

// Corre DENTRO de la página de WhatsApp.
function bootstrap() {
    if (window.__hbInit) return;
    window.__hbInit = true;

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
      #hb-bar .hb-t{font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px}
      #hb-bar .hb-sp{flex:1}
      #hb-bar button{background:#202c33;color:#aebac1;border:0;border-radius:6px;width:28px;height:28px;cursor:pointer}
      #hb-body{padding:16px 14px;display:flex;flex-direction:column;gap:6px;overflow-y:auto}
      #hb-body label{font-size:12px;color:#8696a0;margin-top:8px}
      #hb-body input,#hb-body textarea{background:#202c33;border:1px solid #2a3942;border-radius:8px;
        color:#e9edef;padding:9px 11px;font-size:14px;font-family:inherit;outline:none;resize:vertical}
      #hb-body input:focus,#hb-body textarea:focus{border-color:#00a884}
      #hb-body textarea{min-height:80px}
      #hb-send{margin-top:14px;background:#00a884;color:#fff;border:0;border-radius:8px;padding:11px;
        font-size:14px;font-weight:600;cursor:pointer}
      #hb-send:disabled{opacity:.5;cursor:default}
      #hb-feed{margin-top:12px;font-size:13px;min-height:18px}
      #hb-feed.ok{color:#00d26a}#hb-feed.err{color:#f15c6d}
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
        <span class="hb-t">🤖 Herbalis · Enviar</span>
        <span class="hb-sp"></span>
        <button id="hb-close" title="Cerrar">✕</button>
      </div>
      <div id="hb-body">
        <label for="hb-num">Número (con código de país, sin +)</label>
        <input id="hb-num" placeholder="34679278596" inputmode="numeric" />
        <label for="hb-msg">Mensaje</label>
        <textarea id="hb-msg" placeholder="Escribí el mensaje…"></textarea>
        <button id="hb-send">Enviar</button>
        <div id="hb-feed"></div>
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

        document.getElementById('hb-send').onclick = async () => {
            const num = (document.getElementById('hb-num').value || '').replace(/\D/g, '');
            const msg = document.getElementById('hb-msg').value || '';
            if (!num) { feed('Falta el número.', 'err'); return; }
            if (!msg.trim()) { feed('Falta el mensaje.', 'err'); return; }
            if (typeof window.hbSendMessage !== 'function') { feed('Agente no conectado.', 'err'); return; }
            const btn = document.getElementById('hb-send');
            btn.disabled = true; feed('Enviando…', '');
            try {
                const r = await window.hbSendMessage(num, msg);
                if (r && r.ok) { feed('✅ Enviado', 'ok'); document.getElementById('hb-msg').value = ''; }
                else { feed('✗ ' + ((r && r.error) || 'error'), 'err'); }
            } catch (e) {
                feed('✗ ' + (e.message || e), 'err');
            } finally { btn.disabled = false; }
        };
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
