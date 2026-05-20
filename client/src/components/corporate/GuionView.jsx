import React, { useState, useEffect, useCallback } from 'react';
import {
    FileText, MessageSquare, Send, Trash2, Check, RotateCcw, HelpCircle, Edit3,
    User, ChevronDown, ChevronRight, Sparkles, Copy, ThumbsUp, Plus, ArrowDown,
} from 'lucide-react';
import api from '../../config/axios';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import {
    Card, Button, IconButton, Badge, EmptyState, useToast, cn
} from '../ui';

const SCRIPT_LABELS = {
    v5: { name: 'V5 · Asesor consultivo', tone: 'Pregunta kilos primero, recomienda según objetivo' },
    v6: { name: 'V6 · Elena charla',      tone: 'Tono cálido, conversacional, argentino' },
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
    'flow.payment_transfer_alias': 'TEXTO 5b — Transferencia (alias)',
    'flow.payment_cod_retry': 'TEXTO 5c — Contra reembolso (modalidad)',
    'flow.payment_cod_anticipo': 'TEXTO 5d — Confirmación COD (anticipo)',
    'flow.payment_mp_link': 'TEXTO 5a — MercadoPago (link)',
    'flow.payment_mp_link_sena': 'Variante MP — link de seña (legacy)',
    'flow.payment_mp_failed': 'Mensaje cuando MP falla 2 veces',
    'flow.payment_mp_retry': 'Mensaje tras pago rechazado en MP',
    'flow.payment_mp_retry_sena': 'Variante retry MP (legacy seña)',
    'flow.transfer_received': 'Cliente avisó "listo" tras transferencia',
    'flow.cod_received': 'Cliente avisó "listo" tras anticipo COD',
    'flow.order_confirmation_mp': 'Confirmación final · pago MP completo',
    'flow.order_confirmation_transfer': 'Confirmación final · transferencia',
    'flow.order_confirmation_cod': 'Confirmación final · contra reembolso',
    'flow.order_confirmation_fallback': 'Confirmación final · fallback genérico',
};

const TYPE_META = {
    note:       { label: 'Nota',       icon: MessageSquare, tone: 'neutral' },
    correction: { label: 'Corrección', icon: Edit3,         tone: 'warning' },
    question:   { label: 'Pregunta',   icon: HelpCircle,    tone: 'info'    },
};

// Path estable para comentarios entre dos pasos. Lo dejamos como string
// para reusar el mismo endpoint sin cambios en el backend.
const betweenPath = (prev, next) => `between:${prev}|${next}`;

// Reemplaza placeholders {{X}} con valores ejemplo para que se vea como en
// producción. El runtime los sustituye dinámicamente en `_formatMessage`; acá
// usamos valores plausibles para que admins vean cómo queda el mensaje.
// La preview asume MP (4-6d); en runtime real es 7-10d si transferencia/COD.
const PLACEHOLDER_VALUES = {
    PRICE_CAPSULAS_60: '46.900', PRICE_CAPSULAS_120: '66.900',
    PRICE_SEMILLAS_60: '36.900', PRICE_SEMILLAS_120: '49.900',
    PRICE_GOTAS_60: '48.900',    PRICE_GOTAS_120: '68.900',
    PRICE_TOTAL_CAPSULAS_60: '46.900', PRICE_TOTAL_GOTAS_60: '48.900', PRICE_TOTAL_SEMILLAS_60: '36.900',
    PRICE_PER_DAY_CAPSULAS_120: '558', PRICE_PER_DAY_SEMILLAS_120: '416', PRICE_PER_DAY_GOTAS_120: '574',
    PRICE_60: '46.900', PRICE_120: '66.900',
    ALIAS: 'HERBALIS.TIENDA', TITULAR: 'BIO ORIGEN S.A.S.',
    ANTICIPO: '10.000', ADICIONAL_MAX: '0', COSTO_LOGISTICO: '18.000',
    PRODUCT: 'Cápsulas', PRODUCT_DETAIL: 'Cápsulas',
    PLAN: '120', PLAN_DETAIL: '120 días',
    TOTAL: '66.900',
    LINK: 'https://mpago.la/example',
    SALDO: '56.900',
    SENA_AMOUNT: '10.000', SENA_AMOUNT_FMT: '10.000', SENA_REMAINDER: '56.900',
    POSTDATADO_LINE: '✔ Entrega estimada: 4 a 6 días hábiles desde la confirmación del pago\n',
    CARTO_LINE: '✔ Saldo al cartero: *$56.900* en efectivo al recibir',
};

