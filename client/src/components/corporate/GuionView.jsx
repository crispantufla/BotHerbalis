import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../config/axios';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import {
    FileText,
    MessageSquare,
    Send,
    Trash2,
    Check,
    RotateCcw,
    AlertCircle,
    HelpCircle,
    Edit3,
    User,
    ChevronDown,
    ChevronRight,
    Sparkles,
    Copy,
    ThumbsUp,
    Plus,
    ArrowDown,
} from 'lucide-react';

const SCRIPT_LABELS = {
    v5: { name: 'V5 — Asesor consultivo', tone: 'Pregunta kilos primero, recomienda según objetivo', color: '#0284c7' },
};

const SECTION_LABELS = {
    'flow.greeting': 'Saludo inicial',
    'flow.recommendation': 'Recomendación (genérica)',
    'flow.recommendation_1': 'Recomendación tier 1 (hasta 10 kg)',
    'flow.recommendation_2': 'Recomendación tier 2 (10 a 20 kg)',
    'flow.recommendation_3': 'Recomendación tier 3 (más de 20 kg)',
    'flow.prices': 'TEXTO 3 — Precios del plan (60 vs 120)',
    'flow.preference_capsulas': 'Cliente elige cápsulas',
    'flow.preference_gotas': 'Cliente elige gotas',
    'flow.preference_semillas': 'Cliente elige semillas',
    'flow.closing': 'Cierre — pide datos de envío',
    'flow.payment_menu': 'TEXTO 4 — Menú de pago (3 opciones)',
    'flow.payment_transfer_alias': 'TEXTO 5b — Cliente elige Transferencia (alias)',
    'flow.payment_cod_retry': 'TEXTO 5c — Cliente elige Contra reembolso (explica modalidad)',
    'flow.payment_cod_anticipo': 'TEXTO 5d — Cliente confirma COD (alias para anticipo)',
    'flow.payment_mp_link': 'TEXTO 5a — Cliente elige Mercado Pago (link)',
    'flow.payment_mp_link_sena': 'Variante MP — link de seña (legacy)',
    'flow.payment_mp_failed': 'Mensaje cuando MP falla 2 veces',
    'flow.payment_mp_retry': 'Mensaje tras pago rechazado en MP',
    'flow.payment_mp_retry_sena': 'Variante retry MP (legacy seña)',
    'flow.transfer_received': 'Cliente avisó "listo" tras transferencia',
    'flow.cod_received': 'Cliente avisó "listo" tras anticipo COD',
    'flow.order_confirmation_mp': 'Confirmación final — pago MP completo',
    'flow.order_confirmation_transfer': 'Confirmación final — transferencia',
    'flow.order_confirmation_cod': 'Confirmación final — contra reembolso',
    'flow.order_confirmation_fallback': 'Confirmación final — fallback genérico',
};

// Path estable para comentarios entre dos pasos. Lo dejamos como string
// para reusar el mismo endpoint sin cambios en el backend.
const betweenPath = (prev, next) => `between:${prev}|${next}`;

const TYPE_META = {
    note: { label: 'Nota', icon: MessageSquare, color: 'bg-slate-100 text-slate-700' },
    correction: { label: 'Corrección', icon: Edit3, color: 'bg-amber-100 text-amber-800' },
    question: { label: 'Pregunta', icon: HelpCircle, color: 'bg-blue-100 text-blue-800' },
};

