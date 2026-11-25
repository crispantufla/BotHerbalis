import React, { useState, useRef, useEffect, useCallback, useId } from 'react';
import { Bot, Play, Pause, Reply, Trash2, FileText, Type, ShoppingCart, ChevronLeft, MoreVertical } from 'lucide-react';
import { IconButton, Button, Card, Badge, cn } from '../../ui';

// Cierra un desplegable con Escape o al tocar fuera de `containerRef`.
// `close` recibe el motivo ('escape' | 'outside') y tiene que ser estable.
function useDismiss(open, containerRef, close) {
    useEffect(() => {
        if (!open) return undefined;
        const onPointer = (e) => {
            if (!containerRef.current?.contains(e.target)) close('outside');
        };
        const onKey = (e) => {
            if (e.key === 'Escape') close('escape');
        };
        document.addEventListener('pointerdown', onPointer);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onPointer);
            document.removeEventListener('keydown', onKey);
        };
    }, [open, containerRef, close]);
}

function BotStatus({ paused, className }) {
    return (
        <p className={cn('text-[11px] font-medium items-center gap-1.5 whitespace-nowrap', className)}>
            <span
                aria-hidden="true"
                className={cn(
                    'w-1.5 h-1.5 rounded-full flex-shrink-0',
                    paused ? 'bg-danger-500 animate-pulse motion-reduce:animate-none' : 'bg-success-500'
                )}
            />
            <span className={paused
                ? 'text-danger-600 dark:text-danger-500'
                : 'text-success-600 dark:text-success-500'
            }>
                {paused ? 'Auto-bot pausado' : 'Auto-bot activo'}
            </span>
        </p>
    );
}

function MenuItem({ icon: Icon, danger = false, children, ...rest }) {
    return (
        <button
            type="button"
            role="menuitem"
            className={cn(
                'w-full flex items-center gap-3 px-3 min-h-[2.75rem] rounded-control text-sm text-left',
                'transition-colors duration-150',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                danger
                    ? 'text-danger-600 dark:text-danger-500 hover:bg-danger-50 dark:hover:bg-danger-900/30'
                    : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700'
            )}
            {...rest}
        >
            <Icon className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
            <span className="flex-1 min-w-0">{children}</span>
        </button>
    );
}

