/**
 * sidebar.js — Panel lateral inyectado en la ventana de WhatsApp Web del agente.
 *
 * En vez de reimplementar el front, embebe el **dashboard real** en un iframe. Así el
 * vendedor tiene todas las funciones (modales, confirmar pedido, etc.) sin duplicar nada.
 *
 * Requiere:
 *  - agente: page.setBypassCSP(true) para que la CSP de WhatsApp no bloquee el iframe.
 *  - server: frame-ancestors permitiendo web.whatsapp.com (ver src/api/server.js).
 *
 * Se re-inyecta solo en cada recarga (evaluateOnNewDocument) y se auto-reconstruye.
 */
'use strict';

// Corre DENTRO de la página de WhatsApp.
function bootstrap(config) {
    if (window.__hbInit) return;
    window.__hbInit = true;
    const URL = config.dashboardUrl;

    function build() {
        if (!document.body) { setTimeout(build, 300); return; }
        if (document.getElementById('hb-panel')) return;

        const style = document.createElement('style');
        style.textContent = `
      #hb-panel{position:fixed;top:0;left:0;height:100vh;width:min(64vw,900px);background:#0b141a;
        z-index:99999;box-shadow:2px 0 16px rgba(0,0,0,.55);display:flex;flex-direction:column;
        transition:transform .22s ease;border-right:1px solid #222d34}
      #hb-panel.hb-col{transform:translateX(-101%)}
      #hb-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#111b21;
        color:#e9edef;font-family:system-ui,Segoe UI,sans-serif;font-size:13px;border-bottom:1px solid #222d34}
      #hb-bar .hb-title{font-weight:600;display:flex;align-items:center;gap:8px}
      #hb-bar .hb-sp{flex:1}
      #hb-bar button{background:#202c33;color:#aebac1;border:0;border-radius:6px;width:28px;height:28px;
        cursor:pointer;font-size:14px;line-height:1}
      #hb-bar button:hover{background:#2a3942;color:#fff}
      #hb-frame{flex:1;width:100%;border:0;background:#fff}
      #hb-tog{position:fixed;top:14px;left:0;z-index:100000;background:#00a884;color:#fff;border:0;
        border-radius:0 8px 8px 0;padding:8px 9px;cursor:pointer;font-size:16px;transition:left .22s ease;line-height:1}
      #hb-panel:not(.hb-col)~#hb-tog{left:min(64vw,900px)}
    `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'hb-panel';
        panel.className = 'hb-col';
        panel.innerHTML = `
      <div id="hb-bar">
        <span class="hb-title">🤖 Herbalis · Panel</span>
        <span class="hb-sp"></span>
        <button id="hb-reload" title="Recargar">⟳</button>
        <button id="hb-close" title="Cerrar">✕</button>
      </div>
      <iframe id="hb-frame" src="${URL}" allow="clipboard-read; clipboard-write; microphone; camera"></iframe>
    `;
        document.body.appendChild(panel);

        const tog = document.createElement('button');
        tog.id = 'hb-tog';
        tog.textContent = '🤖';
        tog.title = 'Panel Herbalis';
        tog.onclick = () => panel.classList.toggle('hb-col');
        document.body.appendChild(tog);

        document.getElementById('hb-close').onclick = () => panel.classList.add('hb-col');
        document.getElementById('hb-reload').onclick = () => {
            const f = document.getElementById('hb-frame');
            if (f) f.src = f.src;
        };
    }

    build();
    // Si WhatsApp re-renderiza y borra el panel, lo reconstruimos.
    setInterval(build, 3000);
}

// ── API para el agente ───────────────────────────────────────────────────────
async function injectSidebar(page, opts) {
    if (!page) return;
    const cfg = { dashboardUrl: (opts && opts.dashboardUrl) || 'https://mainherbalisbot-production.up.railway.app' };
    try { await page.setBypassCSP(true); } catch (e) { /* algunas versiones ya lo traen */ }
    await page.evaluateOnNewDocument(bootstrap, cfg);   // re-inyección en cada recarga
    await page.evaluate(bootstrap, cfg).catch(() => {}); // página actual
}

module.exports = { injectSidebar };
