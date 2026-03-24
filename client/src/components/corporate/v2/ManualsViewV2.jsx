import React, { useState } from 'react';
import { BookOpen, ChevronRight, AlertTriangle, CheckCircle, Hand, List, Sparkles, Terminal, HelpCircle, Zap, Users, Package, BarChart3, Settings, Send, Shield } from 'lucide-react';

// ─── Manual data ────────────────────────────────────────────────
const MANUALS = [
    {
        id: 'comandos',
        title: 'Comandos WhatsApp',
        description: 'Guia completa para controlar el bot desde WhatsApp. Alertas, pedidos, clientes, tracking, estadisticas y configuracion.',
        icon: Terminal,
        color: 'indigo',
        sections: [
            {
                title: 'Como funciona',
                icon: HelpCircle,
                content: `Podes controlar **todo el bot** desde WhatsApp. Cada comando empieza con **!** y podes mandarlo como texto o audio.\n\nCuando llegan alertas de pedidos, cada una tiene un **numero** (#1, #2, #3...). Para responder a una especifica, ponele el numero adelante: **1 ok**, **2 me encargo**.`
            },
            {
                title: 'Confirmar un pedido',
                icon: CheckCircle,
                content: `Manda el **numero de alerta + ok** para aprobar.`,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['1 ok', 'Confirma el pedido de la alerta #1'],
                        ['2 ok', 'Confirma la alerta #2'],
                        ['1 dale / 1 si', 'Igual que "1 ok"'],
                        ['ok', 'Confirma la alerta mas reciente'],
                    ]
                },
            },
            {
                title: 'Tomar control ("Me encargo")',
                icon: Hand,
                content: `Pausa el bot para un cliente y lo atendes vos directamente.`,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['1 me encargo', 'Pausa el bot para cliente #1'],
                        ['me encargo', 'Pausa la alerta mas reciente'],
                    ]
                },
                extra: `Cuando termines, usa **!despauser [tel]** para reactivar el bot.`
            },
            {
                title: 'Alertas activas',
                icon: List,
                content: `Manda **!alertas** para ver la cola numerada.`,
                codeBlock: `Alertas activas (3):\n\n#1 -- Juan (5491155551234) -- Kit Herbalis -- hace 2 min\n#2 -- Maria (5491166662345) -- Pack Premium -- hace 30 seg\n#3 -- Carlos (5491177773456) -- Kit Basico -- hace 10 seg`
            },
            {
                title: 'Respuestas rapidas contextuales',
                icon: Zap,
                content: `Cada alerta incluye **3 respuestas rapidas** sugeridas segun el contexto. El bot analiza el paso del cliente y su ultimo mensaje para sugerir las mejores respuestas.`,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['1r1', 'Envia respuesta rapida 1 al cliente de alerta #1'],
                        ['1r2', 'Envia respuesta rapida 2 al cliente de alerta #1'],
                        ['2r3', 'Envia respuesta rapida 3 al cliente de alerta #2'],
                        ['r1', 'Envia respuesta rapida 1 a la alerta mas reciente'],
                    ]
                },
                extra: `Las sugerencias cambian segun: **paso del cliente** (datos, precio, confirmacion) y **lo que escribio** (dudas, desconfianza, rechazo).`
            },
            {
                title: 'Instrucciones por IA',
                icon: Sparkles,
                content: `El bot genera un mensaje a partir de tu instruccion y se lo envia al cliente.`,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['1 decile que el envio tarda 48hs', 'Mensaje IA para cliente #1'],
                        ['2 preguntale si prefiere otro', 'Mensaje IA para cliente #2'],
                    ]
                },
            },
            {
                title: 'Gestion de clientes',
                icon: Users,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['!pausados', 'Ver clientes con el bot pausado'],
                        ['!despauser [tel]', 'Reactivar el bot para un cliente'],
                        ['!reset [tel]', 'Reiniciar estado de un cliente'],
                        ['!historial [tel]', 'Resumen IA de la conversacion'],
                        ['!enviar [tel] [msg]', 'Mensaje directo sin IA'],
                    ]
                },
            },
            {
                title: 'Pedidos y tracking',
                icon: Package,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['!pedidos', 'Ultimos 5 pedidos de todos'],
                        ['!pedido [tel]', 'Pedidos de un cliente'],
                        ['!tracking [tel] [cod]', 'Cargar codigo de seguimiento y avisar al cliente'],
                    ]
                },
                extra: `**!tracking** envia automaticamente el codigo al cliente por WhatsApp.`
            },
            {
                title: 'Estado y estadisticas',
                icon: BarChart3,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['!status', 'Conexion, memoria, sesiones, alertas'],
                        ['!stats', 'Ventas del dia, revenue, conversion'],
                        ['!precios', 'Precios actuales de todos los productos'],
                        ['!resumen', 'Reporte diario completo'],
                    ]
                },
            },
            {
                title: 'Analytics y funnel',
                icon: BarChart3,
                content: `Visualiza el embudo de ventas y analiza abandonos con testing A/B automatico.`,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['!funnel', 'Embudo paso a paso con tasas de abandono'],
                        ['!abandonos', 'Motivos de abandono + rendimiento A/B de mensajes de seguimiento'],
                    ]
                },
                extra: `El sistema envia automaticamente mensajes de re-engagement probando diferentes variantes. Con **!abandonos** ves cual funciona mejor.`
            },
            {
                title: 'Configuracion del bot',
                icon: Settings,
                table: {
                    headers: ['Escribis', 'Que hace'],
                    rows: [
                        ['!pausa-global on/off', 'Pausar o reanudar todo el bot'],
                        ['!script', 'Ver script activo y disponibles'],
                        ['!script v3', 'Cambiar a script v3'],
                        ['!admin list', 'Ver numeros que reciben alertas'],
                        ['!admin add [tel]', 'Agregar numero a alertas'],
                        ['!admin remove [tel]', 'Quitar numero de alertas'],
                    ]
                },
            },
            {
                title: 'Ejemplo: 2 alertas + tracking',
                icon: Zap,
                steps: [
                    { label: 'Llegan 2 alertas', detail: 'Juan (#2) y Maria (#1, mas reciente)' },
                    { label: 'Confirmas a Juan', detail: 'Mandas: 2 ok' },
                    { label: 'Tomas control de Maria', detail: 'Mandas: 1 me encargo' },
                    { label: 'Le hablas a Maria directo', detail: 'Conversas por WhatsApp normal' },
                    { label: 'Reactivas el bot', detail: 'Mandas: !despauser 5491166662345' },
                    { label: 'Cargas tracking de Juan', detail: 'Mandas: !tracking 5491155551234 OC123AR' },
                    { label: 'Verificas todo', detail: 'Mandas: !status' },
                ],
            },
            {
                title: 'Reglas importantes',
                icon: AlertTriangle,
                bullets: [
                    'El numero de alerta puede cambiar. Usa !alertas para verificar.',
                    'Sin numero = la mas reciente.',
                    '"Me encargo" pausa el bot. Usa !despauser para reactivar.',
                    'Podes mandar audios. Se transcriben automaticamente.',
                    '!pausa-global detiene el bot para TODOS los clientes.',
                    'Maximo 50 alertas activas.',
                ],
            },
        ],
        quickRef: [
            { cmd: '!alertas', desc: 'Cola de alertas' },
            { cmd: '1 ok', desc: 'Confirmar #1' },
            { cmd: '1 me encargo', desc: 'Tomar control #1' },
            { cmd: '1r1 / 1r2 / 1r3', desc: 'Respuesta rapida a #1' },
            { cmd: '!pausados', desc: 'Clientes pausados' },
            { cmd: '!despauser [tel]', desc: 'Reactivar cliente' },
            { cmd: '!pedidos', desc: 'Ultimos pedidos' },
            { cmd: '!tracking [tel] [cod]', desc: 'Cargar tracking' },
            { cmd: '!funnel', desc: 'Embudo de ventas' },
            { cmd: '!abandonos', desc: 'Abandonos + A/B' },
            { cmd: '!status', desc: 'Estado del bot' },
            { cmd: '!stats', desc: 'Ventas del dia' },
            { cmd: '!precios', desc: 'Ver precios' },
            { cmd: '!pausa-global', desc: 'Pausar todo' },
            { cmd: '!enviar [tel] [msg]', desc: 'Mensaje directo' },
            { cmd: '!historial [tel]', desc: 'Resumen IA' },
            { cmd: '!reset [tel]', desc: 'Reiniciar cliente' },
            { cmd: '!script', desc: 'Ver/cambiar script' },
            { cmd: '!admin list', desc: 'Ver admins' },
            { cmd: '!resumen', desc: 'Reporte diario' },
            { cmd: '!ayuda', desc: 'Menu de comandos' },
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