// Encabezado del chat abierto: contacto, estado del bot y las acciones (compras,
// reiniciar, pausar, tamaño de letra, panel de guion y resumen).
//
// Por debajo de `md` no entran 7 botones al lado del nombre: quedan a la vista
// Retomar y Pausar/Reactivar, el resto va al menú "Más" y el estado del bot baja
// a una línea propia. De `md` para arriba todo sigue en una sola fila.
export default function ChatHeader({
    chat, globalPause, chatFontSize, onChatFontSizeChange, summarizing,
    onBack, onToggleOrders, onClearChat, onToggleBot, onToggleScriptPanel, onSummarize,
    onResumeChat, resuming = false,
}) {
    const [showFontSlider, setShowFontSlider] = useState(false);
    const [showMenu, setShowMenu] = useState(false);
    const fontRef = useRef(null);
    const menuWrapRef = useRef(null);
    const menuRef = useRef(null);
    const menuButtonRef = useRef(null);
    const menuId = useId();

    const closeFontSlider = useCallback(() => setShowFontSlider(false), []);
    const closeMenu = useCallback((reason) => {
        setShowMenu(false);
        if (reason === 'escape') menuButtonRef.current?.focus();
    }, []);
    useDismiss(showFontSlider, fontRef, closeFontSlider);
    useDismiss(showMenu, menuWrapRef, closeMenu);

    // Al abrir el menú el foco pasa al primer ítem (teclado y lector de pantalla).
    useEffect(() => {
        if (showMenu) menuRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    }, [showMenu]);

    const handleMenuKeyDown = (e) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        const items = Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') || []);
        if (items.length === 0) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement);
        let next = 0;
        if (e.key === 'ArrowDown') next = (i + 1) % items.length;
        else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
        else if (e.key === 'End') next = items.length - 1;
        items[next].focus();
    };

    const pickFromMenu = (action) => () => {
        setShowMenu(false);
        action();
    };

    return (
        <header className="relative flex-shrink-0 min-h-[4.5rem] border-b border-slate-200 dark:border-slate-800 flex flex-wrap md:flex-nowrap items-center justify-between px-3 sm:px-5 bg-white dark:bg-slate-800 z-20 gap-x-2 gap-y-1 py-2">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
                <IconButton
                    label="Volver a contactos"
                    icon={ChevronLeft}
                    variant="ghost"
                    size="sm"
                    onClick={onBack}
                    className="md:hidden flex-shrink-0"
                />

                <div className="w-8 h-8 md:w-10 md:h-10 rounded-control bg-accent-600 text-white flex items-center justify-center font-semibold text-xs md:text-sm flex-shrink-0">
                    {(chat.name || chat.id?.split('@')[0] || '??').toString().substring(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0 flex flex-col justify-center">
                    <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400 leading-none mb-0.5 tabular-nums truncate">
                        +{chat.id?.split('@')[0]}
                    </span>
                    <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2 flex-wrap min-w-0">
                        <h2 className="font-semibold text-slate-900 dark:text-slate-100 text-sm sm:text-base truncate max-w-[140px] sm:max-w-xs">
                            {chat.name || 'Desconocido'}
                        </h2>
                        {chat.assignedScript && (
                            <Badge tone="accent" size="sm" className="hidden md:inline-flex">Flow: {chat.assignedScript}</Badge>
                        )}
                    </div>
                    <BotStatus paused={chat.isPaused} className="hidden md:flex mt-0.5" />
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
                        className="hidden md:inline-flex"
                    />
                )}
                <IconButton
                    label="Reiniciar historial"
                    icon={Trash2}
                    variant="danger"
                    size="sm"
                    onClick={onClearChat}
                    className="hidden md:inline-flex"
                />
                {chat.isPaused && (
                    <Button
                        variant="subtle"
                        size="sm"
                        leftIcon={Reply}
                        loading={resuming}
                        onClick={onResumeChat}
                        aria-label="Retomar"
                        title="Despausa y hace que el bot conteste lo último que escribió el cliente"
                        className="px-2 sm:px-3 min-w-[2.5rem] min-h-[2.5rem] md:min-w-0 md:min-h-0"
                    >
                        <span className="hidden sm:inline">Retomar</span>
                    </Button>
                )}
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
                {/* En móvil el botón no se ve (el regulador se abre desde "Más") y el
                    contenedor no ocupa lugar: el regulador se ancla al encabezado. */}
                <div ref={fontRef} className="contents md:block md:relative">
                    <IconButton
                        label="Tamaño de letra"
                        icon={Type}
                        variant="ghost"
                        size="sm"
                        aria-expanded={showFontSlider}
                        onClick={() => setShowFontSlider(v => !v)}
                        className="hidden md:inline-flex"
                    />
                    {showFontSlider && (
                        <Card padding="md" className="absolute top-full right-3 mt-1 md:top-12 md:right-0 md:mt-0 w-60 z-50 animate-fade-in motion-reduce:animate-none">
                            <div className="flex justify-between items-center mb-2">
                                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Tamaño letra</span>
                                <span className="text-sm font-semibold text-accent-600 dark:text-accent-400 tabular-nums">{chatFontSize}px</span>
                            </div>
                            <input
                                type="range" min="12" max="28" step="1"
                                value={chatFontSize}
                                onChange={(e) => onChatFontSizeChange(parseInt(e.target.value, 10))}
                                aria-label="Tamaño de letra del chat"
                                className="w-full h-2 bg-slate-200 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-accent-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-800"
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
                    className="hidden md:inline-flex !bg-accent-50 dark:!bg-accent-900/30 !text-accent-600 dark:!text-accent-400"
                />
                <IconButton
                    label="Resumir conversación"
                    icon={Bot}
                    variant="subtle"
                    size="sm"
                    onClick={onSummarize}
                    disabled={summarizing}
                    className="hidden md:inline-flex !bg-info-50 dark:!bg-info-900/30 !text-info-600 dark:!text-info-500"
                />

                {/* Menú "Más": las acciones secundarias, solo por debajo de md. */}
                <div ref={menuWrapRef} className="relative md:hidden">
                    <IconButton
                        ref={menuButtonRef}
                        label="Más acciones"
                        icon={MoreVertical}
                        variant="ghost"
                        size="sm"
                        aria-haspopup="menu"
                        aria-expanded={showMenu}
                        aria-controls={showMenu ? menuId : undefined}
                        onClick={() => setShowMenu(v => !v)}
                    />
                    {showMenu && (
                        <div
                            ref={menuRef}
                            id={menuId}
                            role="menu"
                            aria-label="Más acciones del chat"
                            onKeyDown={handleMenuKeyDown}
                            className="absolute top-full right-0 mt-1 w-60 max-w-[calc(100vw-1.5rem)] z-50 p-1 rounded-card border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-elevated animate-fade-in motion-reduce:animate-none"
                        >
                            {chat.hasBought && (
                                <MenuItem icon={ShoppingCart} onClick={pickFromMenu(onToggleOrders)}>
                                    Registro de compras
                                </MenuItem>
                            )}
                            <MenuItem icon={FileText} onClick={pickFromMenu(onToggleScriptPanel)}>
                                Panel de guión
                            </MenuItem>
                            <MenuItem icon={Bot} disabled={summarizing} onClick={pickFromMenu(onSummarize)}>
                                {summarizing ? 'Resumiendo…' : 'Resumir conversación'}
                            </MenuItem>
                            <MenuItem icon={Type} onClick={pickFromMenu(() => setShowFontSlider(true))}>
                                Tamaño de letra
                            </MenuItem>
                            <div role="separator" className="my-1 border-t border-slate-200 dark:border-slate-700" />
                            <MenuItem icon={Trash2} danger onClick={pickFromMenu(onClearChat)}>
                                Reiniciar historial
                            </MenuItem>
                        </div>
                    )}
                </div>
            </div>

            {/* Estado del bot en su propia línea (solo móvil). */}
            <div className="md:hidden basis-full flex items-center gap-2 min-w-0 pl-1">
                <BotStatus paused={chat.isPaused} className="flex" />
                {chat.assignedScript && (
                    <Badge tone="accent" size="sm" className="min-w-0">
                        <span className="truncate">Flow: {chat.assignedScript}</span>
                    </Badge>
                )}
            </div>
        </header>
    );
}
