import React, { useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc/lib/rfb.js';
import { useSeller } from '../../context/SellerContext';
import { useAuth } from '../../context/AuthContext';
import { AlertTriangle, Wifi, WifiOff, ExternalLink } from 'lucide-react';

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
    const [status, setStatus] = useState('connecting'); // connecting | connected | disconnected | error
    const [errorMsg, setErrorMsg] = useState(null);

    useEffect(() => {
        if (!sellerId || !screenRef.current) return;
        const token = localStorage.getItem('token');
        if (!token) {
            setStatus('error');
            setErrorMsg('No hay sesión activa');
            return;
        }

        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const url = `${proto}://${window.location.host}/vnc-ws/${encodeURIComponent(sellerId)}?token=${encodeURIComponent(token)}`;

        setStatus('connecting');
        setErrorMsg(null);

        let rfb;
        try {
            rfb = new RFB(screenRef.current, url, { credentials: {} });
            rfb.viewOnly = false;
            // Ask the server to resize its framebuffer to match our container
            // (requires Xvfb +extension RANDR and x11vnc -xrandr resize on the backend).
            // scaleViewport is kept as a fallback if resize isn't supported.
            rfb.resizeSession = true;
            rfb.scaleViewport = true;
            rfb.background = '#0f172a'; // slate-900 (matches container)
            rfb.qualityLevel = 6;
            rfb.compressionLevel = 2;

            rfb.addEventListener('connect', () => setStatus('connected'));
            rfb.addEventListener('disconnect', (e) => {
                setStatus('disconnected');
                if (e?.detail?.clean === false) setErrorMsg('Conexión cerrada inesperadamente');
            });
            rfb.addEventListener('securityfailure', (e) => {
                setStatus('error');
                setErrorMsg(e?.detail?.reason || 'Falla de seguridad');
            });
            rfbRef.current = rfb;
        } catch (e) {
            setStatus('error');
            setErrorMsg(e.message || 'Error iniciando noVNC');
            return;
        }

        return () => {
            try { rfb?.disconnect(); } catch (_) { /* ignore */ }
            rfbRef.current = null;
        };
    }, [sellerId]);

    const openInNewTab = () => {
        if (!sellerId) return;
        window.open(`/wa-web?sellerId=${encodeURIComponent(sellerId)}`, '_blank', 'noopener');
    };

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

    const wrapperClass = standalone
        ? 'w-screen h-screen flex flex-col bg-slate-950'
        : 'p-4 md:p-6 w-full h-full flex flex-col';

    const screenWrapperClass = standalone
        ? 'flex-1 bg-slate-900 overflow-hidden'
        : 'flex-1 bg-slate-900 rounded-xl overflow-hidden';

    return (
        <div className={wrapperClass}>
            <div className={`flex items-center justify-between ${standalone ? 'px-3 py-2 bg-slate-900 border-b border-slate-800' : 'mb-3'}`}>
                <div className="flex items-center gap-3">
                    <h2 className={`font-bold ${standalone ? 'text-sm text-slate-200' : 'text-lg md:text-xl text-slate-800 dark:text-slate-100'}`}>
                        WhatsApp Web — <span className="text-indigo-500">{sellerId}</span>
                    </h2>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                        status === 'connected' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
                        status === 'error' ? 'bg-rose-50 text-rose-700 border border-rose-200' :
                        'bg-amber-50 text-amber-700 border border-amber-200'
                    }`}>
                        {status === 'connected' ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                        {status === 'connected' ? 'En vivo' :
                         status === 'error' ? `Error: ${errorMsg || 'desconocido'}` :
                         status === 'disconnected' ? 'Desconectado' : 'Conectando...'}
                    </span>
                </div>
                {!standalone && (
                    <button
                        onClick={openInNewTab}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm"
                    >
                        <ExternalLink className="w-3.5 h-3.5" />
                        Abrir en pestaña nueva
                    </button>
                )}
            </div>
            {!standalone && (
                <div className="mb-3 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <div>
                        Estás controlando la sesión real del bot. Cualquier mensaje que envíes sale por WhatsApp de este vendedor y
                        <strong> no pasa por el flujo del bot</strong>. Usalo solo para intervenciones puntuales.
                    </div>
                </div>
            )}
            <div ref={screenRef} className={screenWrapperClass} />
        </div>
    );
}
