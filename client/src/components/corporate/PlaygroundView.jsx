import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Send, RotateCcw, Loader2, Clock, ZapOff, ChevronRight, FlaskConical, AlertTriangle } from 'lucide-react';
import api from '../../config/axios';
import { Card, Button, IconButton, Badge, useToast } from '../ui';
import AiCorrectionModal from './components/AiCorrectionModal';

// Steps del flow real (orden cosmético para el dropdown "Forzar step").
const FORCE_STEPS = [
    'greeting',
    'waiting_weight',
    'waiting_preference',
    'waiting_payment_method',
    'waiting_mp_payment',
    'waiting_transfer_confirmation',
    'waiting_data',
    'waiting_maps_confirmation',
    'waiting_final_confirmation',
    'waiting_admin_validation',
    'completed',
];

/**
 * PlaygroundView — Sandbox para chatear con el bot real desde el dashboard.
 *
 * - Sesión efímera (en memoria del backend, TTL 1h).
 * - Usa processSalesFlow real con sellerId='playground' (funnelLogger skipea).
 * - Panel lateral con state actualizado tras cada mensaje (step, weightGoal,
 *   selectedProduct, selectedPlan, totalPrice, paymentMethod, cart).
 * - Toggle delay humanizado (4-8s como el bot real) vs respuesta inmediata.
 * - Dropdown "Forzar step" para saltar a una parte del flow sin pasar por todo.
 */
