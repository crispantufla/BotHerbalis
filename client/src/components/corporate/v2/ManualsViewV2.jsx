import React, { useState } from 'react';
import { BookOpen, ChevronRight, AlertTriangle, CheckCircle, Hand, List, Sparkles, Terminal, HelpCircle, Zap } from 'lucide-react';

// ─── Manual data ────────────────────────────────────────────────
const MANUALS = [
    {
        id: 'alertas',
        title: 'Sistema de Alertas',
        description: 'Como gestionar pedidos, confirmar ventas y atender varios clientes al mismo tiempo.',
        icon: AlertTriangle,
        color: 'indigo',
        sections: [
            {
                title: 'Como funciona',
                icon: HelpCircle,
                content: `Cuando un cliente completa un pedido, el bot te envia una **alerta** por WhatsApp con todos los datos. Cada alerta tiene un **numero** (#1, #2, #3...) que la identifica.\n\nSi llegan varios pedidos al mismo tiempo, cada uno tiene su propio numero y podes responder a cada uno por separado.`
            },
            {
                title: 'Formato de la alerta',
                icon: BookOpen,
                content: `Cuando llega un pedido, recibis un mensaje asi:`,
                codeBlock: `ALERTA #1 (2 activas)\n\nMotivo: Pedido Requiere Aprobacion\nCliente: Juan (5491155551234)\nProducto: Kit Herbalis (30 dias) - $15000\nDireccion: Av. Corrientes 1234, CABA, CP 1043\n\nDetalles: Cliente confirmo pedido\n\nResponde: "1 ok" para confirmar, "1 me encargo" para intervenir`
            },
            {
                title: 'Confirmar un pedido',
                icon: CheckCircle,
                content: `Para aprobar el pedido de un cliente especifico, manda el **numero de alerta + ok**.`,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['1 ok', 'Confirma el pedido de la alerta #1'],
                        ['2 ok', 'Confirma el pedido de la alerta #2'],
                        ['1 dale', 'Igual que "1 ok"'],
                        ['1 si', 'Igual que "1 ok"'],
                        ['1 confirmar', 'Igual que "1 ok"'],
                    ]
                },
                extra: `Si solo hay **una alerta activa**, podes escribir simplemente **ok**, **dale**, **si** o **confirmar** sin numero.`
            },
            {
                title: 'Tomar control ("Me encargo")',
                icon: Hand,
                content: `Si necesitas hablarle personalmente al cliente y que el bot no interfiera:`,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['1 me encargo', 'Pausa el bot para el cliente #1 y lo atendes vos'],
                        ['2 me encargo', 'Pausa el bot para el cliente #2'],
                        ['me encargo', 'Pausa el bot para la alerta mas reciente'],
                        ['1 intervenir', 'Igual que "1 me encargo"'],
                    ]
                },
                extra: `Cuando usas "me encargo", el bot se **pausa** para ese cliente. Podes hablarle directamente sin que el bot responda.`
            },
            {
                title: 'Ver alertas activas',
                icon: List,
                content: `Manda **!alertas** para ver la lista de alertas pendientes.`,
                codeBlock: `Alertas activas (3):\n\n#1 -- Juan (5491155551234) -- Kit Herbalis -- hace 2 min\n#2 -- Maria (5491166662345) -- Pack Premium -- hace 30 seg\n#3 -- Carlos (5491177773456) -- Kit Basico -- hace 10 seg\n\nResponde con el # + comando, ej: "1 ok", "2 me encargo"`
            },
            {
                title: 'Instrucciones por IA',
                icon: Sparkles,
                content: `Si queres que el bot le mande un mensaje especifico a un cliente (generado por IA):`,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['1 decile que el envio tarda 48hs', 'La IA genera un mensaje para el cliente #1'],
                        ['2 preguntale si prefiere otro producto', 'La IA genera un mensaje para el cliente #2'],
                        ['decile que lo llamamos manana', 'Manda al cliente de la alerta mas reciente'],
                    ]
                },
            },
            {
                title: 'Otros comandos',
                icon: Terminal,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['!ayuda', 'Muestra el menu de comandos'],
                        ['!resumen', 'Reporte de ventas del dia'],
                        ['!saltear 5491155551234', 'Fuerza a un usuario al paso de datos'],
                    ]
                },
            },
            {
                title: 'Ejemplo: 2 alertas al mismo tiempo',
                icon: Zap,
                steps: [
                    { label: 'Llega alerta #1', detail: 'Juan (5491155551234) — Kit Herbalis (30 dias) - $15000' },
                    { label: 'Llega alerta #1 (nueva)', detail: 'Maria (5491166662345) — Pack Premium (60 dias) - $25000. Maria es ahora #1 (mas reciente), Juan paso a #2.' },
                    { label: 'Confirmas a Juan', detail: 'Mandas: 2 ok' },
                    { label: 'Tomas control de Maria', detail: 'Mandas: 1 me encargo' },
                    { label: 'Verificas la cola', detail: 'Mandas: !alertas — "No hay alertas activas"' },
                ],
            },
            {
                title: 'Reglas importantes',
                icon: AlertTriangle,
                bullets: [
                    'El numero de alerta puede cambiar cuando se agrega o elimina una alerta. Siempre usa !alertas si no estas seguro.',
                    'Sin numero = la mas reciente. Si escribis solo "ok" sin numero, aplica a la alerta mas nueva.',
                    '"Me encargo" pausa el bot. El cliente no va a recibir respuestas automaticas hasta que el bot se reactive.',
                    'Podes mandar audios. El bot los transcribe y los interpreta como texto.',
                    'Maximo 50 alertas. Las mas viejas se eliminan automaticamente.',
                ],
            },
        ],
        quickRef: [
            { cmd: '!alertas', desc: 'Ver cola de alertas' },
            { cmd: '1 ok', desc: 'Confirmar pedido #1' },
            { cmd: '2 me encargo', desc: 'Tomar control de #2' },
            { cmd: '1 [instruccion]', desc: 'Mandar mensaje IA a #1' },
            { cmd: 'ok', desc: 'Confirmar la mas reciente' },
            { cmd: '!ayuda', desc: 'Menu de comandos' },
            { cmd: '!resumen', desc: 'Reporte del dia' },
        ],
    },
];

