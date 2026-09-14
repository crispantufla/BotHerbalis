import React from 'react';
import {
    ChevronDown, ChevronRight, Sparkles, Plus, ArrowDown,
} from 'lucide-react';
import { Badge } from '../../ui';
import CommentItem from './CommentItem';
import CommentForm from './CommentForm';
import { useCommentDraft } from './useCommentDraft';
import { isNewComment } from './guionConfig';

export default function BetweenSlot({
    sectionPath, prevLabel, nextLabel,
    comments, isExpanded, onToggle, actions,
}) {
    // Entre pasos, cualquier tipo de comentario puede llevar texto sugerido.
    const form = useCommentDraft({
        sectionPath, defaultType: 'note', onAddComment: actions.onAddComment,
        suggestionAllowed: () => true,
    });

    const unresolvedCount = comments.filter(c => !c.resolved).length;
    const newCount = comments.filter(c => isNewComment(c, actions.lastVisitTs)).length;

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
                                actions={actions}
                                isNew={isNewComment(comment, actions.lastVisitTs)}
                            />
                        ))
                    )}

                    {!form.showForm ? (
                        <button
                            type="button"
                            onClick={form.open}
                            className="w-full py-2 px-3 rounded-control border-2 border-dashed border-accent-300 dark:border-accent-900 text-xs font-medium text-accent-600 dark:text-accent-400 hover:bg-accent-50 dark:hover:bg-accent-900/30 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                        >
                            + Sugerir paso intermedio o nota
                        </button>
                    ) : (
                        <CommentForm {...form.formProps} />
                    )}
                </div>
            )}
        </div>
    );
}
