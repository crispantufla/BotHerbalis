import React from 'react';
import {
    Send, Sparkles,
} from 'lucide-react';
import { Button, cn } from '../../ui';
import { TYPE_META } from './guionConfig';

export default function CommentForm({
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
