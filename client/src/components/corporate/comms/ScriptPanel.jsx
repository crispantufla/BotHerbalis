import React from 'react';
import { Bot, Trash2, Rocket, ClipboardList } from 'lucide-react';
import { Button, IconButton, Card, Badge, EmptyState, cn } from '../../ui';

// Drawer derecho: contexto IA (resumen) + script sugerido (steps clickeables)
// + botones de completion manual (con/sin enviar mensaje al cliente).
//
// Props:
//   onClose() — cerrar el drawer
//   summary {text, generating}, onGenerateSummary, onClearSummary
//   scriptFlow (mapa stepKey → {response}), assignedScript (string como "v3")
//   onPickScriptStep(stepKey, scriptResponse)
//   onManualComplete(silent) — silent=false envía confirmación, silent=true solo registra
//   canSummarize — false cuando aún no hay mensajes en el chat
export default function ScriptPanel({
    onClose,
    summary,
    onGenerateSummary,
    onClearSummary,
    canSummarize,
    scriptFlow,
    assignedScript,
    formatScriptMessage,
    onPickScriptStep,
    onManualComplete,
}) {
    return (
        <div className="w-full md:w-[340px] flex-shrink-0 border-l border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 flex flex-col z-30 md:relative absolute right-0 top-0 bottom-0 overflow-hidden animate-fade-in shadow-elevated">
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center bg-white dark:bg-slate-800 flex-shrink-0">
                <h3 className="font-semibold text-slate-900 dark:text-slate-100 text-sm flex items-center gap-2">
                    <Bot className="w-4 h-4 text-accent-600 dark:text-accent-400" aria-hidden="true" />
                    Asistente IA
                </h3>
                <IconButton label="Cerrar panel" variant="ghost" size="sm" onClick={onClose}>
                    <span aria-hidden="true">✕</span>
                </IconButton>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 flex flex-col gap-5">
                {/* Contexto IA / Resumen */}
                <Card padding="md">
                    <div className="flex justify-between items-center mb-2">
                        <h4 className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                            Contexto IA
                        </h4>
                        <Button
                            size="sm"
                            variant="subtle"
                            loading={summary.generating}
                            disabled={!canSummarize}
                            onClick={onGenerateSummary}
                        >
                            {summary.generating ? 'Generando…' : 'Resumir chat'}
                        </Button>
                    </div>
                    <div className="min-h-[64px] relative">
                        {summary.text ? (
                            <>
                                <p className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed pr-7">
                                    {summary.text}
                                </p>
                                <IconButton
                                    label="Borrar resumen"
                                    icon={Trash2}
                                    variant="ghost"
                                    size="sm"
                                    onClick={onClearSummary}
                                    className="absolute top-0 right-0"
                                />
                            </>
                        ) : (
                            <p className="text-xs text-slate-500 dark:text-slate-400 italic text-center px-2">
                                Analiza la intención de compra y el sentimiento del cliente.
                            </p>
                        )}
                    </div>
                </Card>

                {/* Steps del guión */}
                <div>
                    <div className="flex items-center justify-between mb-2 px-1">
                        <h4 className="text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                            Guión sugerido
                        </h4>
                        <Badge tone="accent" size="sm">{(assignedScript || 'v7').toUpperCase()}</Badge>
                    </div>

                    {Object.keys(scriptFlow).length > 0 ? (
                        <div className="space-y-2">
                            {Object.entries(scriptFlow).map(([stepKey, step]) => {
                                if (!step?.response) return null;
                                return (
                                    <button
                                        key={stepKey}
                                        type="button"
                                        onClick={() => onPickScriptStep(stepKey, step.response)}
                                        className={cn(
                                            'w-full text-left p-3 rounded-control border border-slate-200 dark:border-slate-700',
                                            'bg-white dark:bg-slate-800',
                                            'hover:border-accent-300 dark:hover:border-accent-700 hover:shadow-card-hover',
                                            'transition-all duration-150',
                                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
                                            'group'
                                        )}
                                    >
                                        <div className="flex items-center justify-between mb-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide group-hover:text-accent-600 dark:group-hover:text-accent-400 transition-colors">
                                            <span>{stepKey.replace(/_/g, ' ')}</span>
                                            <span className="opacity-0 group-hover:opacity-100 transition-opacity">Insertar +</span>
                                        </div>
                                        <p className="text-xs text-slate-700 dark:text-slate-200 line-clamp-3 leading-relaxed">
                                            {formatScriptMessage(step.response)}
                                        </p>
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="text-xs text-slate-500 dark:text-slate-400 italic text-center p-4 bg-white dark:bg-slate-800 rounded-control border border-slate-200 dark:border-slate-700">
                            No hay módulos de guión en este flow.
                        </p>
                    )}
                </div>

                {/* Manual completion */}
                <div className="flex flex-col gap-2 pb-2">
                    <button
                        type="button"
                        onClick={() => onManualComplete(false)}
                        className="w-full text-left p-3 rounded-control border-2 border-dashed border-success-300 bg-success-50/60 dark:bg-success-900/15 hover:bg-success-100/80 dark:hover:bg-success-900/30 hover:border-success-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-success-500 group"
                    >
                        <div className="flex items-center justify-between mb-1 text-[11px] font-medium text-success-700 dark:text-success-500 uppercase tracking-wide">
                            <span className="flex items-center gap-1.5">
                                <Rocket className="w-3 h-3" aria-hidden="true" />
                                Pedido ingresado
                            </span>
                            <span className="opacity-0 group-hover:opacity-100 transition-opacity">Confirmar</span>
                        </div>
                        <p className="text-xs text-success-700 dark:text-success-500/80 leading-snug">
                            Envía la confirmación final y registra el pedido en Ventas.
                        </p>
                    </button>
                    <button
                        type="button"
                        onClick={() => onManualComplete(true)}
                        className="w-full text-left p-3 rounded-control border-2 border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-800/60 hover:bg-slate-100/80 dark:hover:bg-slate-800 hover:border-slate-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 group"
                    >
                        <div className="flex items-center justify-between mb-1 text-[11px] font-medium text-slate-600 dark:text-slate-400 uppercase tracking-wide">
                            <span className="flex items-center gap-1.5">
                                <ClipboardList className="w-3 h-3" aria-hidden="true" />
                                Solo registrar
                            </span>
                            <span className="opacity-0 group-hover:opacity-100 transition-opacity">Sin mensaje</span>
                        </div>
                        <p className="text-xs text-slate-600 dark:text-slate-400 leading-snug">
                            Registra la venta sin enviar confirmación al cliente.
                        </p>
                    </button>
                </div>
            </div>
        </div>
    );
}