const PlaygroundView = () => {
    const { toast } = useToast();
    const [sessionId, setSessionId] = useState(null);
    const [messages, setMessages] = useState([]); // {role: 'user'|'bot', content, timestamp}
    const [state, setState] = useState(null);
    const [input, setInput] = useState('');
    const [sending, setSending] = useState(false);
    const [useDelay, setUseDelay] = useState(false);
    const [forceStep, setForceStep] = useState('');
    // Índice del mensaje del bot que el usuario quiere reportar como error de IA.
    // null = modal cerrado.
    const [reportingIdx, setReportingIdx] = useState(null);
    const messagesEndRef = useRef(null);

    // Generar una sesión nueva al montar.
    const startNewSession = useCallback(async () => {
        try {
            const res = await api.post('/api/playground/new-session');
            setSessionId(res.data.sessionId);
            setMessages([]);
            setState(null);
            setForceStep('');
        } catch (e) {
            toast.error('No se pudo iniciar la sesión: ' + (e.response?.data?.error || e.message));
        }
    }, [toast]);

    useEffect(() => { startNewSession(); }, [startNewSession]);

    // Auto-scroll al final cuando entran mensajes.
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const handleSend = async () => {
        if (!input.trim() || !sessionId || sending) return;
        const userMsg = { role: 'user', content: input.trim(), timestamp: Date.now() };
        setMessages(prev => [...prev, userMsg]);
        setInput('');
        setSending(true);

        try {
            const res = await api.post('/api/playground/message', {
                sessionId,
                message: userMsg.content,
                useDelay,
            });
            const replies = res.data.replies || [];
            setMessages(prev => [...prev, ...replies]);
            setState(res.data.state);
        } catch (e) {
            toast.error('Error: ' + (e.response?.data?.error || e.message));
        } finally {
            setSending(false);
        }
    };

    const handleReset = async () => {
        if (!sessionId) return;
        try {
            await api.post('/api/playground/reset', { sessionId });
            await startNewSession();
            toast.success('Conversación reseteada');
        } catch (e) {
            toast.error('Error al resetear');
        }
    };

    const handleForceStep = async () => {
        if (!sessionId || !forceStep) return;
        try {
            const res = await api.post('/api/playground/force-step', { sessionId, step: forceStep });
            setState(res.data.state);
            setMessages(prev => [...prev, {
                role: 'system',
                content: `[Step forzado a "${forceStep}"]`,
                timestamp: Date.now()
            }]);
            toast.success(`Saltado a ${forceStep}`);
        } catch (e) {
            toast.error('Error al forzar step: ' + (e.response?.data?.error || e.message));
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="max-w-7xl mx-auto w-full p-4 md:p-6 space-y-4">
            {/* Header */}
            <header className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-display text-slate-900 dark:text-slate-100 flex items-center gap-2">
                        <FlaskConical className="w-6 h-6 text-accent-600 dark:text-accent-400" />
                        Probar bot
                    </h1>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        Chateá con el bot real (mismo flow que producción). La sesión es efímera — no genera pedidos, FunnelEvents ni mensajes a WhatsApp.
                    </p>
                </div>
            </header>

            {/* Controles globales */}
            <Card padding="md">
                <div className="flex flex-wrap items-center gap-3">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleReset}
                        disabled={!sessionId}
                        title="Borra el state y arranca una conversación de cero"
                    >
                        <RotateCcw className="w-4 h-4 mr-1" />
                        Reset
                    </Button>

                    <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-400 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={useDelay}
                            onChange={(e) => setUseDelay(e.target.checked)}
                            className="rounded text-accent-600 focus:ring-accent-500 cursor-pointer"
                        />
                        {useDelay
                            ? <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> Delay humanizado (4-8s)</span>
                            : <span className="flex items-center gap-1"><ZapOff className="w-3 h-3" /> Respuesta inmediata</span>}
                    </label>

                    <div className="flex items-center gap-2 ml-auto">
                        <select
                            value={forceStep}
                            onChange={(e) => setForceStep(e.target.value)}
                            className="text-xs px-2 h-8 rounded-control bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-2 focus:ring-accent-500"
                        >
                            <option value="">Forzar step...</option>
                            {FORCE_STEPS.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleForceStep}
                            disabled={!forceStep || !sessionId}
                        >
                            Saltar
                            <ChevronRight className="w-4 h-4 ml-1" />
                        </Button>
                    </div>

                    {sessionId && (
                        <div className="text-[10px] text-slate-400 dark:text-slate-500 font-mono w-full md:w-auto">
                            Session: {sessionId.slice(0, 8)}…
                        </div>
                    )}
                </div>
            </Card>

            {/* Chat + State panel */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 min-h-[60vh]">
                {/* Chat */}
                <Card padding="none" className="flex flex-col min-h-[60vh] max-h-[80vh]">
                    <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/50 dark:bg-slate-900/40">
                        {messages.length === 0 && (
                            <div className="h-full flex items-center justify-center text-center text-sm text-slate-400 dark:text-slate-500 px-8">
                                <div>
                                    <FlaskConical className="w-10 h-10 mx-auto mb-3 opacity-30" />
                                    <p>Escribí un mensaje para arrancar.</p>
                                    <p className="text-xs mt-1">Ej: "Hola, quiero bajar 8 kilos"</p>
                                </div>
                            </div>
                        )}
                        {messages.map((m, idx) => (
                            <MessageBubble
                                key={idx}
                                message={m}
                                onReport={m.role === 'bot' ? () => setReportingIdx(idx) : null}
                            />
                        ))}
                        {sending && (
                            <div className="flex items-center gap-2 text-xs text-slate-400 px-3">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                {useDelay ? 'El bot está pensando…' : 'Procesando…'}
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Input */}
                    <div className="border-t border-slate-200 dark:border-slate-700 p-3 bg-white dark:bg-slate-800">
                        <div className="flex gap-2">
                            <textarea
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Escribí un mensaje… (Enter para enviar, Shift+Enter para nueva línea)"
                                rows={2}
                                disabled={sending || !sessionId}
                                className="flex-1 resize-none px-3 py-2 text-sm rounded-control bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-accent-500 disabled:opacity-50"
                            />
                            <Button
                                onClick={handleSend}
                                disabled={!input.trim() || sending || !sessionId}
                                className="self-end"
                            >
                                {sending
                                    ? <Loader2 className="w-4 h-4 animate-spin" />
                                    : <Send className="w-4 h-4" />}
                            </Button>
                        </div>
                    </div>
                </Card>

                {/* State Panel */}
                <StatePanel state={state} />
            </div>

            {/* Modal de reporte de error de IA — reusa el mismo de CommsView.
                Adaptamos los mensajes del playground ({role, content}) al formato
                que espera el modal ({id, body, fromMe}). El reporte va a la misma
                tabla AiErrorReport con userPhone='playground_<sessionId>' para
                identificarlo en la sección "Errores de IA". */}
            <AiCorrectionModal
                isOpen={reportingIdx !== null}
                onClose={() => setReportingIdx(null)}
                messages={messages.map((m, i) => ({
                    id: i,
                    body: m.content,
                    fromMe: m.role === 'bot',
                }))}
                reportedMsgId={reportingIdx}
                selectedChat={{ id: `playground_${sessionId || 'unknown'}@c.us` }}
            />
        </div>
    );
};

// ─── MessageBubble ─────────────────────────────────────────────────────────
function MessageBubble({ message, onReport }) {
    if (message.role === 'system') {
        return (
            <div className="flex justify-center">
                <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded">
                    {message.content}
                </span>
            </div>
        );
    }
    const isUser = message.role === 'user';
    return (
        <div className={`group flex items-start gap-1.5 ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] px-3 py-2 rounded-lg whitespace-pre-wrap text-sm ${
                isUser
                    ? 'bg-accent-600 text-white rounded-br-sm'
                    : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-bl-sm'
            }`}>
                {message.content}
            </div>
            {/* Botón "reportar" solo sobre mensajes del bot, visible en hover.
                Manda al modal AiCorrectionModal que persiste en AiErrorReport y
                aparece en la sección "Errores de IA". */}
            {onReport && (
                <button
                    type="button"
                    onClick={onReport}
                    title="Reportar como error de IA"
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md text-amber-500 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-amber-400 self-center"
                >
                    <AlertTriangle className="w-3.5 h-3.5" />
                </button>
            )}
        </div>
    );
}

// ─── StatePanel ────────────────────────────────────────────────────────────
function StatePanel({ state }) {
    if (!state) {
        return (
            <Card padding="md" className="h-fit">
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200 mb-2">State del cliente</h3>
                <p className="text-xs text-slate-400 dark:text-slate-500">Mandá un mensaje para inicializar el state.</p>
            </Card>
        );
    }

    const fields = [
        { label: 'Step', value: state.step, mono: true },
        { label: 'Weight goal', value: state.weightGoal ? `${state.weightGoal} kg` : null },
        { label: 'Producto', value: state.selectedProduct },
        { label: 'Plan', value: state.selectedPlan ? `${state.selectedPlan} días` : null },
        { label: 'Total', value: state.totalPrice ? `$${state.totalPrice}` : null },
        { label: 'Método pago', value: state.paymentMethod },
        { label: 'Shipping', value: state.shippingChoice },
        { label: 'Script', value: state.assignedScript, mono: true },
    ];

    const addr = state.partialAddress || {};
    const hasAddr = !!(addr.nombre || addr.calle || addr.ciudad || addr.cp);

    return (
        <Card padding="md" className="h-fit space-y-3">
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                State del cliente
                {state.step && <Badge tone="info">{state.step}</Badge>}
            </h3>

            <div className="space-y-1.5">
                {fields.map(f => (
                    <div key={f.label} className="flex justify-between text-xs gap-2">
                        <span className="text-slate-500 dark:text-slate-400">{f.label}</span>
                        <span className={`text-slate-800 dark:text-slate-200 text-right ${f.mono ? 'font-mono' : 'font-medium'}`}>
                            {f.value || <span className="text-slate-300 dark:text-slate-600">—</span>}
                        </span>
                    </div>
                ))}
            </div>

            {hasAddr && (
                <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">Dirección parcial</p>
                    <div className="space-y-1 text-xs">
                        {addr.nombre && <div><span className="text-slate-500">Nombre:</span> <span className="text-slate-800 dark:text-slate-200">{addr.nombre}</span></div>}
                        {addr.calle && <div><span className="text-slate-500">Calle:</span> <span className="text-slate-800 dark:text-slate-200">{addr.calle}</span></div>}
                        {addr.ciudad && <div><span className="text-slate-500">Ciudad:</span> <span className="text-slate-800 dark:text-slate-200">{addr.ciudad}</span></div>}
                        {addr.cp && <div><span className="text-slate-500">CP:</span> <span className="text-slate-800 dark:text-slate-200">{addr.cp}</span></div>}
                        {addr.provincia && <div><span className="text-slate-500">Provincia:</span> <span className="text-slate-800 dark:text-slate-200">{addr.provincia}</span></div>}
                    </div>
                </div>
            )}

            {state.cart && state.cart.length > 0 && (
                <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">Cart</p>
                    <div className="space-y-1 text-xs">
                        {state.cart.map((item, i) => (
                            <div key={i} className="flex justify-between gap-2">
                                <span className="text-slate-800 dark:text-slate-200">{item.product} × {item.plan}d</span>
                                <span className="text-slate-500">${item.price}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {state.pauseReason && (
                <div className="pt-2 border-t border-slate-200 dark:border-slate-700">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-warning-600 dark:text-warning-400 mb-1">⏸️ Pausa</p>
                    <p className="text-xs text-slate-700 dark:text-slate-300">{state.pauseReason}</p>
                </div>
            )}
        </Card>
    );
}

export default PlaygroundView;
