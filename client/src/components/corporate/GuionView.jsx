import React, { useState, useEffect, useCallback } from 'react';
import {
    FileText, ChevronDown, ChevronRight,
} from 'lucide-react';
import api from '../../config/axios';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import { Card, Badge, EmptyState, useToast, cn } from '../ui';
import SectionCard from './guion/SectionCard';
import BetweenSlot from './guion/BetweenSlot';
import { SCRIPT_LABELS, SECTION_LABELS, STAGE_GROUPS, betweenPath } from './guion/guionConfig';

const GuionView = () => {
    const { toast, confirm } = useToast();
    const { user } = useAuth();
    const { socket } = useSocket();
    const isAdmin = user?.role === 'admin';

    const [activeScript, setActiveScript] = useState('v7');
    const [guiones, setGuiones] = useState([]);
    const [comments, setComments] = useState([]);
    const [counts, setCounts] = useState({ v7: 0 });
    const [prices, setPrices] = useState(null);
    const [loading, setLoading] = useState(true);
    const [expandedSection, setExpandedSection] = useState(null);
    const [showResolved, setShowResolved] = useState(false);
    // Etapas expandidas (Set de stage.key). Default colapsado; al cargar
    // comentarios decidimos auto-abrir las que tengan pendientes.
    const [expandedStages, setExpandedStages] = useState(() => new Set());
    const toggleStage = (key) => {
        setExpandedStages(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    };

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
    }, [toast]);

    const fetchComments = useCallback(async (script) => {
        try {
            const res = await api.get('/api/guion-comments', { params: { script } });
            setComments(res.data.comments || []);
        } catch {
            toast.error('Error cargando comentarios');
        }
    }, [toast]);

    const fetchCounts = useCallback(async () => {
        try {
            const res = await api.get('/api/guion-comments/counts');
            setCounts(res.data.counts || { v7: 0 });
        } catch { /* silencioso */ }
    }, []);

    // Precios del Editor para la vista previa de los textos. Si fallan, los
    // placeholders de precio quedan visibles (nunca un número inventado).
    const fetchPrices = useCallback(async () => {
        try {
            const res = await api.get('/api/prices');
            setPrices(res.data || null);
        } catch { /* silencioso */ }
    }, []);

    useEffect(() => {
        (async () => {
            setLoading(true);
            await Promise.all([fetchGuiones(), fetchCounts(), fetchPrices()]);
            await fetchComments(activeScript);
            setLoading(false);
        })();
    }, [fetchGuiones, fetchCounts, fetchPrices, fetchComments, activeScript]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- recarga los comentarios al cambiar de guion (el setState va después del await)
        fetchComments(activeScript);
    }, [activeScript, fetchComments]);

    // Auto-expandir etapas que tengan comentarios pendientes. Solo cuando
    // cambia activeScript o comments — evita re-cerrar etapas que el user
    // abrió manualmente (porque la decisión se basa en el set inicial).
    useEffect(() => {
        const pending = comments.filter(c => !c.resolved);
        if (pending.length === 0) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- abre las etapas con comentarios pendientes cuando llegan, por fetch o por socket
        setExpandedStages(prev => {
            const next = new Set(prev);
            for (const group of STAGE_GROUPS) {
                const pathPrefixes = group.isFaq
                    ? ['faq[']
                    : group.sectionKeys.map(k => `flow.${k}`);
                const hasPending = pending.some(c => {
                    if (group.isFaq) return c.sectionPath.startsWith('faq[');
                    return pathPrefixes.includes(c.sectionPath)
                        || (c.sectionPath.startsWith('between:') &&
                            pathPrefixes.some(p => c.sectionPath.includes(p)));
                });
                if (hasPending) next.add(group.key);
            }
            return next;
        });
    }, [activeScript, comments]);

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
        } catch (e) {
            // Loguea + muestra el motivo real (401, 403, 404, 500) en vez del
            // "Error al eliminar" genérico que ocultaba la causa.
            const status = e?.response?.status;
            const backendMsg = e?.response?.data?.error;
            console.error('[GUION] delete fallo:', { id, status, backendMsg, raw: e });
            const msg = backendMsg
                ? `No se pudo eliminar: ${backendMsg}`
                : (status ? `Error al eliminar (${status})` : 'Error al eliminar (sin red?)');
            toast.error(msg);
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

    // Armamos las secciones agrupadas por etapa siguiendo el orden de
    // STAGE_GROUPS. Cada sección lleva su `groupKey` para poder renderizar
    // entre/dentro de etapa correctamente. Las FAQs van en la etapa "faq".
    const sectionsByGroup = STAGE_GROUPS.map(group => {
        if (group.isFaq) {
            const faqs = (activeGuion.faq || []).map((faq, idx) => ({
                path: `faq[${idx}]`,
                text: faq.response,
                isFaq: true,
                keywords: faq.keywords,
                note: faq._note,
                groupKey: group.key,
            }));
            return { group, sections: faqs };
        }
        const items = group.sectionKeys
            .filter(k => activeGuion.flow?.[k]?.response)
            .map(k => ({
                path: `flow.${k}`,
                text: activeGuion.flow[k].response,
                groupKey: group.key,
            }));
        return { group, sections: items };
    }).filter(g => g.sections.length > 0);

    const visibleComments = showResolved ? comments : comments.filter(c => !c.resolved);
    const commentsBySection = visibleComments.reduce((acc, c) => {
        if (!acc[c.sectionPath]) acc[c.sectionPath] = [];
        acc[c.sectionPath].push(c);
        return acc;
    }, {});
    const totalUnresolved = comments.filter(c => !c.resolved).length;
    const totalSections = sectionsByGroup.reduce((acc, g) => acc + g.sections.length, 0);

    // Lo que cada comentario necesita para mostrarse y cambiarse; va igual a las
    // secciones y a los slots "entre pasos".
    const commentActions = {
        onAddComment: handleAddComment, onResolve: handleResolveComment, onDelete: handleDeleteComment,
        onReact: handleReact, onCopySuggested: handleCopySuggested,
        currentUserId: user?.id, isAdmin, lastVisitTs,
    };

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
                            onClick={() => { if (scriptKey !== activeScript) setExpandedSection(null); setActiveScript(scriptKey); }}
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

            {/* Toggle resueltos + stats + controles globales */}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    {totalSections} secciones en {sectionsByGroup.length} etapas · {totalUnresolved} comentarios pendientes
                </p>
                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        onClick={() => setExpandedStages(new Set(STAGE_GROUPS.map(g => g.key)))}
                        className="text-[11px] font-medium text-accent-600 dark:text-accent-400 hover:underline"
                    >
                        Expandir todo
                    </button>
                    <button
                        type="button"
                        onClick={() => setExpandedStages(new Set())}
                        className="text-[11px] font-medium text-slate-600 dark:text-slate-400 hover:underline"
                    >
                        Colapsar todo
                    </button>
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
            </div>

            {/* Etapas */}
            <div className="space-y-2">
                {sectionsByGroup.map(({ group, sections: groupSections }, gIdx) => {
                    const Icon = group.icon;
                    const isStageExpanded = expandedStages.has(group.key);

                    // Comentarios pendientes (visibles) en cualquier path de esta etapa,
                    // incluyendo entre-de-etapa entre dos secciones consecutivas internas.
                    const stagePaths = new Set(groupSections.map(s => s.path));
                    for (let i = 0; i < groupSections.length - 1; i++) {
                        if (!groupSections[i].isFaq && !groupSections[i + 1].isFaq) {
                            stagePaths.add(betweenPath(groupSections[i].path, groupSections[i + 1].path));
                        }
                    }
                    const stagePending = visibleComments.filter(c => stagePaths.has(c.sectionPath) && !c.resolved).length;
                    const stageTotal = visibleComments.filter(c => stagePaths.has(c.sectionPath)).length;

                    // Cross-stage between: conecta la última sección de ESTA etapa con la primera de la SIGUIENTE.
                    // No lo dibujamos por defecto (raro); pero si tiene comentarios, lo mostramos
                    // como pequeña row entre las dos cards para no perderlos.
                    const nextGroupData = sectionsByGroup[gIdx + 1];
                    let crossSlot = null;
                    if (nextGroupData) {
                        const last = groupSections[groupSections.length - 1];
                        const next = nextGroupData.sections[0];
                        if (last && next && !last.isFaq && !next.isFaq) {
                            const sp = betweenPath(last.path, next.path);
                            crossSlot = { slotPath: sp, prev: last, next, comments: commentsBySection[sp] || [] };
                        }
                    }

                    return (
                        <React.Fragment key={group.key}>
                            <Card padding="none" className="overflow-hidden">
                                <button
                                    type="button"
                                    onClick={() => toggleStage(group.key)}
                                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 text-left transition-colors"
                                    aria-expanded={isStageExpanded}
                                >
                                    {isStageExpanded
                                        ? <ChevronDown size={18} className="text-slate-500" />
                                        : <ChevronRight size={18} className="text-slate-500" />}
                                    <Icon size={18} className="text-accent-600 dark:text-accent-400" />
                                    <span className="flex-1 text-sm font-semibold text-slate-800 dark:text-slate-200">
                                        {group.label}
                                    </span>
                                    <span className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
                                        {groupSections.length} {group.isFaq ? 'preguntas' : 'secciones'}
                                    </span>
                                    {stagePending > 0 && (
                                        <Badge tone="warning">{stagePending}</Badge>
                                    )}
                                    {stagePending === 0 && stageTotal > 0 && showResolved && (
                                        <Badge tone="neutral">{stageTotal}</Badge>
                                    )}
                                </button>
                                {isStageExpanded && (
                                    <div className="border-t border-slate-200 dark:border-slate-700 px-3 py-3 space-y-2 bg-slate-50/50 dark:bg-slate-900/20">
                                        {groupSections.map((section, idx) => {
                                            const sectionComments = commentsBySection[section.path] || [];
                                            const isExpanded = expandedSection === section.path;
                                            const sectionLabel = SECTION_LABELS[section.path]
                                                || (section.isFaq ? `FAQ · "${(section.keywords || [])[0] || 'pregunta'}"` : section.path);

                                            const next = groupSections[idx + 1];
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
                                                        actions={commentActions}
                                                        prices={prices}
                                                    />
                                                    {showBetween && (
                                                        <BetweenSlot
                                                            sectionPath={slotPath}
                                                            prevLabel={sectionLabel}
                                                            nextLabel={SECTION_LABELS[next.path] || next.path}
                                                            comments={slotComments}
                                                            isExpanded={slotExpanded}
                                                            onToggle={() => setExpandedSection(slotExpanded ? null : slotPath)}
                                                            actions={commentActions}
                                                        />
                                                    )}
                                                </React.Fragment>
                                            );
                                        })}
                                    </div>
                                )}
                            </Card>
                            {/* Cross-stage between: solo si tiene comentarios (rare path) */}
                            {crossSlot && crossSlot.comments.length > 0 && (
                                <BetweenSlot
                                    sectionPath={crossSlot.slotPath}
                                    prevLabel={SECTION_LABELS[crossSlot.prev.path] || crossSlot.prev.path}
                                    nextLabel={SECTION_LABELS[crossSlot.next.path] || crossSlot.next.path}
                                    comments={crossSlot.comments}
                                    isExpanded={expandedSection === crossSlot.slotPath}
                                    onToggle={() => setExpandedSection(expandedSection === crossSlot.slotPath ? null : crossSlot.slotPath)}
                                    actions={commentActions}
                                />
                            )}
                        </React.Fragment>
                    );
                })}
            </div>
        </div>
    );
};

export default GuionView;
