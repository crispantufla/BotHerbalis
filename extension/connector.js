/**
 * connector.js  (mundo ISOLATED)
 *
 * Vive en el content-script aislado: tiene acceso a chrome.storage y abre el
 * WebSocket hacia el gateway en Railway (/agent). NO puede tocar window.WPP
 * (eso vive en el mundo MAIN), así que hace de puente:
 *
 *   WS (Railway)  ──cmd──►  postMessage  ──►  bridge.js (MAIN, ejecuta wa-js)
 *   WS (Railway)  ◄──evt──  postMessage  ◄──  bridge.js (eventos de WhatsApp)
 *
 * Config (gatewayUrl, sellerId, token) se carga desde chrome.storage.local,
 * editable en la página de opciones de la extensión.
 */
(() => {
  'use strict';

  const HB_INTERVAL_MS = 15000;
  const RECONNECT_BASE_MS = 2000;
  const RECONNECT_MAX_MS = 30000;

  let ws = null;
  let hbTimer = null;
  let reconnectAttempts = 0;
  let cfg = null;
  let closedByUs = false;

  // ── Puente con el mundo MAIN (bridge.js) ──────────────────────────────────
  // bridge.js manda eventos de WhatsApp para reenviar al WS.
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__herbalis !== 'evt') return;
    wsSend(d.frame);
  });

  function toBridge(frame) {
    window.postMessage({ __herbalis: 'cmd', frame }, '*');
  }

  function wsSend(frame) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(frame)); } catch (e) { console.warn('[HERBALIS] wsSend', e); }
    }
  }

  // ── Conexión ──────────────────────────────────────────────────────────────
  async function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['gatewayUrl', 'sellerId', 'token'], (r) => resolve(r || {}));
    });
  }

  async function connect() {
    cfg = await loadConfig();
    if (!cfg.gatewayUrl || !cfg.sellerId || !cfg.token) {
      console.warn('[HERBALIS] Falta config (gatewayUrl/sellerId/token). Abrí las opciones de la extensión.');
      return; // sin config no reintenta; reabrir tras configurar
    }

    console.log(`[HERBALIS] Conectando a ${cfg.gatewayUrl} como ${cfg.sellerId}…`);
    try {
      ws = new WebSocket(cfg.gatewayUrl);
    } catch (e) {
      console.error('[HERBALIS] URL de gateway inválida:', e);
      return;
    }

    ws.onopen = () => {
      reconnectAttempts = 0;
      wsSend({ t: 'auth', sellerId: cfg.sellerId, token: cfg.token });
      startHeartbeat();
      // Pedir a bridge.js que (re)emita el estado actual de WhatsApp.
      toBridge({ t: 'sync' });
      console.log('[HERBALIS] WS abierto, auth enviado');
    };

    ws.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      // Comandos del cerebro (send_text, send_media, typing, seen, download, fetch_messages)
      toBridge(frame);
    };

    ws.onclose = () => {
      stopHeartbeat();
      if (closedByUs) return;
      scheduleReconnect();
    };

    ws.onerror = (e) => {
      console.warn('[HERBALIS] WS error', e);
      // onclose se dispara a continuación y maneja el reintento.
    };
  }

  function scheduleReconnect() {
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    reconnectAttempts++;
    console.log(`[HERBALIS] Reconectando en ${delay / 1000}s…`);
    setTimeout(connect, delay);
  }

  function startHeartbeat() {
    stopHeartbeat();
    hbTimer = setInterval(() => wsSend({ t: 'hb' }), HB_INTERVAL_MS);
  }
  function stopHeartbeat() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  }

  // Reconectar si cambia la config desde la página de opciones.
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area !== 'local') return;
    console.log('[HERBALIS] Config cambiada — reconectando');
    closedByUs = true;
    try { ws && ws.close(); } catch { /* noop */ }
    closedByUs = false;
    reconnectAttempts = 0;
    connect();
  });

  connect();
})();
