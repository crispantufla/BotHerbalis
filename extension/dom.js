/**
 * dom.js  (content script, mundo ISOLATED)
 *
 * El brazo del bot por DOM: lee los mensajes que WhatsApp Web pinta en pantalla y
 * escribe respuestas como lo haría un humano. NO usa wa-js ni se engancha a módulos
 * internos → no rompe la carga de WhatsApp.
 *
 * Vive en el mundo aislado del content script: tiene DOM + chrome.storage + WebSocket.
 * Habla con el gateway de Railway (/agent) usando el MISMO protocolo de frames que ya
 * entiende remoteClient.ts. Railway no cambia.
 *
 * FASE 1: recepción (observa mensajes entrantes y los manda a Railway) + envío en el
 * chat que esté abierto. La apertura automática de chats no-leídos es Fase 1b.
 */
(() => {
  'use strict';

  // ── Selectores (centralizados — si WhatsApp cambia el DOM, se tocan acá) ──────
  const SEL = {
    paneSide: '#pane-side',
    main: '#main',
    message: 'div[data-id]',                 // cada mensaje; data-id = <fromMe>_<chatId>_<hash>
    textInMessage: 'span.selectable-text',    // texto del mensaje
    prePlainText: '[data-pre-plain-text]',    // "[hora, fecha] Remitente:"
    composeBox: 'footer div[contenteditable="true"]',
    sendIcon: 'span[data-icon="send"], button[data-icon="send"], [data-icon="wds-ic-send-filled"]',
  };

  const HB_INTERVAL_MS = 15000;
  const RECONNECT_BASE_MS = 2000;
  const RECONNECT_MAX_MS = 30000;

  // ── Estado ───────────────────────────────────────────────────────────────────
  let ws = null;
  let hbTimer = null;
  let reconnectAttempts = 0;
  let cfg = null;
  let closedByUs = false;
  const seenIds = new Set();          // dedupe de mensajes ya reenviados (por data-id)
  let readySent = false;
  let lastOpenChat = null;            // para detectar cambios de chat
  let settlingUntil = 0;              // ventana tras abrir un chat: sembrar, no reenviar
  let selfSendingUntil = 0;           // ventana mientras el bot envía: no tratar su propio msg como manual

  const log = (...a) => console.log('[HERBALIS-DOM]', ...a);

  // ── Parseo de mensajes del DOM ───────────────────────────────────────────────
  // data-id: `false_5491122334455@c.us_3EB0...`  →  [fromMe, chatId, hash]
  function parseDataId(dataId) {
    const i = dataId.indexOf('_');
    const j = dataId.indexOf('_', i + 1);
    if (i < 0 || j < 0) return null;
    const fromMe = dataId.slice(0, i) === 'true';
    const chatId = dataId.slice(i + 1, j);   // ej. 549...@c.us  o  ...@g.us
    return { fromMe, chatId, msgId: dataId };
  }

  function extractMessage(el) {
    const dataId = el.getAttribute('data-id');
    if (!dataId) return null;
    const parsed = parseDataId(dataId);
    if (!parsed) return null;

    // Texto: junta todos los selectable-text (mensajes largos se parten en spans)
    const spans = el.querySelectorAll(SEL.textInMessage);
    let body = '';
    spans.forEach((s) => { body += s.textContent; });
    body = body.trim();

    // timestamp + remitente desde data-pre-plain-text: "[20:13, 9/6/2026] Juan: "
    let timestamp = Math.floor(Date.now() / 1000);
    let author;
    const pre = el.querySelector(SEL.prePlainText) || el.closest(SEL.prePlainText);
    const preAttr = pre && pre.getAttribute('data-pre-plain-text');
    if (preAttr) {
      const m = preAttr.match(/^\[(.+?)\]\s*(.*?):\s*$/);
      if (m) author = m[2];
    }

    return {
      id: { _serialized: parsed.msgId },
      from: parsed.chatId,
      to: undefined,
      body,
      type: 'chat',
      hasMedia: false,            // multimedia → Fase 3
      timestamp,
      author,
      fromMe: parsed.fromMe,
    };
  }

  // Procesa un nodo de mensaje: dedup + reenvío a Railway.
  function processMessageEl(el) {
    const dataId = el.getAttribute('data-id');
    if (!dataId || seenIds.has(dataId)) return;
    const msg = extractMessage(el);
    if (!msg || !msg.body) return;     // sin texto (Fase 1 solo texto)
    seenIds.add(dataId);

    // Mensaje saliente mientras el bot estaba enviando → es del propio bot, no manual.
    // No se reenvía como 'outgoing' para que Railway no lo lea como intervención.
    if (msg.fromMe && Date.now() < selfSendingUntil) {
      log('saliente propio (bot) — ignorado');
      return;
    }
    // cap de memoria del set
    if (seenIds.size > 5000) { seenIds.clear(); }

    log(msg.fromMe ? 'saliente' : 'ENTRANTE', msg.from, '→', JSON.stringify(msg.body).slice(0, 80));
    wsSend({ t: msg.fromMe ? 'outgoing' : 'incoming', msg });
  }

  // ── Observer: captura mensajes que aparecen en el DOM ────────────────────────
  // Cuando hay un chat abierto y llega/se manda un mensaje, WhatsApp inserta un
  // div[data-id] en #main. Un observer global lo cacha sin importar el pane.
  function startObserver() {
    const seedExisting = () => {
      // Marca como "ya vistos" los mensajes que YA estaban al abrir (no reenviar historial).
      document.querySelectorAll(SEL.message).forEach((el) => {
        const id = el.getAttribute('data-id');
        if (id) seenIds.add(id);
      });
      log(`observer activo — ${seenIds.size} mensajes existentes marcados como vistos`);
    };

    const obs = new MutationObserver((mutations) => {
      // Junta todos los nodos-mensaje nuevos de este batch.
      const newEls = [];
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches(SEL.message)) newEls.push(node);
          if (node.querySelectorAll) node.querySelectorAll(SEL.message).forEach((e) => newEls.push(e));
        }
      }
      if (!newEls.length) return;

      // ¿Cambió el chat abierto? → ventana de "settling": WhatsApp está pintando el
      // historial de ESE chat. Sembrarlo como visto, NO reenviarlo a Railway.
      const open = openChatId();
      if (open && open !== lastOpenChat) {
        lastOpenChat = open;
        settlingUntil = Date.now() + 2000;
        log('cambio de chat →', open, '(sembrando historial, no se reenvía)');
      }
      const settling = Date.now() < settlingUntil;

      for (const el of newEls) {
        if (settling) {
          const id = el.getAttribute('data-id');
          if (id) seenIds.add(id);
        } else {
          processMessageEl(el);
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // Sembrar lo existente una vez que #main aparezca (sesión ya logueada).
    if (document.querySelector(SEL.main)) seedExisting();
    else {
      const wait = setInterval(() => {
        if (document.querySelector(SEL.main)) { clearInterval(wait); seedExisting(); }
      }, 1000);
    }
  }

  // ── Envío (Fase 1: solo si el chat objetivo ya está abierto) ─────────────────
  function openChatId() {
    // chatId del chat abierto = el del primer mensaje visible en #main
    const main = document.querySelector(SEL.main);
    if (!main) return null;
    const m = main.querySelector(SEL.message);
    if (!m) return null;
    const p = parseDataId(m.getAttribute('data-id') || '');
    return p && p.chatId;
  }

  async function sendText(chatId, text) {
    const open = openChatId();
    if (open !== chatId) {
      // Fase 2: abrir el chat por el buscador. Por ahora, solo si ya está abierto.
      throw new Error(`chat ${chatId} no está abierto (Fase 2: apertura automática)`);
    }
    const box = document.querySelector(SEL.composeBox);
    if (!box) throw new Error('no encontré la caja de texto');
    selfSendingUntil = Date.now() + 5000;   // marca: lo que salga ahora es del bot
    box.focus();
    // execCommand insertText dispara los eventos que el editor de WhatsApp escucha.
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      // Fallback: evento paste sintético
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    await sleep(250);
    const sendBtn = document.querySelector(SEL.sendIcon);
    if (sendBtn) {
      (sendBtn.closest('button') || sendBtn).click();
    } else {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }
    return { msgId: `dom_${Date.now()}` };
  }

  // ── Manejo de comandos del cerebro ───────────────────────────────────────────
  async function handleCommand(frame) {
    const { t, id } = frame;
    try {
      switch (t) {
        case 'sync':
          maybeSendReady();
          return;
        case 'send_text': {
          const r = await sendText(frame.chatId, frame.text);
          ack(id, true, r);
          return;
        }
        case 'send_media':
          ack(id, false, 'multimedia es Fase 3');
          return;
        case 'seen':
        case 'typing':
        case 'clear_state':
          return; // fire-and-forget, Fase 4
        case 'download':
          ack(id, false, 'descarga es Fase 3');
          return;
        case 'fetch_messages':
          ack(id, true, { messages: [] });
          return;
        default:
          return;
      }
    } catch (e) {
      log('cmd', t, 'falló:', e.message);
      ack(id, false, e.message);
    }
  }

  function ack(id, ok, payload) {
    if (id == null) return;
    wsSend(ok ? { t: 'ack', id, ok: true, result: payload } : { t: 'ack', id, ok: false, error: String(payload) });
  }

  function maybeSendReady() {
    // Si hay sesión cargada (#pane-side presente), avisamos ready a Railway.
    if (document.querySelector(SEL.paneSide)) {
      wsSend({ t: 'ready', phone: '' });
      readySent = true;
      log('ready enviado');
    }
  }

  // ── WebSocket al gateway ─────────────────────────────────────────────────────
  function wsSend(frame) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(frame)); } catch (e) { /* noop */ }
    }
  }

  async function loadConfig() {
    return new Promise((r) => chrome.storage.local.get(['gatewayUrl', 'sellerId', 'token'], (x) => r(x || {})));
  }

  async function connect() {
    cfg = await loadConfig();
    if (!cfg.gatewayUrl || !cfg.sellerId || !cfg.token) {
      log('falta config (gatewayUrl/sellerId/token). Abrí las opciones de la extensión.');
      return;
    }
    log(`conectando a ${cfg.gatewayUrl} como ${cfg.sellerId}…`);
    try { ws = new WebSocket(cfg.gatewayUrl); } catch (e) { log('URL inválida', e); return; }

    ws.onopen = () => {
      reconnectAttempts = 0;
      wsSend({ t: 'auth', sellerId: cfg.sellerId, token: cfg.token });
      startHeartbeat();
      readySent = false;
      maybeSendReady();
      log('WS abierto, auth enviado');
    };
    ws.onmessage = (ev) => {
      let frame; try { frame = JSON.parse(ev.data); } catch { return; }
      handleCommand(frame);
    };
    ws.onclose = () => { stopHeartbeat(); if (!closedByUs) scheduleReconnect(); };
    ws.onerror = () => { /* onclose maneja el retry */ };
  }

  function scheduleReconnect() {
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    reconnectAttempts++;
    setTimeout(connect, delay);
  }
  function startHeartbeat() { stopHeartbeat(); hbTimer = setInterval(() => wsSend({ t: 'hb' }), HB_INTERVAL_MS); }
  function stopHeartbeat() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }

  chrome.storage.onChanged.addListener((_c, area) => {
    if (area !== 'local') return;
    closedByUs = true; try { ws && ws.close(); } catch {} closedByUs = false;
    reconnectAttempts = 0; connect();
  });

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ── Arranque ─────────────────────────────────────────────────────────────────
  log('cargado');
  startObserver();
  connect();
})();
