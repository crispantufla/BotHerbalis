import { useCallback, useEffect, useState } from 'react';
import { Hourglass, MessageCircle, Reply, RefreshCw, CheckCircle2 } from 'lucide-react';
import api from '../../../config/axios';
import { useToast } from '../../ui/Toast';
import { Card, Button, IconButton } from '../../ui';

// Cuántos se ven sin tocar "Ver todos": la bandeja es para actuar, no para leer.
const VISIBLE = 5;

const digits = (id) => String(id || '').replace(/@.*/, '');

// "hace 12 min", "hace 3 h", "hace 2 días": cuánto lleva esperando el cliente.
function waitingFor(since, now) {
    const mins = Math.max(0, Math.floor((now - since) / 60000));
    if (mins < 1) return 'recién';
    if (mins < 60) return `hace ${mins} min`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `hace ${hrs} h`;
    const days = Math.floor(hrs / 24);
    return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
}

/**
 * Bandeja "Te esperan": chats pausados donde el último en hablar fue el
 * cliente. Una pausa no se libera sola, así que sin esta lista esos clientes
 * quedan sin respuesta hasta que alguien abra el chat por casualidad.
 *
 * "Retomar" = que conteste el bot (despausa y responde lo pendiente).
 * "Abrir chat" = contestar a mano.
 */
