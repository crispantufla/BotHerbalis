import React, { useState } from 'react';
import { Bot, Play, Pause, Trash2, FileText, Type, ShoppingCart, ChevronLeft } from 'lucide-react';
import { IconButton, Card, Badge, cn } from '../../ui';

// Encabezado del chat abierto: contacto, estado del bot y las acciones (compras,
// reiniciar, pausar, tamaño de letra, panel de guion y resumen).
export default function ChatHeader({
    chat, globalPause, chatFontSize, onChatFontSizeChange, summarizing,
    onBack, onToggleOrders, onClearChat, onToggleBot, onToggleScriptPanel, onSummarize,
}) {
    const [showFontSlider, setShowFontSlider] = useState(false);

    return (
        <header className="flex-shrink-0 min-h-[4.5rem] border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-3 sm:px-5 bg-white dark:bg-slate-800 z-20 gap-2 py-2">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
                <IconButton
                    label="Volver a contactos"
                    icon={ChevronLeft}
                    variant="ghost"
                    size="sm"
                    onClick={onBack}
                    className="md:hidden"
                />

                <div className="w-10 h-10 rounded-control bg-accent-600 text-white flex items-center justify-center font-semibold text-sm flex-shrink-0">
                    {(chat.name || chat.id?.split('@')[0] || '??').toString().substring(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex flex-col justify-center">
                    <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500 leading-none mb-0.5 tabular-nums">
                        +{chat.id?.split('@')[0]}
                    </span>
                    <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2 flex-wrap">
                        <h2 className="font-semibold text-slate-900 dark:text-slate-100 text-sm sm:text-base truncate max-w-[140px] sm:max-w-xs">
                            {chat.name || 'Desconocido'}
                        </h2>
                        {chat.assignedScript && (
                            <Badge tone="accent" size="sm">Flow: {chat.assignedScript}</Badge>
                        )}
                    </div>
                    <p className="text-[11px] font-medium flex items-center gap-1.5 mt-0.5">
                        <span className={cn(
                            'w-1.5 h-1.5 rounded-full',
                            chat.isPaused
                                ? 'bg-danger-500 animate-pulse'
                                : 'bg-success-500'
                        )} />
                        <span className={chat.isPaused
                            ? 'text-danger-600 dark:text-danger-500'
                            : 'text-success-600 dark:text-success-500'
                        }>
                            {chat.isPaused ? 'Auto-bot pausado' : 'Auto-bot activo'}
                        </span>
                    </p>
                </div>
            </div>

            <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0">
                {chat.hasBought && (
                    <IconButton
                        label="Registro de compras"
                        icon={ShoppingCart}
                        variant="accent"
                        size="sm"
                        onClick={onToggleOrders}
                    />
                )}
                <IconButton
                    label="Reiniciar historial"
                    icon={Trash2}
                    variant="danger"
                    size="sm"
                    onClick={onClearChat}
                />
                <IconButton
                    label={chat.isPaused ? 'Reactivar bot' : 'Pausar bot'}
                    icon={(globalPause || chat.isPaused) ? Play : Pause}
                    variant="subtle"
                    size="sm"
                    onClick={onToggleBot}
                    className={
                        globalPause || chat.isPaused
                            ? '!bg-success-50 dark:!bg-success-900/30 !text-success-600 dark:!text-success-500'
                            : '!bg-warning-50 dark:!bg-warning-900/30 !text-warning-600 dark:!text-warning-500'
                    }
                />
                <div className="relative">
                    <IconButton
                        label="Tamaño de letra"
                        icon={Type}
                        variant="ghost"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); setShowFontSlider(v => !v); }}
                    />
                    {showFontSlider && (
                        <Card padding="md" className="absolute top-12 right-0 w-60 z-50 animate-fade-in">
                            <div className="flex justify-between items-center mb-2">
                                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Tamaño letra</span>
                                <span className="text-sm font-semibold text-accent-600 dark:text-accent-400 tabular-nums">{chatFontSize}px</span>
                            </div>
                            <input
                                type="range" min="12" max="28" step="1"
                                value={chatFontSize}
                                onChange={(e) => onChatFontSizeChange(parseInt(e.target.value, 10))}
                                aria-label="Tamaño de letra del chat"
                                className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-accent-600"
                            />
                        </Card>
                    )}
                </div>
                <IconButton
                    label="Panel de guión"
                    icon={FileText}
                    variant="subtle"
                    size="sm"
                    onClick={onToggleScriptPanel}
                    className="!bg-accent-50 dark:!bg-accent-900/30 !text-accent-600 dark:!text-accent-400"
                />
                <IconButton
                    label="Resumir conversación"
                    icon={Bot}
                    variant="subtle"
                    size="sm"
                    onClick={onSummarize}
                    disabled={summarizing}
                    className="!bg-info-50 dark:!bg-info-900/30 !text-info-600 dark:!text-info-500"
                />
            </div>
        </header>
    );
}
