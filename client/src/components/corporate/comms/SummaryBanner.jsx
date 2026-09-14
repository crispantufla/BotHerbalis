import React from 'react';
import { Bot } from 'lucide-react';
import { IconButton } from '../../ui';

// Banner con el resumen de la conversación que generó la IA.
export default function SummaryBanner({ text, onClose }) {
    if (!text) return null;
    return (
        <div className="mx-3 sm:mx-5 mt-3 p-3 rounded-control bg-info-50 dark:bg-info-900/20 border border-info-100 dark:border-info-900/40 text-sm relative flex-shrink-0">
            <IconButton
                label="Cerrar resumen"
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="absolute top-1 right-1"
            >
                <span aria-hidden="true">✕</span>
            </IconButton>
            <h4 className="font-semibold flex items-center gap-2 mb-1.5 text-info-700 dark:text-info-500 text-xs uppercase tracking-wide">
                <Bot className="w-3.5 h-3.5" aria-hidden="true" />
                Resumen de la conversación
            </h4>
            <p className="whitespace-pre-wrap text-slate-700 dark:text-slate-200 text-xs leading-relaxed pr-6">
                {text}
            </p>
        </div>
    );
}