function renderText(text) {
    if (!text) return '';
    let r = String(text);
    Object.entries(PLACEHOLDER_VALUES).forEach(([k, v]) => {
        r = r.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    });
    r = r.replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>');
    r = r.replace(/_([^_\n]+)_/g, '<em>$1</em>');
    return r;
}

function formatDate(iso) {
    const d = new Date(iso);
    return `${d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`;
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

    // Highlight de comentarios nuevos: lastVisit en localStorage, comentarios
    // con createdAt > lastVisit aparecen marcados.
    const lastVisitKey = `guion_last_visit_${user?.id || 'anon'}`;
    const [lastVisitTs] = useState(() => {
        const stored = localStorage.getItem(lastVisitKey);
        return stored ? parseInt(stored, 10) : Date.now();
    });
    // Al desmontar o cambiar de script, actualizamos lastVisit.
    useEffect(() => {
        return () => { localStorage.setItem(lastVisitKey, String(Date.now())); };
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
        } catch {
            toast.error('Error cargando comentarios');
        }
    }, []);

    const fetchCounts = useCallback(async () => {
        try {
            const res = await api.get('/api/guion-comments/counts');
            setCounts(res.data.counts || { v5: 0 });
        } catch { /* silencioso */ }
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

    // Real-time: socket eventos para refresh sin recarga.
    useEffect(() => {
        if (!socket) return;
        const onAdded = (comment) => {
            if (comment.script === activeScript) {
                setComments(prev => prev.some(c => c.id === comment.id) ? prev : [comment, ...prev]);
            }
            setCounts(prev => ({ ...prev, [comment.script]: (prev[comment.script] || 0) + (comment.resolved ? 0 : 1) }));
        };
        const onUpdated = (comment) => {
            setComments(prev => prev.map(c => c.id === comment.id ? comment : c));
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
                script: activeScript, sectionPath, type, content,
                suggestedText: suggestedText || null,
            });
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
        } catch { toast.error('Error al actualizar'); }
    };

    const handleReact = async (id, emoji = '👍') => {
        try {
            const res = await api.post(`/api/guion-comments/${id}/react`, { emoji });
            setComments(prev => prev.map(c => c.id === id ? res.data.comment : c));
        } catch { toast.error('Error al reaccionar'); }
    };

    const handleDeleteComment = async (id) => {
        const ok = await confirm('¿Eliminar este comentario?');
        if (!ok) return;
        try {
            await api.delete(`/api/guion-comments/${id}`);
            setComments(prev => prev.filter(c => c.id !== id));
            toast.success('Eliminado');
        } catch { toast.error('Error al eliminar'); }
    };

    const handleCopySuggested = (text) => {
        navigator.clipboard.writeText(text)
            .then(() => toast.success('Texto copiado'))
            .catch(() => toast.error('No se pudo copiar'));
    };

    if (loading) {
        return (
            <div className="p-6 flex justify-center items-center min-h-[60vh]">
                <div className="w-8 h-8 border-[3px] border-accent-200 dark:border-accent-900 border-t-accent-600 dark:border-t-accent-500 rounded-full animate-spin" />
            </div>
        );
    }

    if (!activeGuion) {
        return (
            <Card padding="lg" className="max-w-md mx-auto">
                <EmptyState
                    icon={FileText}
                    title="Guión no disponible"
                    description={`No se pudo cargar el guión ${activeScript}.`}
                />
            </Card>
        );
    }

    // Orden del flujo: greeting → recommendations → prices (TEXTO 3) → preference
    // → closing (pide datos) → menú de pago (TEXTO 4) → ramas de pago
    // (TEXTO 5: MP / transferencia / COD) → confirmaciones finales.
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

    const sections = [];
    ORDERED_FLOW_KEYS.forEach(k => {
        if (activeGuion.flow?.[k]?.response) sections.push({ path: `flow.${k}`, text: activeGuion.flow[k].response });
    });
    (activeGuion.faq || []).forEach((faq, idx) => {
        sections.push({
            path: `faq[${idx}]`, text: faq.response, isFaq: true,
            keywords: faq.keywords, note: faq._note,
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
        <div className="max-w-5xl mx-auto w-full space-y-4">
            {/* Header alineado con el resto del dashboard (SalesView, PaymentsView…):
                text-display + subtítulo, sin avatar/ícono. El icono FileText queda
                disponible si en el futuro quisiéramos retomar el patrón con avatar. */}
            <header>
                <h1 className="text-display text-slate-900 dark:text-slate-100">Guiones del bot</h1>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                    Revisá los guiones y dejá correcciones o notas. Los admins ven todo y pueden marcar como resueltas.
                </p>
            </header>

            {/* Tabs por guión */}
            <div className="flex flex-wrap gap-2 pb-3 border-b border-slate-200 dark:border-slate-700">
                {Object.keys(SCRIPT_LABELS).map(scriptKey => {
                    const meta = SCRIPT_LABELS[scriptKey];
                    const isActive = activeScript === scriptKey;
                    const pending = counts[scriptKey] || 0;
                    return (
                        <button
                            key={scriptKey}
                            type="button"
                            onClick={() => setActiveScript(scriptKey)}
                            className={cn(
                                'inline-flex items-center gap-2 px-3 h-9 rounded-control text-xs font-semibold transition-colors',
                                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                                isActive
                                    ? 'bg-accent-600 text-white'
                                    : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'
                            )}
                        >
                            {meta.name}
                            {pending > 0 && (
                                <span className={cn(
                                    'inline-flex items-center justify-center rounded-full text-[10px] font-semibold px-1.5 min-w-[1.25rem] h-4 tabular-nums',
                                    isActive ? 'bg-white/25 text-white' : 'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-500'
                                )}>{pending}</span>
                            )}
                        </button>
                    );
                })}
            </div>

            {/* Tono del guión */}
            <Card padding="md" className="border-l-4 border-l-accent-500">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Tono</p>
                <p className="text-sm text-slate-700 dark:text-slate-200 mt-0.5">{SCRIPT_LABELS[activeScript].tone}</p>
                {activeGuion.meta?.description && (
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">{activeGuion.meta.description}</p>
                )}
            </Card>

            {/* Toggle resueltos + stats */}
            <div className="flex items-center justify-between">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    {sections.length} secciones · {totalUnresolved} comentarios pendientes
                </p>
                <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-400 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={showResolved}
                        onChange={(e) => setShowResolved(e.target.checked)}
                        className="rounded text-accent-600 focus:ring-accent-500 cursor-pointer"
                    />
                    Mostrar resueltos
                </label>
            </div>

            {/* Secciones */}
            <div className="space-y-2">
                {sections.map((section, idx) => {
                    const sectionComments = commentsBySection[section.path] || [];
                    const isExpanded = expandedSection === section.path;
                    const sectionLabel = SECTION_LABELS[section.path]
                        || (section.isFaq ? `FAQ · "${(section.keywords || [])[0] || 'pregunta'}"` : section.path);

                    const next = sections[idx + 1];
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

// ─── SectionCard ───────────────────────────────────────────────────────────
function SectionCard({
    sectionPath, label, text, note, keywords, isFaq,
    comments, isExpanded, onToggle, onAddComment, onResolve, onDelete,
    onReact, onCopySuggested,
    currentUserId, isAdmin, lastVisitTs,
}) {
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
                sectionPath, type: draftType, content: draft,
                suggestedText: draftType === 'correction' && draftSuggested.trim() ? draftSuggested : null,
            });
            setDraft(''); setDraftSuggested(''); setDraftType('correction');
            setShowForm(false);
        } finally {
            setSubmitting(false);
        }
    };

    const unresolvedCount = comments.filter(c => !c.resolved).length;
    const newCount = comments.filter(c => new Date(c.createdAt).getTime() > lastVisitTs && !c.resolved).length;

    return (
        <Card padding="none" interactive>
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={isExpanded}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-inset"
            >
                {isExpanded
                    ? <ChevronDown className="w-4 h-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                    : <ChevronRight className="w-4 h-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                }
                <div className="flex-1 min-w-0">
                    <p className="font-semibold text-sm text-slate-900 dark:text-slate-100">{label}</p>
                    {isFaq && keywords && (
                        <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5 font-mono">
                            Triggers: {keywords.slice(0, 4).join(', ')}{keywords.length > 4 ? '…' : ''}
                        </p>
                    )}
                </div>
                {newCount > 0 && (
                    <Badge tone="danger" size="sm">
                        <Sparkles className="w-3 h-3" />
                        {newCount} nuevo{newCount === 1 ? '' : 's'}
                    </Badge>
                )}
                {unresolvedCount > 0 && (
                    <Badge tone="warning" size="sm">
                        {unresolvedCount} {unresolvedCount === 1 ? 'comentario' : 'comentarios'}
                    </Badge>
                )}
            </button>

            {isExpanded && (
                <div className="border-t border-slate-200/70 dark:border-slate-700/70">
                    {/* Texto del bot */}
                    <div className="p-4 bg-success-50/40 dark:bg-success-900/10 border-b border-slate-200/70 dark:border-slate-700/70">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-success-700 dark:text-success-500 mb-2">
                            Lo que dice el bot
                        </p>
                        <div
                            className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-line leading-relaxed"
                            dangerouslySetInnerHTML={{ __html: renderText(text) }}
                        />
                        {note && (
                            <p className="text-xs text-slate-500 dark:text-slate-400 italic mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                                {note}
                            </p>
                        )}
                    </div>

                    {/* Lista de comentarios */}
                    <div className="p-4 space-y-3">
                        {comments.length === 0 ? (
                            <p className="text-center text-xs text-slate-500 dark:text-slate-400 italic py-2">
                                Sin comentarios todavía.
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
                                type="button"
                                onClick={() => setShowForm(true)}
                                className="w-full py-2 px-3 rounded-control border-2 border-dashed border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-500 dark:text-slate-400 hover:border-accent-400 hover:text-accent-600 dark:hover:text-accent-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                            >
                                + Agregar comentario
                            </button>
                        ) : (
                            <CommentForm
                                draft={draft} setDraft={setDraft}
                                draftSuggested={draftSuggested} setDraftSuggested={setDraftSuggested}
                                draftType={draftType} setDraftType={setDraftType}
                                onSubmit={submit}
                                onCancel={() => { setShowForm(false); setDraft(''); setDraftSuggested(''); }}
                                submitting={submitting}
                                showSuggested={draftType === 'correction'}
                            />
                        )}
                    </div>
                </div>
            )}
        </Card>
    );
}

// ─── CommentItem ───────────────────────────────────────────────────────────
function CommentItem({ comment, currentUserId, isAdmin, onResolve, onDelete, onReact, onCopySuggested, isNew }) {
    const meta = TYPE_META[comment.type] || TYPE_META.note;
    const TypeIcon = meta.icon;
    const canEdit = isAdmin || comment.authorId === currentUserId;

    let reactions = [];
    try { reactions = JSON.parse(comment.reactions || '[]'); } catch { reactions = []; }
    const myReaction = reactions.find(r => r.accountId === currentUserId && r.emoji === '👍');
    const thumbsReactions = reactions.filter(r => r.emoji === '👍');

    return (
        <div className={cn(
            'p-3 rounded-control border transition-all',
            comment.resolved
                ? 'bg-slate-50 dark:bg-slate-800/30 border-slate-200/70 dark:border-slate-700/70 opacity-70'
                : isNew
                    ? 'bg-danger-50/30 dark:bg-danger-900/10 border-danger-200 dark:border-danger-900/50 ring-2 ring-danger-200/40 dark:ring-danger-900/30'
                    : 'bg-white dark:bg-slate-800 border-slate-200/70 dark:border-slate-700/70'
        )}>
            <div className="flex items-start gap-2.5">
                <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center flex-shrink-0">
                    <User className="w-4 h-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap mb-1">
                        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{comment.authorName}</span>
                        <Badge tone={meta.tone} size="sm">
                            <TypeIcon className="w-3 h-3" />
                            {meta.label}
                        </Badge>
                        {isNew && !comment.resolved && (
                            <Badge tone="danger" size="sm">
                                <Sparkles className="w-3 h-3" />
                                Nuevo
                            </Badge>
                        )}
                        {comment.resolved && (
                            <Badge tone="success" size="sm">
                                <Check className="w-3 h-3" />
                                Resuelto
                            </Badge>
                        )}
                        <span className="text-[10px] text-slate-400 dark:text-slate-500 tabular-nums">
                            {formatDate(comment.createdAt)}
                        </span>
                    </div>
                    <p className={cn(
                        'text-sm text-slate-700 dark:text-slate-300 whitespace-pre-line',
                        comment.resolved && 'line-through'
                    )}>
                        {comment.content}
                    </p>

                    {comment.suggestedText && (
                        <div className="mt-3 p-3 rounded-control bg-warning-50 dark:bg-warning-900/20 border border-warning-100 dark:border-warning-900/40">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[11px] font-medium uppercase tracking-wide text-warning-700 dark:text-warning-500 flex items-center gap-1">
                                    <Sparkles className="w-3 h-3" aria-hidden="true" />
                                    Texto sugerido
                                </span>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    leftIcon={Copy}
                                    onClick={() => onCopySuggested(comment.suggestedText)}
                                    className="!text-warning-700 dark:!text-warning-500 hover:!bg-warning-100 dark:hover:!bg-warning-900/40"
                                >
                                    Copiar
                                </Button>
                            </div>
                            <pre className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
                                {comment.suggestedText}
                            </pre>
                        </div>
                    )}

                    {/* Reacciones */}
                    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        <button
                            type="button"
                            onClick={() => onReact(comment.id, '👍')}
                            className={cn(
                                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-colors',
                                myReaction
                                    ? 'bg-accent-100 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300'
                                    : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 hover:bg-accent-50 dark:hover:bg-accent-900/30 hover:text-accent-600 dark:hover:text-accent-400'
                            )}
                            aria-label={myReaction ? 'Quitar like' : 'Estoy de acuerdo'}
                        >
                            <ThumbsUp className="w-3 h-3" aria-hidden="true" />
                            {thumbsReactions.length || 0}
                        </button>
                        {thumbsReactions.length > 0 && (
                            <span
                                className="text-[10px] text-slate-400 dark:text-slate-500 italic"
                                title={thumbsReactions.map(r => r.name).join(', ')}
                            >
                                {thumbsReactions.slice(0, 2).map(r => r.name).join(', ')}
                                {thumbsReactions.length > 2 && ` y ${thumbsReactions.length - 2} más`}
                            </span>
                        )}
                    </div>
                </div>

                {canEdit && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                        {isAdmin && (
                            <IconButton
                                label={comment.resolved ? 'Reabrir' : 'Marcar resuelto'}
                                icon={comment.resolved ? RotateCcw : Check}
                                variant="ghost"
                                size="sm"
                                onClick={() => onResolve(comment.id, !comment.resolved)}
                            />
                        )}
                        <IconButton
                            label="Eliminar comentario"
                            icon={Trash2}
                            variant="danger"
                            size="sm"
                            onClick={() => onDelete(comment.id)}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

// ─── CommentForm (shared) ──────────────────────────────────────────────────
function CommentForm({
    draft, setDraft, draftSuggested, setDraftSuggested,
    draftType, setDraftType, onSubmit, onCancel, submitting, showSuggested,
}) {
    return (
        <div className="p-3 rounded-control bg-slate-50 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700/70 space-y-2.5">
            <div className="flex gap-2 flex-wrap">
                {Object.entries(TYPE_META).map(([key, m]) => {
                    const Icon = m.icon;
                    const isActive = draftType === key;
                    return (
                        <button
                            key={key}
                            type="button"
                            onClick={() => setDraftType(key)}
                            className={cn(
                                'inline-flex items-center gap-1.5 px-3 h-8 rounded-control text-xs font-medium transition-colors',
                                'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                                isActive
                                    ? 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300 ring-1 ring-accent-300 dark:ring-accent-700'
                                    : 'bg-white dark:bg-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-600'
                            )}
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
                placeholder="Tu comentario, observación o pregunta…"
                className="w-full h-24 p-3 text-sm rounded-control border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 resize-none"
                autoFocus
            />

            {showSuggested && (
                <div>
                    <label className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1 flex items-center gap-1">
                        <Sparkles className="w-3 h-3 text-warning-500" aria-hidden="true" />
                        Texto sugerido (opcional)
                    </label>
                    <textarea
                        value={draftSuggested}
                        onChange={(e) => setDraftSuggested(e.target.value)}
                        placeholder="Si querés sugerir el texto reemplazado completo, copiálo acá."
                        className="w-full h-28 p-3 text-sm rounded-control border border-warning-200 dark:border-warning-900/40 bg-warning-50/50 dark:bg-warning-900/10 text-slate-800 dark:text-slate-100 focus:outline-none focus:border-warning-500 focus:ring-2 focus:ring-warning-500/20 resize-none font-mono"
                    />
                </div>
            )}

            <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={onCancel}>
                    Cancelar
                </Button>
                <Button
                    size="sm"
                    onClick={onSubmit}
                    loading={submitting}
                    disabled={!draft.trim()}
                    leftIcon={Send}
                >
                    Guardar
                </Button>
            </div>
        </div>
    );
}

// ─── BetweenSlot ───────────────────────────────────────────────────────────
function BetweenSlot({
    sectionPath, prevLabel, nextLabel,
    comments, isExpanded, onToggle, onAddComment, onResolve, onDelete,
    onReact, onCopySuggested,
    currentUserId, isAdmin, lastVisitTs,
}) {
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
                sectionPath, type: draftType, content: draft,
                suggestedText: draftSuggested.trim() ? draftSuggested : null,
            });
            setDraft(''); setDraftSuggested(''); setDraftType('note');
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
                    type="button"
                    onClick={onToggle}
                    title={`Agregar nota o sugerencia entre "${prevLabel}" y "${nextLabel}"`}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:text-accent-600 dark:hover:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-900/30 transition-colors opacity-60 group-hover:opacity-100 focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                    <Plus className="w-3 h-3" aria-hidden="true" />
                    Nota entre pasos
                </button>
                <div className="flex-1 h-px bg-slate-200 dark:bg-slate-700" />
            </div>
        );
    }

    return (
        <div className="border border-dashed border-accent-300 dark:border-accent-900 rounded-card overflow-hidden bg-accent-50/30 dark:bg-accent-900/10">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={isExpanded}
                className="w-full px-3 py-2 flex items-center gap-2 hover:bg-accent-100/40 dark:hover:bg-accent-900/20 transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-inset"
            >
                {isExpanded
                    ? <ChevronDown className="w-4 h-4 text-accent-500 dark:text-accent-400" aria-hidden="true" />
                    : <ChevronRight className="w-4 h-4 text-accent-500 dark:text-accent-400" aria-hidden="true" />
                }
                <ArrowDown className="w-3.5 h-3.5 text-accent-500 dark:text-accent-400" aria-hidden="true" />
                <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-accent-700 dark:text-accent-400">
                        Entre pasos
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                        <span className="font-medium">{prevLabel}</span>
                        <span className="mx-1.5">→</span>
                        <span className="font-medium">{nextLabel}</span>
                    </p>
                </div>
                {newCount > 0 && (
                    <Badge tone="danger" size="sm"><Sparkles className="w-3 h-3" />{newCount}</Badge>
                )}
                {unresolvedCount > 0 && (
                    <Badge tone="warning" size="sm">{unresolvedCount}</Badge>
                )}
            </button>

            {isExpanded && (
                <div className="border-t border-accent-200 dark:border-accent-900/50 p-3 space-y-3">
                    {comments.length === 0 ? (
                        <p className="text-center text-xs text-slate-500 dark:text-slate-400 italic">
                            ¿Falta algún paso intermedio? Dejá la sugerencia.
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
                            type="button"
                            onClick={() => setShowForm(true)}
                            className="w-full py-2 px-3 rounded-control border-2 border-dashed border-accent-300 dark:border-accent-900 text-xs font-medium text-accent-600 dark:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-900/30 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                        >
                            + Sugerir paso intermedio o nota
                        </button>
                    ) : (
                        <CommentForm
                            draft={draft} setDraft={setDraft}
                            draftSuggested={draftSuggested} setDraftSuggested={setDraftSuggested}
                            draftType={draftType} setDraftType={setDraftType}
                            onSubmit={submit}
                            onCancel={() => { setShowForm(false); setDraft(''); setDraftSuggested(''); }}
                            submitting={submitting}
                            showSuggested
                        />
                    )}
                </div>
            )}
        </div>
    );
}

export default GuionView;
