/**
 * bridge.js  (mundo MAIN — corre en el contexto de la página de WhatsApp Web)
 *
 * Tiene acceso a `window.WPP` (wa-js, inyectado por wa-js.js antes que este script).
 * Traduce entre la API de wa-js y los frames del protocolo del gateway:
 *
 *   connector.js  ──cmd (postMessage)──►  bridge.js  ──►  WPP.*  (ejecuta en WhatsApp)
 *   WhatsApp (eventos wa-js)  ──►  bridge.js  ──evt (postMessage)──►  connector.js ──► WS
 *
 * ⚠️ VERIFICAR las firmas de wa-js contra la versión bundleada en wa-js.js.
 *    @wppconnect/wa-js cambia nombres de métodos/eventos entre majors. Todas las
 *    llamadas están centralizadas acá para que ajustar una versión sea un solo lugar.
 */
(() => {
  'use strict';

  // ── Puente con el mundo ISOLATED (connector.js) ───────────────────────────
  function toConnector(frame) {
    window.postMessage({ __herbalis: 'evt', frame }, '*');
  }
  function ack(id, ok, payload) {
    if (id == null) return;
    toConnector(ok ? { t: 'ack', id, ok: true, result: payload } : { t: 'ack', id, ok: false, error: String(payload) });
  }

  // ── Normalización de mensajes a la forma que espera el cerebro (wwebjs-like) ─
  function serializeId(id) {
    if (!id) return '';
    if (typeof id === 'string') return id;
    return id._serialized || (id.toString && id.toString()) || '';
  }
  function serializeWid(w) {
    if (!w) return undefined;
    if (typeof w === 'string') return w;
    return w._serialized || (w.toString && w.toString()) || undefined;
  }
  const MEDIA_TYPES = new Set(['image', 'audio', 'ptt', 'video', 'document', 'sticker']);

  function serializeMsg(m) {
    const type = m.type || 'chat';
    return {
      id: { _serialized: serializeId(m.id) },
      from: serializeWid(m.from),
      to: serializeWid(m.to),
      author: serializeWid(m.author),
      body: m.body ?? m.caption ?? '',
      type,
      hasMedia: MEDIA_TYPES.has(type) || !!m.mediaData || !!m.isMedia,
      timestamp: m.t || m.timestamp || Math.floor(Date.now() / 1000),
      fromMe: !!(m.id && m.id.fromMe) || !!m.fromMe,
    };
  }

  async function blobToBase64(blob) {
    if (typeof blob === 'string') return blob; // ya es base64/dataURI
    if (window.WPP?.util?.blobToBase64) {
      const d = await WPP.util.blobToBase64(blob);
      return String(d).replace(/^data:[^;]+;base64,/, '');
    }
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^;]+;base64,/, ''));
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  // ── Comandos entrantes (del cerebro vía connector) ────────────────────────
  async function handleCommand(frame) {
    const { t, id } = frame;
    try {
      switch (t) {
        case 'sync':
          emitCurrentState();
          return;

        case 'send_text': {
          const res = await WPP.chat.sendTextMessage(frame.chatId, frame.text, { createChat: true });
          ack(id, true, { msgId: serializeId(res && res.id) });
          return;
        }

        case 'send_media': {
          const dataUri = `data:${frame.mimetype};base64,${frame.data}`;
          const opts = frame.opts || {};
          const sendOpts = { createChat: true, caption: opts.caption || undefined };
          if (frame.mimetype.startsWith('audio')) { sendOpts.type = 'audio'; sendOpts.isPtt = !!opts.isPtt; }
          else if (frame.mimetype.startsWith('image')) { sendOpts.type = 'image'; }
          else { sendOpts.type = 'document'; sendOpts.filename = frame.filename || undefined; }
          const res = await WPP.chat.sendFileMessage(frame.chatId, dataUri, sendOpts);
          ack(id, true, { msgId: serializeId(res && res.id) });
          return;
        }

        case 'typing':
          await WPP.chat.markIsComposing(frame.chatId, 3000);
          return; // fire-and-forget (sin id)

        case 'clear_state':
          await WPP.chat.markIsPaused(frame.chatId);
          return;

        case 'seen':
          await WPP.chat.markIsRead(frame.chatId);
          return;

        case 'download': {
          const media = await WPP.chat.downloadMedia(frame.msgId);
          const b64 = media ? await blobToBase64(media.data || media) : null;
          const mimetype = (media && (media.mimetype || media.type)) || 'application/octet-stream';
          ack(id, true, b64 ? { mimetype, data: b64 } : {});
          return;
        }

        case 'fetch_messages': {
          const msgs = await WPP.chat.getMessages(frame.chatId, { count: frame.limit || 50 });
          ack(id, true, { messages: (msgs || []).map(serializeMsg) });
          return;
        }

        default:
          // comando desconocido — ignorar
          return;
      }
    } catch (e) {
      console.error('[HERBALIS] cmd', t, e);
      ack(id, false, e && e.message ? e.message : e);
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__herbalis !== 'cmd') return;
    handleCommand(d.frame);
  });

  // ── Estado / eventos de WhatsApp → cerebro ────────────────────────────────
  function emitCurrentState() {
    try {
      if (WPP.conn.isAuthenticated && WPP.conn.isAuthenticated()) {
        const me = getMyNumber();
        toConnector({ t: 'ready', phone: me });
      } else {
        emitQr();
      }
    } catch (e) { console.warn('[HERBALIS] emitCurrentState', e); }
  }

  function getMyNumber() {
    try {
      const w = WPP.whatsapp.UserPrefs.getMaybeMeUser();
      return serializeWid(w) ? serializeWid(w).split('@')[0] : '';
    } catch { return ''; }
  }

  async function emitQr() {
    try {
      const code = await WPP.conn.getAuthCode();
      toConnector({ t: 'qr', data: (code && (code.fullCode || code.ascii)) || '' });
    } catch {
      toConnector({ t: 'qr', data: '' });
    }
  }

  function wireEvents() {
    // Autenticación / QR
    WPP.conn.on('require_auth', () => emitQr());
    WPP.conn.on('auth_code_change', (c) => toConnector({ t: 'qr', data: (c && (c.fullCode || c.ascii)) || '' }));
    WPP.conn.on('authenticated', () => toConnector({ t: 'ready', phone: getMyNumber() }));
    WPP.conn.on('main_ready', () => toConnector({ t: 'ready', phone: getMyNumber() }));
    WPP.conn.on('logout', () => toConnector({ t: 'state', state: 'UNPAIRED' }));

    // Mensajes
    WPP.on('chat.new_message', (msg) => {
      try {
        const s = serializeMsg(msg);
        if (!s.from) return;
        // Entrante (del cliente) → 'incoming'. Saliente desde el celular del
        // vendedor (respuesta manual) → 'outgoing' (intervención manual).
        toConnector({ t: s.fromMe ? 'outgoing' : 'incoming', msg: s });
      } catch (e) { console.warn('[HERBALIS] new_message', e); }
    });
  }

  // ── Esperar a que wa-js esté listo ────────────────────────────────────────
  function whenWppReady(cb) {
    if (window.WPP && (WPP.isFullReady || WPP.isReady)) return cb();
    let tries = 0;
    const iv = setInterval(() => {
      if (window.WPP && (WPP.isFullReady || WPP.isReady)) { clearInterval(iv); cb(); }
      else if (++tries > 120) { clearInterval(iv); console.error('[HERBALIS] WPP no quedó listo tras 60s'); }
    }, 500);
  }

  whenWppReady(() => {
    console.log('[HERBALIS] wa-js listo — cableando eventos');
    wireEvents();
    emitCurrentState();
  });
})();