export default function WaitingPanel({ onOpenChat }) {
    const { toast, confirm } = useToast();
    const [chats, setChats] = useState([]);
    const [total, setTotal] = useState(0);
    const [state, setState] = useState('loading'); // loading | ready | error
    const [refreshing, setRefreshing] = useState(false);
    const [busy, setBusy] = useState({});
    const [showAll, setShowAll] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    const load = useCallback(async (manual = false) => {
        if (manual) setRefreshing(true);
        try {
            const res = await api.get('/api/waiting-chats');
            setChats(res.data?.chats || []);
            setTotal(res.data?.total || 0);
            setNow(Date.now());
            setState('ready');
        } catch {
            // Con datos ya en pantalla, un refresco fallido no los borra.
            setState((prev) => (prev === 'ready' ? 'ready' : 'error'));
            if (manual) toast.error('No pude actualizar la lista. Probá de nuevo en un momento.');
        } finally {
            if (manual) setRefreshing(false);
        }
    }, [toast]);

    useEffect(() => {
        load();
        // Con la pestaña oculta no se pide nada; al volver, se pone al día.
        const refresh = () => { if (document.visibilityState === 'visible') load(); };
        const id = setInterval(refresh, 60_000);
        document.addEventListener('visibilitychange', refresh);
        return () => { clearInterval(id); document.removeEventListener('visibilitychange', refresh); };
    }, [load]);

    const handleResume = async (chat) => {
        const who = chat.name || `+${digits(chat.id)}`;
        const ok = await confirm(`¿Que el bot le conteste a ${who}? Se despausa el chat y responde lo que quedó pendiente.`);
        if (!ok) return;
        setBusy((prev) => ({ ...prev, [chat.id]: true }));
        try {
            await api.post('/api/resume-chat', { chatId: chat.id });
            setChats((prev) => prev.filter((c) => c.id !== chat.id));
            setTotal((prev) => Math.max(0, prev - 1));
            toast.success(`El bot retomó la charla con ${who}.`);
        } catch (e) {
            toast.error(e.response?.data?.error || 'No se pudo retomar el chat. Abrilo y contestá a mano.');
        } finally {
            setBusy((prev) => ({ ...prev, [chat.id]: false }));
        }
    };

    const shown = showAll ? chats : chats.slice(0, VISIBLE);
    const hidden = chats.length - shown.length;

    return (
        <Card padding="none" as="section" aria-labelledby="waiting-title">
            <div className="flex items-center gap-3 px-4 sm:px-5 py-4 border-b border-slate-100 dark:border-slate-800">
                <div className="w-10 h-10 rounded-card bg-warning-50 dark:bg-warning-900/30 text-warning-700 dark:text-warning-400 flex items-center justify-center flex-shrink-0">
                    <Hourglass className="w-5 h-5" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                    <h2 id="waiting-title" className="font-semibold text-slate-900 dark:text-slate-100 text-base leading-tight">
                        Te esperan
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5" aria-live="polite">
                        {state === 'loading' && 'Buscando chats sin responder…'}
                        {state === 'error' && 'No se pudo cargar la lista.'}
                        {state === 'ready' && (total === 0
                            ? 'Nadie quedó sin respuesta.'
                            : `${total} ${total === 1 ? 'cliente escribió' : 'clientes escribieron'} y el bot está pausado en su chat.`)}
                    </p>
                </div>
                <IconButton label="Actualizar la lista" size="sm" variant="ghost" onClick={() => load(true)} disabled={refreshing}>
                    <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
                </IconButton>
            </div>

            {state === 'loading' && (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800" aria-hidden="true">
                    {[0, 1, 2].map((i) => (
                        <li key={i} className="px-4 sm:px-5 py-4">
                            <div className="h-3.5 w-40 rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
                            <div className="h-3 w-full max-w-md rounded bg-slate-100 dark:bg-slate-800 animate-pulse mt-3" />
                        </li>
                    ))}
                </ul>
            )}

            {state === 'error' && (
                <div className="px-4 sm:px-5 py-6 flex flex-wrap items-center gap-3">
                    <p className="text-sm text-slate-600 dark:text-slate-300 flex-1 min-w-[12rem]">
                        No pude traer los chats sin responder. Revisá la conexión y probá de nuevo.
                    </p>
                    <Button variant="secondary" size="sm" className="max-md:h-10" onClick={() => load(true)} loading={refreshing}>
                        Reintentar
                    </Button>
                </div>
            )}

            {state === 'ready' && total === 0 && (
                <div className="px-4 sm:px-5 py-6 flex items-center gap-3 text-sm text-slate-600 dark:text-slate-300">
                    <CheckCircle2 className="w-5 h-5 text-success-600 dark:text-success-500 flex-shrink-0" aria-hidden="true" />
                    <p>Todos los chats pausados tienen respuesta. Cuando un cliente escriba en un chat pausado, aparece acá.</p>
                </div>
            )}

            {state === 'ready' && shown.length > 0 && (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                    {shown.map((chat) => {
                        const phone = `+${digits(chat.id)}`;
                        return (
                            <li key={chat.id} className="px-4 sm:px-5 py-4 flex flex-col md:flex-row md:items-start gap-3">
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                        <span className="font-semibold text-sm text-slate-900 dark:text-slate-100 truncate max-w-full">
                                            {chat.name || phone}
                                        </span>
                                        {chat.name && (
                                            <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">{phone}</span>
                                        )}
                                        <span className="text-xs font-medium text-warning-700 dark:text-warning-400 whitespace-nowrap">
                                            Espera {waitingFor(chat.waitingSince, now)}
                                        </span>
                                    </div>
                                    <p className="text-sm text-slate-700 dark:text-slate-300 mt-1.5 leading-snug line-clamp-2 break-words">
                                        {chat.lastMessage}
                                    </p>
                                    {chat.pauseReason && (
                                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 truncate" title={chat.pauseReason}>
                                            Pausado: {chat.pauseReason}
                                        </p>
                                    )}
                                </div>
                                <div className="flex gap-2 flex-shrink-0">
                                    <Button
                                        variant="primary"
                                        size="sm"
                                        className="max-md:h-10 max-md:flex-1"
                                        leftIcon={Reply}
                                        loading={!!busy[chat.id]}
                                        onClick={() => handleResume(chat)}
                                    >
                                        Retomar
                                    </Button>
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        className="max-md:h-10 max-md:flex-1"
                                        leftIcon={MessageCircle}
                                        onClick={() => onOpenChat(chat.id)}
                                    >
                                        Abrir chat
                                    </Button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            {state === 'ready' && (hidden > 0 || (showAll && chats.length > VISIBLE) || total > chats.length) && (
                <div className="px-4 sm:px-5 py-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                    {chats.length > VISIBLE && (
                        <Button variant="ghost" size="sm" className="max-md:h-10" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                            {showAll ? 'Ver menos' : `Ver los ${chats.length}`}
                        </Button>
                    )}
                    {total > chats.length && (
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                            Se muestran los {chats.length} más recientes de {total}.
                        </p>
                    )}
                </div>
            )}
        </Card>
    );
}
