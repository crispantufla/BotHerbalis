import React, { useState, useEffect } from 'react';
import api from '../../../config/axios';
import { useSocket } from '../../../context/SocketContext';
import { useToast } from '../../ui/Toast';
import PriceEditor from '../../PriceEditor';

const IconsV3 = {
    Script: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>,
    Sparkles: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
};

const ScriptViewV3 = () => {
    const { socket } = useSocket();
    const { toast } = useToast();
    const [activeScript, setActiveScript] = useState('v1');
    const [scriptStats, setScriptStats] = useState({});
    const [switchingScript, setSwitchingScript] = useState(false);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const scriptRes = await api.get('/api/script/active');
                if (scriptRes.data.active) setActiveScript(scriptRes.data.active);
                if (scriptRes.data.stats) setScriptStats(scriptRes.data.stats);
            } catch (e) { console.error("Error loading script info:", e); }
        };
        fetchData();
    }, []);

    useEffect(() => {
        if (!socket) return;
        const handler = (data) => { if (data.active) setActiveScript(data.active); };
        socket.on('script_changed', handler);
        return () => socket.off('script_changed', handler);
    }, [socket]);

    const handleSwitchScript = async (scriptKey) => {
        if (scriptKey === activeScript || switchingScript) return;
        setSwitchingScript(true);
        try {
            await api.post('/api/script/switch', { script: scriptKey });
            setActiveScript(scriptKey);
            toast.success(`Arquitectura de IA migrada: El bot ahora usa el flujo ${scriptKey.toUpperCase()}.`);
        } catch (e) { toast.error('Error inyectando el guión'); }
        setSwitchingScript(false);
    };

    return (
        <div className="w-full max-w-7xl mx-auto flex flex-col relative z-10 animate-fade-in pb-10">

            <div className="flex flex-col gap-1 items-start justify-center pt-2 mb-8">
                <h1 className="text-3xl lg:text-4xl font-black text-slate-800 tracking-tight">
                    Comportamiento & <span className="text-blue-600">Costos</span>
                </h1>
                <p className="text-slate-500 font-medium text-sm lg:text-base">Manejo de arquitecturas narrativas y calculador global de variables (precios).</p>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">

                {/* 1. Editor de Variables Globales (Lista de Precios) - Enlazado al PriceEditor Base pero envuelto en V3 UI */}
                <div className="bg-white/70 backdrop-blur-xl border border-slate-200/60 shadow-sm rounded-[2rem] overflow-hidden relative">
                    <div className="p-8 border-b border-slate-100 flex items-center gap-4 bg-slate-50/50">
                        <div className="w-12 h-12 rounded-2xl bg-slate-100 text-slate-600 flex items-center justify-center">
                            <IconsV3.Script />
                        </div>
                        <div>
                            <h3 className="font-extrabold text-slate-800 text-lg">Parámetros Inyectables</h3>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Precios Base y Modificables</p>
                        </div>
                    </div>
                    {/* Contenedor adaptado para el padding robusto del componente heredado */}
                    <div className="pb-8 overflow-hidden transform scale-[0.95] origin-top">
                        <PriceEditor />
                    </div>
                </div>

                {/* 2. A/B Testing Switcher Re-Engineered */}
                <div className="bg-white/70 backdrop-blur-xl border border-slate-200/60 shadow-sm rounded-[2rem] p-8 relative flex flex-col">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/10 blur-[60px] rounded-full pointer-events-none"></div>

                    <div className="flex items-center gap-4 mb-8">
                        <div className="w-12 h-12 rounded-2xl bg-indigo-50 border border-indigo-100 text-indigo-600 flex items-center justify-center">
                            <IconsV3.Sparkles />
                        </div>
                        <div>
                            <h3 className="font-extrabold text-slate-800 text-lg">Motores de Conversación</h3>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Scripts y Experimentos</p>
                        </div>
                    </div>

                    <div className="flex-1 space-y-4">
                        {[
                            { id: 'v3', name: 'Arquitectura V3 Clásica', desc: 'Narrativa estructurada. Respetuosa, concisa, profesional.', badge: 'blue' },
                            { id: 'v4', name: 'Arquitectura V4 Emocional', desc: 'Impulso psicológico. Miedo transmutado y urgencia implícita.', badge: 'purple' },
                            { id: 'rotacion', name: 'A/B Tracker (Ciega)', desc: 'Motor de ruleta. Reparte tráfico entre ambas variables 50/50.', badge: 'emerald' }
                        ].map(script => (
                            <div
                                key={script.id}
                                onClick={() => handleSwitchScript(script.id)}
                                className={`group p-6 rounded-2xl border-2 cursor-pointer transition-all duration-300 relative overflow-hidden flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${activeScript === script.id
                                        ? `bg-white border-${script.badge}-500 shadow-md shadow-${script.badge}-500/10`
                                        : 'bg-slate-50/50 border-slate-200 hover:bg-white hover:border-slate-300'
                                    }`}
                            >
                                {activeScript === script.id && (
                                    <div className={`absolute top-0 right-0 w-16 h-16 bg-${script.badge}-500/10 rounded-bl-[4rem]`}></div>
                                )}

                                <div className="relative z-10 flex-1">
                                    <div className="flex items-center gap-3">
                                        <div className={`w-3 h-3 rounded-full ${activeScript === script.id ? `bg-${script.badge}-500 shadow-[0_0_10px_currentColor] animate-pulse` : 'bg-slate-300'}`}></div>
                                        <h4 className={`font-extrabold text-base ${activeScript === script.id ? `text-${script.badge}-700` : 'text-slate-800'}`}>
                                            {script.name}
                                        </h4>
                                    </div>
                                    <p className="text-sm font-medium text-slate-500 mt-2 ml-6 pr-4">
                                        {script.desc}
                                    </p>
                                </div>

                                <div className="relative z-10 shrink-0 ml-6 sm:ml-0 flex flex-col items-start sm:items-end">
                                    {activeScript === script.id && (
                                        <span className={`text-[10px] font-black uppercase tracking-widest text-${script.badge}-600 bg-${script.badge}-50 px-3 py-1 rounded-full mb-2 border border-${script.badge}-100 w-fit`}>
                                            Activo
                                        </span>
                                    )}
                                    {script.stats && script.id !== 'rotacion' && (
                                        <div className="text-right">
                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Performance</p>
                                            <p className={`font-mono text-xl font-black ${activeScript === script.id ? `text-${script.badge}-600` : 'text-slate-700'}`}>
                                                {script.stats.started > 0 ? Math.round((script.stats.completed / script.stats.started) * 100) : 0}%
                                                <span className="text-sm text-slate-400 font-medium ml-1 block mt-[-4px]">({script.stats.completed}/{script.stats.started})</span>
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

            </div>
        </div>
    );
};

export default ScriptViewV3;