// ─── Sub-components ─────────────────────────────────────────────

const Bold = ({ text }) => {
    if (!text) return null;
    const parts = text.split(/\*\*(.*?)\*\*/g);
    return parts.map((part, i) => i % 2 === 1 ? <strong key={i} className="font-semibold text-slate-800 dark:text-white">{part}</strong> : part);
};

const SectionCard = ({ section, index }) => {
    const Icon = section.icon;
    return (
        <div className="bg-white/70 dark:bg-slate-800/70 backdrop-blur-sm rounded-2xl border border-slate-200/60 dark:border-slate-700/50 p-6 transition-all duration-200 hover:shadow-md hover:border-indigo-200 dark:hover:border-indigo-800/50">
            <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-900/30 flex items-center justify-center">
                    <Icon className="w-4 h-4 text-indigo-500" />
                </div>
                <h3 className="text-lg font-bold text-slate-800 dark:text-white">{section.title}</h3>
            </div>

            {section.content && (
                <p className="text-sm text-slate-600 dark:text-slate-300 mb-4 leading-relaxed whitespace-pre-line">
                    <Bold text={section.content} />
                </p>
            )}

            {section.codeBlock && (
                <pre className="bg-slate-900 text-green-400 text-xs rounded-xl p-4 mb-4 overflow-x-auto font-mono leading-relaxed">
                    {section.codeBlock}
                </pre>
            )}

            {section.table && (
                <div className="overflow-x-auto mb-4">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-slate-200 dark:border-slate-700">
                                {section.table.headers.map((h, i) => (
                                    <th key={i} className="text-left py-2 px-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {section.table.rows.map((row, ri) => (
                                <tr key={ri} className="border-b border-slate-100 dark:border-slate-700/50 last:border-0">
                                    <td className="py-2.5 px-3">
                                        <code className="bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 px-2 py-0.5 rounded text-xs font-mono">{row[0]}</code>
                                    </td>
                                    <td className="py-2.5 px-3 text-slate-600 dark:text-slate-300">{row[1]}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {section.extra && (
                <p className="text-sm text-slate-500 dark:text-slate-400 italic mt-2">
                    <Bold text={section.extra} />
                </p>
            )}

            {section.steps && (
                <div className="space-y-3">
                    {section.steps.map((step, si) => (
                        <div key={si} className="flex gap-3">
                            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-indigo-100 dark:bg-indigo-900/40 flex items-center justify-center">
                                <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400">{si + 1}</span>
                            </div>
                            <div>
                                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{step.label}</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{step.detail}</p>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {section.bullets && (
                <ul className="space-y-2">
                    {section.bullets.map((b, bi) => (
                        <li key={bi} className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
                            <ChevronRight className="w-4 h-4 text-indigo-400 flex-shrink-0 mt-0.5" />
                            <span>{b}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

// ─── Main Component ─────────────────────────────────────────────

const ManualsViewV2 = () => {
    const [activeManual, setActiveManual] = useState(null);

    if (activeManual) {
        const manual = MANUALS.find(m => m.id === activeManual);
        if (!manual) return null;
        const Icon = manual.icon;

        return (
            <div className="p-6 md:p-8 max-w-5xl mx-auto w-full">
                {/* Back button */}
                <button
                    onClick={() => setActiveManual(null)}
                    className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors mb-6"
                >
                    <ChevronRight className="w-4 h-4 rotate-180" />
                    Volver a Manuales
                </button>

                {/* Header */}
                <div className="flex items-center gap-4 mb-8">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                        <Icon className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-extrabold text-slate-800 dark:text-white tracking-tight">{manual.title}</h1>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{manual.description}</p>
                    </div>
                </div>

                {/* Quick reference card */}
                {manual.quickRef && (
                    <div className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl p-6 mb-8 text-white shadow-lg shadow-indigo-500/20">
                        <h2 className="text-sm font-bold uppercase tracking-wider mb-4 opacity-80">Referencia rapida</h2>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                            {manual.quickRef.map((ref, i) => (
                                <div key={i} className="flex items-center gap-2">
                                    <code className="bg-white/20 backdrop-blur-sm px-2 py-0.5 rounded text-xs font-mono flex-shrink-0">{ref.cmd}</code>
                                    <span className="text-xs opacity-80">{ref.desc}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Sections */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {manual.sections.map((section, i) => (
                        <SectionCard key={i} section={section} index={i} />
                    ))}
                </div>
            </div>
        );
    }

    // ─── Manual list view ───────────────────────────────────────
    return (
        <div className="p-6 md:p-8 max-w-5xl mx-auto w-full">
            <div className="mb-8">
                <h1 className="text-2xl font-extrabold text-slate-800 dark:text-white tracking-tight">Manuales</h1>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Guias de uso del sistema para el equipo de ventas.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {MANUALS.map((manual) => {
                    const Icon = manual.icon;
                    return (
                        <button
                            key={manual.id}
                            onClick={() => setActiveManual(manual.id)}
                            className="group text-left bg-white/70 dark:bg-slate-800/70 backdrop-blur-sm rounded-2xl border border-slate-200/60 dark:border-slate-700/50 p-6 transition-all duration-300 hover:shadow-lg hover:border-indigo-300 dark:hover:border-indigo-700 hover:-translate-y-0.5"
                        >
                            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mb-4 shadow-md shadow-indigo-500/20 group-hover:scale-105 transition-transform">
                                <Icon className="w-6 h-6 text-white" />
                            </div>
                            <h3 className="text-lg font-bold text-slate-800 dark:text-white mb-1">{manual.title}</h3>
                            <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">{manual.description}</p>
                            <div className="flex items-center gap-1 text-indigo-500 text-sm font-medium mt-4 group-hover:gap-2 transition-all">
                                Ver manual <ChevronRight className="w-4 h-4" />
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
};

export default ManualsViewV2;
