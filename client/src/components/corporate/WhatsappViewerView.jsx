import React, { useCallback, useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc/lib/rfb.js';
import { useSeller } from '../../context/SellerContext';
import { useAuth } from '../../context/AuthContext';
import { AlertTriangle, Wifi, WifiOff, ExternalLink, Users, Clock, Maximize2, Minimize2, Clipboard, Copy, ClipboardPaste } from 'lucide-react';

function apiBase() {
    // Dev runs Vite on :3000 and server on :3001; prod serves both from same host.
    return import.meta.env?.VITE_API_URL || '';
}

function timeAgo(ts) {
    if (!ts) return '—';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    return `${h}h`;
}

/**
 * WhatsApp Web viewer — connects to the bot's real Chromium via noVNC.
 * Backend runs Xvfb+x11vnc per seller; Express proxies the VNC TCP socket
 * over an authenticated WebSocket at /vnc-ws/:sellerId?token=JWT.
 */
export default function WhatsappViewerView({ standalone = false, sellerIdOverride = null }) {
    const { selectedSellerId } = useSeller();
    const { user } = useAuth();
    const sellerId = sellerIdOverride || selectedSellerId || user?.sellerId || null;

    const screenRef = useRef(null);
    const rfbRef = useRef(null);
    const containerRef = useRef(null); // the element we fullscreen
    // queued = we're at capacity, waiting for a slot to free up
    const [status, setStatus] = useState('connecting'); // connecting | connected | disconnected | error | queued
    const [errorMsg, setErrorMsg] = useState(null);
    const [viewerStatus, setViewerStatus] = useState(null); // { max, activeSellers, headfulCount, atCapacity }
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [clipboardHint, setClipboardHint] = useState(null); // {kind, msg} | null
    const pollTimerRef = useRef(null);
    const attemptRef = useRef(0);
    const clipboardHintTimerRef = useRef(null);

    const fetchViewerStatus = useCallback(async () => {
        const token = localStorage.getItem('token');
        if (!token) return null;
        try {
            const r = await fetch(`${apiBase()}/api/wa-viewer/status`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!r.ok) return null;
            return await r.json();
        } catch { return null; }
    }, []);

    useEffect(() => {
        if (!sellerId || !screenRef.current) return;
        const token = localStorage.getItem('token');
        if (!token) {
            setStatus('error');
            setErrorMsg('No hay sesión activa');
            return;
        }

        let cancelled = false;
        let rfb = null;

        const connect = async () => {
            attemptRef.current += 1;
            // Pre-flight: if this seller isn't already headful AND we're at
            // capacity, don't waste a WS upgrade — poll until a slot frees.
            const pre = await fetchViewerStatus();
            if (cancelled) return;
            if (pre) {
                setViewerStatus(pre);
                const alreadyHeadful = pre.activeSellers?.some(s => s.sellerId === sellerId);
                if (!alreadyHeadful && pre.atCapacity) {
                    setStatus('queued');
                    setErrorMsg(null);
                    scheduleRetry();
                    return;
                }
            }

            setStatus('connecting');
            setErrorMsg(null);

            const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const url = `${proto}://${window.location.host}/vnc-ws/${encodeURIComponent(sellerId)}?token=${encodeURIComponent(token)}`;

            try {
                rfb = new RFB(screenRef.current, url, { credentials: {} });
                rfb.viewOnly = false;
                rfb.resizeSession = true;
                rfb.scaleViewport = true;
                rfb.background = '#0f172a';
                // Tuned for ~150-200ms RTT (Railway US ↔ AR): lower JPEG quality
                // and higher compression cuts bytes per frame ~60%. Text in the
                // chat still renders crisp (Tight's sub-rectangle encoding is
                // lossless for flat-colour regions); only photos/avatars degrade.
                rfb.qualityLevel = 3;
                rfb.compressionLevel = 6;
                rfb.showDotCursor = false;

                rfb.addEventListener('connect', () => { if (!cancelled) setStatus('connected'); });
                rfb.addEventListener('disconnect', async (e) => {
                    if (cancelled) return;
                    // If the WS closed before we ever reached RFB handshake, it
                    // may be because the backend rejected us with 503 (queue full).
                    // Re-check status; if at capacity, flip to queued and poll.
                    const s = await fetchViewerStatus();
                    if (cancelled) return;
                    if (s) setViewerStatus(s);
                    const alreadyHeadful = s?.activeSellers?.some(sv => sv.sellerId === sellerId);
                    if (s && !alreadyHeadful && s.atCapacity) {
                        setStatus('queued');
                        setErrorMsg(null);
                        scheduleRetry();
                        return;
                    }
                    setStatus('disconnected');
                    if (e?.detail?.clean === false) setErrorMsg('Conexión cerrada inesperadamente');
                });
                rfb.addEventListener('securityfailure', (e) => {
                    if (cancelled) return;
                    setStatus('error');
                    setErrorMsg(e?.detail?.reason || 'Falla de seguridad');
                });
                // Remote → local clipboard: when someone copies text inside the
                // bot's Chromium, x11vnc forwards it and noVNC fires 'clipboard'.
                // Writing to navigator.clipboard needs a user gesture the first
                // time; subsequent writes in the same page session succeed.
                rfb.addEventListener('clipboard', async (e) => {
                    const text = e?.detail?.text;
                    if (!text) return;
                    try {
                        await navigator.clipboard.writeText(text);
                    } catch (_) { /* no permission / not focused — drop silently */ }
                });
                rfbRef.current = rfb;
            } catch (e) {
                setStatus('error');
                setErrorMsg(e.message || 'Error iniciando noVNC');
            }
        };

        const scheduleRetry = () => {
            if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
            pollTimerRef.current = setTimeout(async () => {
                const s = await fetchViewerStatus();
                if (cancelled) return;
                if (s) setViewerStatus(s);
                const alreadyHeadful = s?.activeSellers?.some(sv => sv.sellerId === sellerId);
                if (s && (!s.atCapacity || alreadyHeadful)) {
                    connect();
                } else {
                    scheduleRetry();
                }
            }, 3000);
        };

        connect();

        return () => {
            cancelled = true;
            if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null; }
            try { rfb?.disconnect(); } catch (_) { /* ignore */ }
            try { rfbRef.current?.disconnect(); } catch (_) { /* ignore */ }
            rfbRef.current = null;
        };
    }, [sellerId, fetchViewerStatus]);

    const openInNewTab = () => {
        if (!sellerId) return;
        window.open(`/wa-web?sellerId=${encodeURIComponent(sellerId)}`, '_blank', 'noopener');
    };

    // Re-nudge noVNC to recompute scaling / remote resize whenever the
    // container changes size (window resize, sidebar toggle, fullscreen, etc).
    // Setting scaleViewport again forces noVNC's internal _updateScale() and,
    // when resizeSession is on, sends a new ExtendedDesktopSize to Xvfb.
    useEffect(() => {
        const el = screenRef.current;
        if (!el) return;
        let raf = 0;
        const nudge = () => {
            const rfb = rfbRef.current;
            if (!rfb) return;
            // Toggling + re-setting is the public way to force a re-layout.
            try {
                rfb.scaleViewport = false;
                rfb.scaleViewport = true;
            } catch (_) { /* ignore */ }
        };
        const ro = new ResizeObserver(() => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(nudge);
        });
        ro.observe(el);
        return () => { ro.disconnect(); cancelAnimationFrame(raf); };
    }, []);

    // Keep isFullscreen in sync with document.fullscreenElement (ESC toggles it).
    useEffect(() => {
        const onChange = () => setIsFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
    }, []);

    const toggleFullscreen = useCallback(async () => {
        const el = containerRef.current;
        if (!el) return;
        try {
            if (!document.fullscreenElement) {
                await el.requestFullscreen();
            } else {
                await document.exitFullscreen();
            }
        } catch (_) { /* user denied or unsupported */ }
    }, []);

    const showClipboardHint = useCallback((kind, msg) => {
        setClipboardHint({ kind, msg });
        if (clipboardHintTimerRef.current) clearTimeout(clipboardHintTimerRef.current);
        clipboardHintTimerRef.current = setTimeout(() => setClipboardHint(null), 2500);
    }, []);

    // Sync: push local clipboard text to the remote clipboard. Also primes
    // the browser's clipboard-read permission so the auto-copy path
    // (clipboard event → navigator.clipboard.writeText) can succeed later.
    const syncClipboard = useCallback(async () => {
        const rfb = rfbRef.current;
        if (!rfb) { showClipboardHint('error', 'Viewer no conectado'); return; }
        try {
            const text = await navigator.clipboard.readText();
            if (!text) { showClipboardHint('info', 'Portapapeles vacío'); return; }
            rfb.clipboardPasteFrom(text);
            showClipboardHint('success', 'Portapapeles sincronizado');
        } catch (_) {
            showClipboardHint('error', 'Sin permiso de portapapeles');
        }
    }, [showClipboardHint]);

    // Send a Ctrl+<keysym> key combo to the remote Chromium. Correct order:
    // Ctrl down → key down → key up → Ctrl up.
    const sendCtrlCombo = useCallback((keysym, code) => {
        const rfb = rfbRef.current;
        if (!rfb) return false;
        try {
            // Focus the canvas first so the remote actually receives the keys.
            screenRef.current?.querySelector('canvas')?.focus();
            rfb.sendKey(0xffe3, 'ControlLeft', true);
            rfb.sendKey(keysym, code, true);
            rfb.sendKey(keysym, code, false);
            rfb.sendKey(0xffe3, 'ControlLeft', false);
            return true;
        } catch (_) { return false; }
    }, []);

    // Force Ctrl+C in the remote. User must have text selected in Chromium
    // first. x11vnc will forward the resulting clipboard change back to us
    // via the 'clipboard' event, which then writes to navigator.clipboard.
    const forceCopy = useCallback(() => {
        const rfb = rfbRef.current;
        if (!rfb) { showClipboardHint('error', 'Viewer no conectado'); return; }
        if (sendCtrlCombo(0x0063, 'KeyC')) {
            showClipboardHint('success', 'Ctrl+C enviado al chat');
        } else {
            showClipboardHint('error', 'No se pudo enviar Ctrl+C');
        }
    }, [sendCtrlCombo, showClipboardHint]);

    // Force Ctrl+V in the remote. Syncs the local clipboard to the remote
    // first so whatever the user has copied on their PC ends up pasted into
    // the focused WhatsApp input.
    const forcePaste = useCallback(async () => {
        const rfb = rfbRef.current;
        if (!rfb) { showClipboardHint('error', 'Viewer no conectado'); return; }
        try {
            const text = await navigator.clipboard.readText();
            if (text) rfb.clipboardPasteFrom(text);
        } catch (_) { /* permission not granted — paste what remote already has */ }
        // Short delay so x11vnc absorbs the clipboard update before Ctrl+V
        // fires (otherwise Chromium pastes the previous remote clipboard).
        await new Promise(r => setTimeout(r, 80));
        if (sendCtrlCombo(0x0076, 'KeyV')) {
            showClipboardHint('success', 'Pegado en el chat');
        } else {
            showClipboardHint('error', 'No se pudo enviar Ctrl+V');
        }
    }, [sendCtrlCombo, showClipboardHint]);

    // Clipboard panel is the primary path — no flaky auto-sync. Users paste
    // into the textarea, click "Copiar al chat", then Ctrl+V in WhatsApp.

    useEffect(() => () => {
        if (clipboardHintTimerRef.current) clearTimeout(clipboardHintTimerRef.current);
    }, []);

    if (!user?.canViewWaWeb) {
        return (
            <div className="p-8 flex flex-col items-center justify-center text-slate-500">
                <AlertTriangle className="w-10 h-10 mb-3 text-amber-500" />
                <p className="font-semibold">No tenés permisos para ver WhatsApp Web.</p>
            </div>
        );
    }

    if (!sellerId) {
        return (
            <div className="p-8 text-center text-slate-500">
                <p>Seleccioná un vendedor para ver su WhatsApp Web.</p>
            </div>
        );
    }

    // Standalone mode: no chrome at all — VNC canvas fills the viewport, status
    // shows as a tiny floating chip only while not yet connected.
    if (standalone) {
        return (
            <div ref={containerRef} className="w-screen h-screen bg-black relative overflow-hidden">
                <div ref={screenRef} className="absolute inset-0" />
                <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
                    <button
                        onClick={forceCopy}
                        title="Copiar (envía Ctrl+C al chat)"
                        className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-slate-900/80 hover:bg-slate-800 text-slate-200 shadow-lg backdrop-blur"
                    >
                        <Copy className="w-4 h-4" />
                    </button>
                    <button
                        onClick={forcePaste}
                        title="Pegar (envía Ctrl+V al chat)"
                        className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-slate-900/80 hover:bg-slate-800 text-slate-200 shadow-lg backdrop-blur"
                    >
                        <ClipboardPaste className="w-4 h-4" />
                    </button>
                    <button
                        onClick={syncClipboard}
                        title="Sincronizar portapapeles (PC → chat)"
                        className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-slate-900/80 hover:bg-slate-800 text-slate-200 shadow-lg backdrop-blur"
                    >
                        <Clipboard className="w-4 h-4" />
                    </button>
                    <button
                        onClick={toggleFullscreen}
                        title={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
                        className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-slate-900/80 hover:bg-slate-800 text-slate-200 shadow-lg backdrop-blur"
                    >
                        {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                    </button>
                </div>
                {clipboardHint && (
                    <div className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-10 px-4 py-2 rounded-full text-sm font-semibold shadow-lg backdrop-blur ${
                        clipboardHint.kind === 'success' ? 'bg-emerald-500/90 text-white' :
                        clipboardHint.kind === 'error' ? 'bg-rose-500/90 text-white' :
                        'bg-slate-700/90 text-white'
                    }`}>
                        {clipboardHint.msg}
                    </div>
                )}
                {status === 'queued' && (
                    <QueueOverlay sellerId={sellerId} viewerStatus={viewerStatus} fullscreen />
                )}
                {status !== 'connected' && status !== 'queued' && (
                    <div className={`absolute top-3 left-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold shadow-lg backdrop-blur ${
                        status === 'error' ? 'bg-rose-500/90 text-white' : 'bg-amber-500/90 text-white'
                    }`}>
                        <WifiOff className="w-3 h-3" />
                        {status === 'error' ? `Error: ${errorMsg || 'desconocido'}` :
                         status === 'disconnected' ? 'Desconectado' : 'Conectando (puede tardar ~30s)...'}
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className="p-4 md:p-6 w-full h-full flex flex-col">
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                    <h2 className="font-bold text-lg md:text-xl text-slate-800 dark:text-slate-100">
                        WhatsApp Web — <span className="text-indigo-500">{sellerId}</span>
                    </h2>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                        status === 'connected' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
                        status === 'error' ? 'bg-rose-50 text-rose-700 border border-rose-200' :
                        status === 'queued' ? 'bg-indigo-50 text-indigo-700 border border-indigo-200' :
                        'bg-amber-50 text-amber-700 border border-amber-200'
                    }`}>
                        {status === 'connected' ? <Wifi className="w-3 h-3" /> :
                         status === 'queued' ? <Clock className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                        {status === 'connected' ? 'En vivo' :
                         status === 'error' ? `Error: ${errorMsg || 'desconocido'}` :
                         status === 'disconnected' ? 'Desconectado' :
                         status === 'queued' ? 'En cola' : 'Conectando...'}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={forceCopy}
                        title="Copiar lo seleccionado en el chat (envía Ctrl+C)"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
                    >
                        <Copy className="w-3.5 h-3.5" />
                        Copiar
                    </button>
                    <button
                        onClick={forcePaste}
                        title="Pegar en el chat (envía Ctrl+V)"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm"
                    >
                        <ClipboardPaste className="w-3.5 h-3.5" />
                        Pegar
                    </button>
                    <button
                        onClick={syncClipboard}
                        title="Sincronizar portapapeles (PC → chat)"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-700 hover:bg-slate-600 text-white shadow-sm"
                    >
                        <Clipboard className="w-3.5 h-3.5" />
                        Sincronizar
                    </button>
                    <button
                        onClick={toggleFullscreen}
                        title={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-white shadow-sm"
                    >
                        {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                        {isFullscreen ? 'Salir' : 'Pantalla completa'}
                    </button>
                    <button
                        onClick={openInNewTab}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-600 hover:bg-slate-700 text-white shadow-sm"
                    >
                        <ExternalLink className="w-3.5 h-3.5" />
                        Pestaña nueva
                    </button>
                </div>
            </div>
            <div className="mb-3 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <div>
                    Estás controlando la sesión real del bot. Cualquier mensaje que envíes sale por WhatsApp de este vendedor y
                    <strong> no pasa por el flujo del bot</strong>. Usalo solo para intervenciones puntuales.
                </div>
            </div>
            <div ref={containerRef} className="flex-1 relative bg-slate-900 rounded-xl overflow-hidden">
                <div ref={screenRef} className="absolute inset-0" />
                {status === 'queued' && (
                    <QueueOverlay sellerId={sellerId} viewerStatus={viewerStatus} />
                )}
                {clipboardHint && (
                    <div className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-10 px-4 py-2 rounded-full text-sm font-semibold shadow-lg backdrop-blur ${
                        clipboardHint.kind === 'success' ? 'bg-emerald-500/90 text-white' :
                        clipboardHint.kind === 'error' ? 'bg-rose-500/90 text-white' :
                        'bg-slate-700/90 text-white'
                    }`}>
                        {clipboardHint.msg}
                    </div>
                )}
            </div>
        </div>
    );
}

function QueueOverlay({ sellerId, viewerStatus, fullscreen = false }) {
    const active = viewerStatus?.activeSellers || [];
    const max = viewerStatus?.max || 3;
    const headfulCount = viewerStatus?.headfulCount ?? active.length;
    const wrapCls = fullscreen
        ? 'absolute inset-0 flex items-center justify-center bg-slate-900/95 backdrop-blur'
        : 'absolute inset-0 flex items-center justify-center bg-slate-900/90 backdrop-blur rounded-xl';

    return (
        <div className={wrapCls}>
            <div className="max-w-md w-full mx-4 bg-slate-800 border border-slate-700 rounded-xl p-6 shadow-2xl">
                <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 rounded-full bg-indigo-500/20 flex items-center justify-center">
                        <Clock className="w-5 h-5 text-indigo-300 animate-pulse" />
                    </div>
                    <div>
                        <h3 className="font-bold text-slate-100">En cola de espera</h3>
                        <p className="text-xs text-slate-400">
                            Máximo {max} sesiones abiertas a la vez. Ahora hay {headfulCount}.
                        </p>
                    </div>
                </div>
                <p className="text-sm text-slate-300 mb-3">
                    Te conectaremos automáticamente cuando alguien se desconecte.
                </p>
                <div className="border border-slate-700 rounded-lg bg-slate-900/50">
                    <div className="px-3 py-2 border-b border-slate-700 flex items-center gap-2 text-xs font-semibold text-slate-400 uppercase tracking-wide">
                        <Users className="w-3.5 h-3.5" />
                        Sesiones activas ({headfulCount}/{max})
                    </div>
                    <div className="p-2 space-y-1 max-h-48 overflow-y-auto">
                        {active.length === 0 && (
                            <div className="text-xs text-slate-500 text-center py-3">Sin sesiones activas</div>
                        )}
                        {active.map(s => (
                            <div key={s.sellerId} className="flex items-center justify-between px-2 py-1.5 rounded bg-slate-800/60 text-xs">
                                <span className="font-mono text-indigo-300">{s.sellerId}</span>
                                <span className="text-slate-400">
                                    {s.viewers.length === 0
                                        ? 'sin viewers'
                                        : s.viewers.map(v => `${v.accountName} (${timeAgo(v.since)})`).join(', ')}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
                <p className="mt-3 text-[11px] text-slate-500 text-center">
                    Revisando cada 3 segundos…
                </p>
            </div>
        </div>
    );
}
