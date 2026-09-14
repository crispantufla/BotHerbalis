import React from 'react';
import {
    Trash2, Check, RotateCcw, User, Sparkles, Copy, ThumbsUp,
} from 'lucide-react';
import { Button, IconButton, Badge, cn } from '../../ui';
import { TYPE_META, formatDate } from './guionConfig';

export default function CommentItem({ comment, isNew, actions }) {
    const { currentUserId, isAdmin, onResolve, onDelete, onReact, onCopySuggested } = actions;
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