// Reemplaza placeholders {{X}} con valores ejemplo para que se vea como en producción.
// El runtime los sustituye dinámicamente en `_formatMessage` (src/flows/utils/messages.ts);
// acá usamos valores de ejemplo plausibles para que admins vean cómo queda el mensaje.
const PLACEHOLDER_VALUES = {
    // Precios por producto + plan
    PRICE_CAPSULAS_60: '46.900',
    PRICE_CAPSULAS_120: '66.900',
    PRICE_SEMILLAS_60: '36.900',
    PRICE_SEMILLAS_120: '49.900',
    PRICE_GOTAS_60: '48.900',
    PRICE_GOTAS_120: '68.900',
    PRICE_TOTAL_CAPSULAS_60: '46.900',
    PRICE_TOTAL_GOTAS_60: '48.900',
    PRICE_TOTAL_SEMILLAS_60: '36.900',
    PRICE_PER_DAY_CAPSULAS_120: '558',
    PRICE_PER_DAY_SEMILLAS_120: '416',
    PRICE_PER_DAY_GOTAS_120: '574',
    // Variantes según producto recomendado (PRICE_60/PRICE_120 resueltos en runtime
    // contra state.selectedProduct; en el panel asumimos cápsulas como ejemplo)
    PRICE_60: '46.900',
    PRICE_120: '66.900',
    // Constantes de negocio
    ALIAS: 'HERBALIS.TIENDA',
    TITULAR: 'BIO ORIGEN S.A.S.',
    ANTICIPO: '10.000',
    ADICIONAL_MAX: '0',
    COSTO_LOGISTICO: '18.000',
    // Pedido (ejemplo cápsulas 120)
    PRODUCT: 'Cápsulas',
    PRODUCT_DETAIL: 'Cápsulas',
    PLAN: '120',
    PLAN_DETAIL: '120 días',
    TOTAL: '66.900',
    // Flujos de pago
    LINK: 'https://mpago.la/example',
    SALDO: '56.900',
    SENA_AMOUNT: '10.000',
    SENA_AMOUNT_FMT: '10.000',
    SENA_REMAINDER: '56.900',
    // Líneas condicionales (en runtime _formatMessage las arma según state.postdatado / sucursal)
    POSTDATADO_LINE: '✔ Entrega estimada: 4 a 6 días hábiles desde la confirmación del pago\n',
    CARTO_LINE: '✔ Saldo al cartero: *$56.900* en efectivo al recibir',
};

function renderText(text) {
    if (!text) return '';
    let r = String(text);
    Object.entries(PLACEHOLDER_VALUES).forEach(([k, v]) => {
        r = r.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    });
    // Bold *text* and italic _text_
    r = r.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
    r = r.replace(/_([^_\n]+)_/g, '<em>$1</em>');
    return r;
}

function formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
        + ' ' + d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

