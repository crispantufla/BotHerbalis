import React from 'react';
import {
    ChevronDown, ChevronRight, Sparkles,
} from 'lucide-react';
import { Card, Badge } from '../../ui';
import CommentItem from './CommentItem';
import CommentForm from './CommentForm';
import { useCommentDraft } from './useCommentDraft';
import { renderText, isNewComment } from './guionConfig';

export default function SectionCard({
    sectionPath, label, text, note, keywords, isFaq,
    comments, isExpanded, onToggle, actions,
}) {
    // En una sección, el texto sugerido solo acompaña a las correcciones.
    const form = useCommentDraft({
        sectionPath, defaultType: 'correction', onAddComment: actions.onAddComment,
        suggestionAllowed: (type) => type === 'correction',
    });

    const unresolvedCount = comments.filter(c => !c.resolved).length;
    const newCount = comments.filter(c => isNewComment(c, actions.lastVisitTs)).length;

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
                                    actions={actions}
                                    isNew={isNewComment(comment, actions.lastVisitTs)}
                                />
                            ))
                        )}

                        {!form.showForm ? (
                            <button
                                type="button"
                                onClick={form.open}
                                className="w-full py-2 px-3 rounded-control border-2 border-dashed border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-500 dark:text-slate-400 hover:border-accent-400 hover:text-accent-600 dark:hover:text-accent-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                            >
                                + Agregar comentario
                            </button>
                        ) : (
                            <CommentForm {...form.formProps} />
                        )}
                    </div>
                </div>
            )}
        </Card>
    );
}
