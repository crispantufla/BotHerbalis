import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useSocket } from '../../context/SocketContext';
import { useSeller } from '../../context/SellerContext';
import { useAuth } from '../../context/AuthContext';
import { AlertTriangle, Wifi, WifiOff } from 'lucide-react';

// Native viewport we ask Chromium to screencast at. The canvas renders at
// this resolution; the DOM element scales it down with CSS.
const VIEW_W = 1280;
const VIEW_H = 900;

const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

function modifiersFromEvent(e) {
    return (e.altKey ? MODIFIERS.alt : 0)
        | (e.ctrlKey ? MODIFIERS.ctrl : 0)
        | (e.metaKey ? MODIFIERS.meta : 0)
        | (e.shiftKey ? MODIFIERS.shift : 0);
}

// Keys that should dispatch as `char` events (printable) vs `keyDown` (navigation/control)
function isPrintable(key) {
    return key && key.length === 1;
}

export default function WhatsappViewerView() {
    const { socket } = useSocket();
    const { selectedSellerId } = useSeller();
    const { user } = useAuth();
    const sellerId = selectedSellerId || user?.sellerId || null;

    const canvasRef = useRef(null);
    const containerRef = useRef(null);
    const [status, setStatus] = useState('connecting'); // connecting | streaming | error
    const [errorCode, setErrorCode] = useState(null);
    const lastMoveRef = useRef(0);

    // Compute page coords from a mouse event on the scaled canvas
    const pageCoords = useCallback((e) => {
        const canvas = canvasRef.current;
        if (!canvas) return { x: 0, y: 0 };
        const rect = canvas.getBoundingClientRect();
        const scaleX = VIEW_W / rect.width;
        const scaleY = VIEW_H / rect.height;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY,
        };
    }, []);

    // Start/stop streaming
    useEffect(() => {
        if (!socket || !sellerId) return;
        setStatus('connecting');
        setErrorCode(null);

        const onFrame = ({ sellerId: sid, data }) => {
            if (sid !== sellerId) return;
            const canvas = canvasRef.current;
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            const img = new Image();
            img.onload = () => {
                if (canvas.width !== img.width) canvas.width = img.width;
                if (canvas.height !== img.height) canvas.height = img.height;
                ctx.drawImage(img, 0, 0);
                setStatus('streaming');
            };
            img.src = 'data:image/jpeg;base64,' + data;
        };

        const onStarted = ({ sellerId: sid }) => {
            if (sid === sellerId) setStatus('streaming');
        };
        const onError = ({ code }) => {
            setStatus('error');
            setErrorCode(code || 'unknown');
        };

        socket.on('wa_view:frame', onFrame);
        socket.on('wa_view:started', onStarted);
        socket.on('wa_view:error', onError);

        socket.emit('wa_view:start', { sellerId });

        return () => {
            socket.emit('wa_view:stop');
            socket.off('wa_view:frame', onFrame);
            socket.off('wa_view:started', onStarted);
            socket.off('wa_view:error', onError);
        };
    }, [socket, sellerId]);

    // --- Input handlers ---
    const sendInput = useCallback((event) => {
        if (!socket || !sellerId) return;
        socket.emit('wa_view:input', { sellerId, event });
    }, [socket, sellerId]);

    const onMouseDown = (e) => {
        e.preventDefault();
        const { x, y } = pageCoords(e);
        const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
        sendInput({ type: 'mousePressed', x, y, button, clickCount: 1, modifiers: modifiersFromEvent(e) });
        canvasRef.current?.focus();
    };
    const onMouseUp = (e) => {
        e.preventDefault();
        const { x, y } = pageCoords(e);
        const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left';
        sendInput({ type: 'mouseReleased', x, y, button, clickCount: 1, modifiers: modifiersFromEvent(e) });
    };
    const onMouseMove = (e) => {
        const now = performance.now();
        if (now - lastMoveRef.current < 33) return; // ~30Hz
        lastMoveRef.current = now;
        const { x, y } = pageCoords(e);
        sendInput({ type: 'mouseMoved', x, y, modifiers: modifiersFromEvent(e) });
    };
    const onWheel = (e) => {
        e.preventDefault();
        const { x, y } = pageCoords(e);
        sendInput({ type: 'mouseWheel', x, y, deltaX: -e.deltaX, deltaY: -e.deltaY, modifiers: modifiersFromEvent(e) });
    };
    const onContextMenu = (e) => e.preventDefault();

    const onKeyDown = (e) => {
        e.preventDefault();
        const mods = modifiersFromEvent(e);
        // Non-printable keys go as keyDown (Enter, Backspace, Arrow, Tab, Escape, etc.)
        if (!isPrintable(e.key)) {
            sendInput({ type: 'keyDown', key: e.key, code: e.code, modifiers: mods });
            return;
        }
        // Printable: send char so Chromium types the actual text
        sendInput({ type: 'char', text: e.key, key: e.key, code: e.code, modifiers: mods });
    };
    const onKeyUp = (e) => {
        e.preventDefault();
        if (isPrintable(e.key)) return; // char handled on keydown
        sendInput({ type: 'keyUp', key: e.key, code: e.code, modifiers: modifiersFromEvent(e) });
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

    return (
        <div className="p-4 md:p-6 w-full h-full flex flex-col">
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                    <h2 className="text-lg md:text-xl font-bold text-slate-800 dark:text-slate-100">WhatsApp Web — <span className="text-indigo-600">{sellerId}</span></h2>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${
                        status === 'streaming' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
                        status === 'error' ? 'bg-rose-50 text-rose-700 border border-rose-200' :
                        'bg-amber-50 text-amber-700 border border-amber-200'
                    }`}>
                        {status === 'streaming' ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                        {status === 'streaming' ? 'En vivo' : status === 'error' ? `Error: ${errorCode}` : 'Conectando...'}
                    </span>
                </div>
            </div>
            <div className="mb-3 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <div>
                    Estás controlando la sesión real del bot. Cualquier mensaje que envíes sale por WhatsApp de este vendedor y
                    <strong> no pasa por el flujo del bot</strong> (no queda registrado en el state machine). Usalo solo para intervenciones puntuales.
                </div>
            </div>
            <div ref={containerRef} className="flex-1 flex items-start justify-center bg-slate-900 rounded-xl overflow-auto p-2">
                <canvas
                    ref={canvasRef}
                    width={VIEW_W}
                    height={VIEW_H}
                    tabIndex={0}
                    className="max-w-full h-auto outline-none rounded-lg shadow-xl cursor-default"
                    style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}
                    onMouseDown={onMouseDown}
                    onMouseUp={onMouseUp}
                    onMouseMove={onMouseMove}
                    onWheel={onWheel}
                    onContextMenu={onContextMenu}
                    onKeyDown={onKeyDown}
                    onKeyUp={onKeyUp}
                />
            </div>
        </div>
    );
}