const GuionView = () => {
    const { toast, confirm } = useToast();
    const { user } = useAuth();
    const { socket } = useSocket();
    const isAdmin = user?.role === 'admin';

    const [activeScript, setActiveScript] = useState('v5');
    const [guiones, setGuiones] = useState([]);
    const [comments, setComments] = useState([]);
    const [counts, setCounts] = useState({ v5: 0 });
    const [loading, setLoading] = useState(true);
    const [expandedSection, setExpandedSection] = useState(null);
    const [showResolved, setShowResolved] = useState(false);

    // Highlight de comentarios nuevos: guardamos la última visita del usuario en
    // localStorage, comentarios con createdAt > lastVisit aparecen marcados.
    const lastVisitKey = `guion_last_visit_${user?.id || 'anon'}`;
    const [lastVisitTs, setLastVisitTs] = useState(() => {
        const stored = localStorage.getItem(lastVisitKey);
        return stored ? parseInt(stored, 10) : Date.now();
    });
    // Al desmontar el componente o cambiar de script, actualizamos lastVisit.
    useEffect(() => {
        return () => {
            localStorage.setItem(lastVisitKey, String(Date.now()));
        };
    }, [lastVisitKey]);

    const fetchGuiones = useCallback(async () => {
        try {
            const res = await api.get('/api/guiones');
            setGuiones(res.data.guiones || []);
        } catch (e) {
            toast.error('Error cargando guiones: ' + (e.response?.data?.error || e.message));
        }
    }, []);

    const fetchComments = useCallback(async (script) => {
        try {
            const res = await api.get('/api/guion-comments', { params: { script } });
            setComments(res.data.comments || []);
        } catch (e) {
            toast.error('Error cargando comentarios');
        }
    }, []);

    const fetchCounts = useCallback(async () => {
        try {
            const res = await api.get('/api/guion-comments/counts');
            setCounts(res.data.counts || { v5: 0 });
        } catch (e) { /* silencioso, no es crítico */ }
    }, []);

    useEffect(() => {
        (async () => {
            setLoading(true);
            await Promise.all([fetchGuiones(), fetchCounts()]);
            await fetchComments(activeScript);
            setLoading(false);
        })();
    }, [fetchGuiones, fetchCounts]);

    useEffect(() => {
        fetchComments(activeScript);
        setExpandedSection(null);
    }, [activeScript, fetchComments]);

    // Real-time: escuchar eventos socket para actualizar comentarios sin recargar.
    // Cuando alguien más comenta, lo vemos al instante.
    useEffect(() => {
        if (!socket) return;

        const onAdded = (comment) => {
            // Si es del script activo, lo agregamos al tope. Sino actualizamos solo el contador.
            if (comment.script === activeScript) {
                setComments(prev => prev.some(c => c.id === comment.id) ? prev : [comment, ...prev]);
            }
            setCounts(prev => ({ ...prev, [comment.script]: (prev[comment.script] || 0) + (comment.resolved ? 0 : 1) }));
        };
        const onUpdated = (comment) => {
            setComments(prev => prev.map(c => c.id === comment.id ? comment : c));
            // Refrescar counts es más sencillo que tracking diferencial
            fetchCounts();
        };
        const onDeleted = (payload) => {
            setComments(prev => prev.filter(c => c.id !== payload.id));
            fetchCounts();
        };

        socket.on('guion_comment_added', onAdded);
        socket.on('guion_comment_updated', onUpdated);
        socket.on('guion_comment_deleted', onDeleted);
        return () => {
            socket.off('guion_comment_added', onAdded);
            socket.off('guion_comment_updated', onUpdated);
            socket.off('guion_comment_deleted', onDeleted);
        };
    }, [socket, activeScript, fetchCounts]);

    const activeGuion = guiones.find(g => g.script === activeScript);

    const handleAddComment = async ({ sectionPath, type, content, suggestedText }) => {
        try {
            const res = await api.post('/api/guion-comments', {
                script: activeScript,
                sectionPath,
                type,
                content,
                suggestedText: suggestedText || null,
            });
            // Optimistic add — el socket también va a llegar pero evitamos el flicker
            setComments(prev => prev.some(c => c.id === res.data.comment.id) ? prev : [res.data.comment, ...prev]);
            toast.success('Comentario agregado');
        } catch (e) {
            toast.error('Error al guardar: ' + (e.response?.data?.error || e.message));
        }
    };

    const handleResolveComment = async (id, resolved) => {
        try {
            const res = await api.patch(`/api/guion-comments/${id}`, { resolved });
            setComments(prev => prev.map(c => c.id === id ? res.data.comment : c));
            toast.success(resolved ? 'Marcado como resuelto' : 'Reabierto');
        } catch (e) {
            toast.error('Error al actualizar');
        }
    };

    const handleReact = async (id, emoji = '👍') => {
        try {
            const res = await api.post(`/api/guion-comments/${id}/react`, { emoji });
            setComments(prev => prev.map(c => c.id === id ? res.data.comment : c));
        } catch (e) {
            toast.error('Error al reaccionar');
        }
    };

    const handleDeleteComment = async (id) => {
        const ok = await confirm('¿Eliminar este comentario?');
        if (!ok) return;
        try {
            await api.delete(`/api/guion-comments/${id}`);
            setComments(prev => prev.filter(c => c.id !== id));
            toast.success('Eliminado');
        } catch (e) {
            toast.error('Error al eliminar');
        }
    };

    const handleCopySuggested = (text) => {
        navigator.clipboard.writeText(text)
            .then(() => toast.success('Texto copiado'))
            .catch(() => toast.error('No se pudo copiar'));
    };

    if (loading) {
        return (
            <div className="p-6 flex justify-center items-center min-h-[60vh]">
                <div className="w-8 h-8 border-4 border-indigo-400 border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    if (!activeGuion) {
        return (
            <div className="p-6 text-center text-slate-500">
                No se pudo cargar el guión {activeScript}.
            </div>
        );
    }

    const sections = [];
    // Orden del flujo: greeting → recommendations → prices (TEXTO 3) → preference
    // → closing (pide datos) → menú de pago (TEXTO 4) → ramas de pago
    // (TEXTO 5: MP / transferencia / COD) → confirmaciones finales.
    // `flow.confirmation` (pre-pago, no usado en código) fue removido del JSON.
    const ORDERED_FLOW_KEYS = [
        'greeting',
        'recommendation', 'recommendation_1', 'recommendation_2', 'recommendation_3',
        'prices',
        'preference_capsulas', 'preference_gotas', 'preference_semillas',
        'closing',
        'payment_menu',
        'payment_mp_link', 'payment_mp_link_sena',
        'payment_transfer_alias',
        'payment_cod_retry', 'payment_cod_anticipo',
        'payment_mp_failed', 'payment_mp_retry', 'payment_mp_retry_sena',
        'transfer_received', 'cod_received',
        'order_confirmation_mp', 'order_confirmation_transfer', 'order_confirmation_cod', 'order_confirmation_fallback',
    ];
    ORDERED_FLOW_KEYS.forEach(k => {
        if (activeGuion.flow?.[k]?.response) sections.push({ path: `flow.${k}`, text: activeGuion.flow[k].response });
    });
    // FAQ
    (activeGuion.faq || []).forEach((faq, idx) => {
        sections.push({
            path: `faq[${idx}]`,
            text: faq.response,
            isFaq: true,
            keywords: faq.keywords,
            note: faq._note,
        });
    });

    const visibleComments = showResolved ? comments : comments.filter(c => !c.resolved);
    const commentsBySection = visibleComments.reduce((acc, c) => {
        if (!acc[c.sectionPath]) acc[c.sectionPath] = [];
        acc[c.sectionPath].push(c);
        return acc;
    }, {});
    const totalUnresolved = comments.filter(c => !c.resolved).length;

    return (
        <div className="p-4 sm:p-6 md:p-8 max-w-5xl mx-auto w-full">
            {/* Header */}
            <div className="mb-6">
                <div className="flex items-center gap-3 mb-2">
                    <div className="w-10 h-10 rounded-xl bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 flex items-center justify-center">
                        <FileText className="w-5 h-5" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">Guiones del Bot</h1>
                        <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                            Revisá los guiones y dejá correcciones o notas. Los admins ven todo y pueden marcar como resueltas.
                        </p>
                    </div>
                </div>
            </div>

            {/* Tabs por guión — cada uno con badge de pendientes */}
            <div className="flex flex-wrap gap-2 mb-5 border-b border-slate-200 dark:border-slate-700 pb-4">
                {Object.keys(SCRIPT_LABELS).map(scriptKey => {
                    const meta = SCRIPT_LABELS[scriptKey];
                    const isActive = activeScript === scriptKey;
                    const pending = counts[scriptKey] || 0;
                    return (
                        <button
                            key={scriptKey}
                            onClick={() => setActiveScript(scriptKey)}
                            className={`px-4 py-2 rounded-xl font-bold text-xs transition-all flex items-center gap-2 ${isActive
                                ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-md shadow-indigo-500/30'
                                : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:border-indigo-300'}`}
                        >
                            {meta.name}
                            {pending > 0 && (
                                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${isActive ? 'bg-white/30 text-white' : 'bg-amber-100 text-amber-800'}`}>{pending}</span>
                            )}
                        </button>
                    );
                })}
            </div>

            {/* Tono del guión activo */}
            <div className="mb-6 p-4 rounded-2xl border-l-4 bg-slate-50 dark:bg-slate-800/40" style={{ borderColor: SCRIPT_LABELS[activeScript].color }}>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">Tono</p>
                <p className="text-sm text-slate-700 dark:text-slate-200">{SCRIPT_LABELS[activeScript].tone}</p>
                <p className="text-xs text-slate-500 mt-2">{activeGuion.meta?.description}</p>
            </div>

            {/* Toggle "ver resueltos" */}
            <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    {sections.length} secciones · {totalUnresolved} comentarios pendientes
                </p>
                <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-400 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={showResolved}
                        onChange={(e) => setShowResolved(e.target.checked)}
                        className="rounded text-indigo-600 cursor-pointer"
                    />
                    Mostrar resueltos
                </label>
            </div>

            {/* Secciones — intercaladas con slots "entre pasos" */}
            <div className="space-y-3">
                {sections.map((section, idx) => {
                    const sectionComments = commentsBySection[section.path] || [];
                    const isExpanded = expandedSection === section.path;
                    const sectionLabel = SECTION_LABELS[section.path] ||
                        (section.isFaq ? `FAQ — "${(section.keywords || [])[0] || 'pregunta'}"` : section.path);

                    const next = sections[idx + 1];
                    // Slot entre pasos: solo entre secciones del flow (no entre FAQs ni
                    // entre flow y FAQ — ahí no tiene sentido sugerir un paso intermedio).
                    const showBetween = next && !section.isFaq && !next.isFaq;
                    const slotPath = showBetween ? betweenPath(section.path, next.path) : null;
                    const slotComments = slotPath ? (commentsBySection[slotPath] || []) : [];
                    const slotExpanded = slotPath && expandedSection === slotPath;

                    return (
                        <React.Fragment key={section.path}>
                            <SectionCard
                                sectionPath={section.path}
                                label={sectionLabel}
                                text={section.text}
                                note={section.note}
                                keywords={section.keywords}
                                isFaq={section.isFaq}
                                comments={sectionComments}
                                isExpanded={isExpanded}
                                onToggle={() => setExpandedSection(isExpanded ? null : section.path)}
                                onAddComment={handleAddComment}
                                onResolve={handleResolveComment}
                                onDelete={handleDeleteComment}
                                onReact={handleReact}
                                onCopySuggested={handleCopySuggested}
                                currentUserId={user?.id}
                                isAdmin={isAdmin}
                                lastVisitTs={lastVisitTs}
                            />
                            {showBetween && (
                                <BetweenSlot
                                    sectionPath={slotPath}
                                    prevLabel={sectionLabel}
                                    nextLabel={SECTION_LABELS[next.path] || next.path}
                                    comments={slotComments}
                                    isExpanded={slotExpanded}
                                    onToggle={() => setExpandedSection(slotExpanded ? null : slotPath)}
                                    onAddComment={handleAddComment}
                                    onResolve={handleResolveComment}
                                    onDelete={handleDeleteComment}
                                    onReact={handleReact}
                                    onCopySuggested={handleCopySuggested}
                                    currentUserId={user?.id}
                                    isAdmin={isAdmin}
                                    lastVisitTs={lastVisitTs}
                                />
                            )}
                        </React.Fragment>
                    );
                })}
            </div>
        </div>
    );
};

// ─── Subcomponente: tarjeta de sección con comentarios ─────────────────────
const SectionCard = ({
    sectionPath, label, text, note, keywords, isFaq,
    comments, isExpanded, onToggle, onAddComment, onResolve, onDelete,
    onReact, onCopySuggested,
    currentUserId, isAdmin, lastVisitTs,
}) => {
    const [showForm, setShowForm] = useState(false);
    const [draft, setDraft] = useState('');
    const [draftSuggested, setDraftSuggested] = useState('');
    const [draftType, setDraftType] = useState('correction');
    const [submitting, setSubmitting] = useState(false);

    const submit = async () => {
        if (!draft.trim()) return;
        setSubmitting(true);
        try {
            await onAddComment({
                sectionPath,
                type: draftType,
                content: draft,
                suggestedText: draftType === 'correction' && draftSuggested.trim() ? draftSuggested : null,
            });
            setDraft('');
            setDraftSuggested('');
            setDraftType('correction');
            setShowForm(false);
        } finally {
            setSubmitting(false);
        }
    };

    const unresolvedCount = comments.filter(c => !c.resolved).length;
    const newCount = comments.filter(c => new Date(c.createdAt).getTime() > lastVisitTs && !c.resolved).length;

    return (
        <div className="border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden bg-white dark:bg-slate-800/50 shadow-sm">
            {/* Header de la sección */}
            <button
                onClick={onToggle}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors text-left"
            >
                {isExpanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm text-slate-800 dark:text-slate-100">{label}</p>
                    {isFaq && keywords && (
                        <p className="text-[10px] text-slate-400 mt-0.5 font-mono">
                            Triggers: {keywords.slice(0, 4).join(', ')}{keywords.length > 4 ? '...' : ''}
                        </p>
                    )}
                </div>
                {newCount > 0 && (
                    <span className="bg-rose-100 text-rose-800 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                        <Sparkles className="w-3 h-3" />
                        {newCount} nuevo{newCount === 1 ? '' : 's'}
                    </span>
                )}
                {unresolvedCount > 0 && (
                    <span className="bg-amber-100 text-amber-800 text-[10px] font-bold px-2 py-0.5 rounded-full">
                        {unresolvedCount} {unresolvedCount === 1 ? 'comentario' : 'comentarios'}
                    </span>
                )}
            </button>

            {isExpanded && (
                <div className="border-t border-slate-100 dark:border-slate-700">
                    {/* Texto del bot */}
                    <div className="p-4 bg-emerald-50/40 dark:bg-emerald-900/10 border-b border-slate-100 dark:border-slate-700">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 mb-2">
                            Lo que dice el bot
                        </p>
                        <div
                            className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-line leading-relaxed"
                            dangerouslySetInnerHTML={{ __html: renderText(text) }}
                        />
                        {note && (
                            <p className="text-[11px] text-slate-500 dark:text-slate-400 italic mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                                💡 {note}
                            </p>
                        )}
                    </div>

                    {/* Lista de comentarios */}
                    <div className="p-4 space-y-3">
                        {comments.length === 0 ? (
                            <p className="text-center text-xs text-slate-400 dark:text-slate-500 italic py-4">
                                Sin comentarios todavía. ¡Sé el primero en aportar!
                            </p>
                        ) : (
                            comments.map(comment => (
                                <CommentItem
                                    key={comment.id}
                                    comment={comment}
                                    currentUserId={currentUserId}
                                    isAdmin={isAdmin}
                                    onResolve={onResolve}
                                    onDelete={onDelete}
                                    onReact={onReact}
                                    onCopySuggested={onCopySuggested}
                                    isNew={new Date(comment.createdAt).getTime() > lastVisitTs && !comment.resolved}
                                />
                            ))
                        )}

                        {/* Botón + form para nuevo comentario */}
                        {!showForm ? (
                            <button
                                onClick={() => setShowForm(true)}
                                className="w-full py-2.5 px-4 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-600 text-xs font-bold text-slate-500 dark:text-slate-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-all"
                            >
                                + Agregar comentario
                            </button>
                        ) : (
                            <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2">
                                <div className="flex gap-2">
                                    {Object.entries(TYPE_META).map(([key, m]) => {
                                        const Icon = m.icon;
                                        const isActive = draftType === key;
                                        return (
                                            <button
                                                key={key}
                                                onClick={() => setDraftType(key)}
                                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all ${isActive ? m.color + ' ring-2 ring-offset-1 ring-indigo-300' : 'bg-white dark:bg-slate-700 text-slate-500 dark:text-slate-400 hover:text-slate-700'}`}
                                            >
                                                <Icon className="w-3 h-3" />
                                                {m.label}
                                            </button>
                                        );
                                    })}
                                </div>
                                <textarea
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    placeholder={
                                        draftType === 'correction' ? 'Ej: Acá conviene cambiar "perfecto" por "buenísimo" para sonar más natural.' :
                                            draftType === 'question' ? '¿Por qué dice esto y no lo otro? ¿Hay un caso que no contempla?' :
                                                'Cualquier observación sobre esta sección...'
                                    }
                                    className="w-full h-24 p-3 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 resize-none"
                                    autoFocus
                                />

                                {/* Texto sugerido — solo en correcciones */}
                                {draftType === 'correction' && (
                                    <div>
                                        <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1 flex items-center gap-1">
                                            <Sparkles className="w-3 h-3 text-amber-500" />
                                            Texto sugerido (opcional)
                                        </label>
                                        <textarea
                                            value={draftSuggested}
                                            onChange={(e) => setDraftSuggested(e.target.value)}
                                            placeholder="Si querés sugerir el texto reemplazado completo, copiálo acá. El admin puede aplicarlo con un click."
                                            className="w-full h-32 p-3 text-sm rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-900/10 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-200 resize-none font-mono"
                                        />
                                    </div>
                                )}

                                <div className="flex gap-2 justify-end">
                                    <button
                                        onClick={() => { setShowForm(false); setDraft(''); }}
                                        className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                                    >
                                        Cancelar
                                    </button>
                                    <button
                                        onClick={submit}
                                        disabled={!draft.trim() || submitting}
                                        className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-md shadow-indigo-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {submitting
                                            ? <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                            : <Send className="w-3 h-3" />
                                        }
                                        Guardar
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

// ─── Subcomponente: un comentario individual ───────────────────────────────
const CommentItem = ({ comment, currentUserId, isAdmin, onResolve, onDelete, onReact, onCopySuggested, isNew }) => {
    const meta = TYPE_META[comment.type] || TYPE_META.note;
    const TypeIcon = meta.icon;
    const canEdit = isAdmin || comment.authorId === currentUserId;

    let reactions = [];
    try { reactions = JSON.parse(comment.reactions || '[]'); } catch { reactions = []; }
    const myReaction = reactions.find(r => r.accountId === currentUserId && r.emoji === '👍');
    const reactionsByEmoji = reactions.reduce((acc, r) => {
        acc[r.emoji] = (acc[r.emoji] || []);
        acc[r.emoji].push(r);
        return acc;
    }, {});

    return (
        <div className={`p-3 rounded-xl border transition-all ${comment.resolved
            ? 'bg-slate-50 dark:bg-slate-800/30 border-slate-200 dark:border-slate-700 opacity-70'
            : isNew
                ? 'bg-rose-50/30 dark:bg-rose-900/10 border-rose-300 dark:border-rose-700 ring-2 ring-rose-200 dark:ring-rose-800/40'
                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700'}`}>
            <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center flex-shrink-0">
                    <User className="w-4 h-4 text-slate-500" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="text-xs font-bold text-slate-700 dark:text-slate-200">{comment.authorName}</span>
                        <span className={`flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${meta.color}`}>
                            <TypeIcon className="w-3 h-3" />
                            {meta.label}
                        </span>
                        {isNew && !comment.resolved && (
                            <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-100 text-rose-700">
                                <Sparkles className="w-3 h-3" />
                                Nuevo
                            </span>
                        )}
                        {comment.resolved && (
                            <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                                <Check className="w-3 h-3" />
                                Resuelto
                            </span>
                        )}
                        <span className="text-[10px] text-slate-400">{formatDate(comment.createdAt)}</span>
                    </div>
                    <p className={`text-sm text-slate-700 dark:text-slate-300 whitespace-pre-line ${comment.resolved ? 'line-through' : ''}`}>
                        {comment.content}
                    </p>

                    {/* Texto sugerido — para correcciones */}
                    {comment.suggestedText && (
                        <div className="mt-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400 flex items-center gap-1">
                                    <Sparkles className="w-3 h-3" />
                                    Texto sugerido
                                </span>
                                <button
                                    onClick={() => onCopySuggested(comment.suggestedText)}
                                    className="flex items-center gap-1 text-[10px] font-bold text-amber-700 dark:text-amber-400 hover:text-amber-900 dark:hover:text-amber-200 px-2 py-1 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
                                    title="Copiar al portapapeles"
                                >
                                    <Copy className="w-3 h-3" />
                                    Copiar
                                </button>
                            </div>
                            <pre className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">{comment.suggestedText}</pre>
                        </div>
                    )}

                    {/* Reacciones */}
                    <div className="flex items-center gap-1 mt-2 flex-wrap">
                        <button
                            onClick={() => onReact(comment.id, '👍')}
                            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold transition-all ${myReaction
                                ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-300'
                                : 'bg-slate-100 dark:bg-slate-700 text-slate-500 hover:bg-indigo-50 hover:text-indigo-600'}`}
                            title={myReaction ? 'Sacar like' : 'Estoy de acuerdo'}
                        >
                            <ThumbsUp className="w-3 h-3" />
                            {(reactionsByEmoji['👍'] || []).length || 0}
                        </button>
                        {(reactionsByEmoji['👍'] || []).length > 0 && (
                            <span className="text-[10px] text-slate-400 italic ml-1" title={(reactionsByEmoji['👍'] || []).map(r => r.name).join(', ')}>
                                {(reactionsByEmoji['👍'] || []).slice(0, 2).map(r => r.name).join(', ')}
                                {(reactionsByEmoji['👍'] || []).length > 2 && ` y ${(reactionsByEmoji['👍'] || []).length - 2} más`}
                            </span>
                        )}
                    </div>
                </div>

                {canEdit && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                        {isAdmin && (
                            <button
                                onClick={() => onResolve(comment.id, !comment.resolved)}
                                className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
                                title={comment.resolved ? 'Reabrir' : 'Marcar resuelto'}
                            >
                                {comment.resolved ? <RotateCcw className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
                            </button>
                        )}
                        <button
                            onClick={() => onDelete(comment.id)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
                            title="Eliminar"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

// ─── Subcomponente: slot "entre dos pasos" ─────────────────────────────────
// Permite sugerir un paso intermedio o dejar una nota sobre la transición.
// Compacto por defecto (línea con +); se expande al click para ver/agregar.
const BetweenSlot = ({
    sectionPath, prevLabel, nextLabel,
    comments, isExpanded, onToggle, onAddComment, onResolve, onDelete,
    onReact, onCopySuggested,
    currentUserId, isAdmin, lastVisitTs,
}) => {
    const [showForm, setShowForm] = useState(false);
    const [draft, setDraft] = useState('');
    const [draftSuggested, setDraftSuggested] = useState('');
    const [draftType, setDraftType] = useState('note');
    const [submitting, setSubmitting] = useState(false);

    const submit = async () => {
        if (!draft.trim()) return;
        setSubmitting(true);
        try {
            await onAddComment({
                sectionPath,
                type: draftType,
                content: draft,
                suggestedText: draftSuggested.trim() ? draftSuggested : null,
            });
            setDraft('');
            setDraftSuggested('');
            setDraftType('note');
            setShowForm(false);
        } finally {
            setSubmitting(false);
        }
    };

    const unresolvedCount = comments.filter(c => !c.resolved).length;
    const newCount = comments.filter(c => new Date(c.createdAt).getTime() > lastVisitTs && !c.resolved).length;

    // Compacto: si no hay comentarios y no está expandido, una línea fina con +
    if (!isExpanded && unresolvedCount === 0) {
        return (
            <div className="flex items-center gap-2 px-2 group">
                <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
                <button
                    onClick={onToggle}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-all opacity-50 group-hover:opacity-100"
                    title={`Agregar nota o sugerencia entre "${prevLabel}" y "${nextLabel}"`}
                >
                    <Plus className="w-3 h-3" />
                    Nota entre pasos
                </button>
                <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
            </div>
        );
    }

    return (
        <div className="border border-dashed border-indigo-300 dark:border-indigo-700 rounded-2xl overflow-hidden bg-indigo-50/30 dark:bg-indigo-900/10">
            {/* Header */}
            <button
                onClick={onToggle}
                className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-indigo-100/50 dark:hover:bg-indigo-900/20 transition-colors text-left"
            >
                {isExpanded ? <ChevronDown className="w-4 h-4 text-indigo-400" /> : <ChevronRight className="w-4 h-4 text-indigo-400" />}
                <ArrowDown className="w-3.5 h-3.5 text-indigo-500" />
                <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-bold text-indigo-700 dark:text-indigo-300 uppercase tracking-wider">
                        Entre pasos
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                        <span className="font-semibold">{prevLabel}</span>
                        <span className="mx-1.5 text-slate-400">→</span>
                        <span className="font-semibold">{nextLabel}</span>
                    </p>
                </div>
                {newCount > 0 && (
                    <span className="bg-rose-100 text-rose-800 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                        <Sparkles className="w-3 h-3" />
                        {newCount}
                    </span>
                )}
                {unresolvedCount > 0 && (
                    <span className="bg-amber-100 text-amber-800 text-[10px] font-bold px-2 py-0.5 rounded-full">
                        {unresolvedCount}
                    </span>
                )}
            </button>

            {isExpanded && (
                <div className="border-t border-indigo-200 dark:border-indigo-800 p-3 space-y-3">
                    {comments.length === 0 ? (
                        <p className="text-center text-xs text-slate-400 dark:text-slate-500 italic py-2">
                            ¿Falta algún paso intermedio? ¿Una pregunta o aclaración aquí? Dejá la sugerencia.
                        </p>
                    ) : (
                        comments.map(comment => (
                            <CommentItem
                                key={comment.id}
                                comment={comment}
                                currentUserId={currentUserId}
                                isAdmin={isAdmin}
                                onResolve={onResolve}
                                onDelete={onDelete}
                                onReact={onReact}
                                onCopySuggested={onCopySuggested}
                                isNew={new Date(comment.createdAt).getTime() > lastVisitTs && !comment.resolved}
                            />
                        ))
                    )}

                    {!showForm ? (
                        <button
                            onClick={() => setShowForm(true)}
                            className="w-full py-2 px-4 rounded-xl border-2 border-dashed border-indigo-300 dark:border-indigo-700 text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-all"
                        >
                            + Sugerir paso intermedio o nota
                        </button>
                    ) : (
                        <div className="p-3 rounded-xl bg-white dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2">
                            <div className="flex gap-2 flex-wrap">
                                {Object.entries(TYPE_META).map(([key, m]) => {
                                    const Icon = m.icon;
                                    const isActive = draftType === key;
                                    return (
                                        <button
                                            key={key}
                                            onClick={() => setDraftType(key)}
                                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all ${isActive ? m.color + ' ring-2 ring-offset-1 ring-indigo-300' : 'bg-white dark:bg-slate-700 text-slate-500 dark:text-slate-400 hover:text-slate-700'}`}
                                        >
                                            <Icon className="w-3 h-3" />
                                            {m.label}
                                        </button>
                                    );
                                })}
                            </div>
                            <textarea
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                placeholder={`Ej: Acá conviene que el bot pregunte X antes de pasar a "${nextLabel}".`}
                                className="w-full h-24 p-3 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-200 resize-none"
                                autoFocus
                            />
                            <div>
                                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1 flex items-center gap-1">
                                    <Sparkles className="w-3 h-3 text-amber-500" />
                                    Texto sugerido del paso (opcional)
                                </label>
                                <textarea
                                    value={draftSuggested}
                                    onChange={(e) => setDraftSuggested(e.target.value)}
                                    placeholder="Si querés proponer literalmente lo que diría el bot en este paso intermedio, copiálo acá."
                                    className="w-full h-28 p-3 text-sm rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-900/10 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-200 resize-none font-mono"
                                />
                            </div>
                            <div className="flex gap-2 justify-end">
                                <button
                                    onClick={() => { setShowForm(false); setDraft(''); setDraftSuggested(''); }}
                                    className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                                >
                                    Cancelar
                                </button>
                                <button
                                    onClick={submit}
                                    disabled={!draft.trim() || submitting}
                                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-md shadow-indigo-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {submitting
                                        ? <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                        : <Send className="w-3 h-3" />
                                    }
                                    Guardar
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default GuionView;
