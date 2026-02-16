import React, { useState, useEffect } from 'react';
import api from '../../../config/axios';
import ScriptMapView from './ScriptMapView';

import { useToast } from '../../ui/Toast';

const Script = () => {
    const { toast } = useToast();
    const [script, setScript] = useState({ flow: {}, faq: [] });
    const [activeTab, setActiveTab] = useState('flow');
    const [expandedCard, setExpandedCard] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchScript();
    }, []);

    const fetchScript = async () => {
        setLoading(true);
        try {
            const res = await api.get('/api/script');
            setScript(res.data);
        } catch (e) {
            console.error(e);
            toast.error('Error al cargar el guión');
        } finally {
            setLoading(false);
        }
    };

    const saveScript = async () => {
        try {
            // Include basic structure validation if needed
            await api.post('/api/script', script);
            toast.success('Guión guardado correctamente');
        } catch (e) { toast.error('Error al guardar'); }
    };

    const handleUpdate = (newScript) => {
        setScript(newScript);
    };

    const handleFlowChange = (stepKey, field, value) => {
        setScript(prev => ({
            ...prev,
            flow: {
                ...prev.flow,
                [stepKey]: { ...prev.flow[stepKey], [field]: value }
            }
        }));
    };

    const handleFAQChange = (index, field, value) => {
        const newFaq = [...script.faq];
        newFaq[index] = { ...newFaq[index], [field]: value };
        setScript(prev => ({ ...prev, faq: newFaq }));
    };

    const deleteFAQ = (index) => {
        const newFaq = [...script.faq];
        newFaq.splice(index, 1);
        setScript(prev => ({ ...prev, faq: newFaq }));
    };

    const addFAQ = () => {
        setScript(prev => ({
            ...prev,
            faq: [...prev.faq, { keywords: [], response: "Nueva respuesta" }]
        }));
    };

    const SkeletonLoader = () => (
        <div className="space-y-4 animate-pulse">
            {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="bg-white p-5 rounded-lg border border-gray-200 shadow-sm">
                    <div className="flex justify-between items-center">
                        <div className="h-4 bg-gray-200 rounded w-1/3"></div>
                        <div className="flex gap-2">
                            <div className="h-4 bg-gray-200 rounded w-16"></div>
                            <div className="h-4 bg-gray-100 rounded w-4"></div>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <h2 className="text-2xl font-bold text-gray-800 tracking-tight">Editor de Guiones</h2>
                <div className="flex gap-2">
                    <button onClick={fetchScript} className="px-4 py-2 bg-white border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 shadow-sm font-medium transition flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                        Recargar
                    </button>
                    <button onClick={saveScript} className="px-4 py-2 bg-slate-900 text-white rounded-lg hover:bg-black shadow-sm font-bold transition">
                        Guardar Cambios
                    </button>
                </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="border-b flex overflow-x-auto bg-gray-50/50">
                    <button
                        onClick={() => setActiveTab('flow')}
                        className={`px-6 py-4 font-bold text-xs uppercase tracking-wider whitespace-nowrap transition-all ${activeTab === 'flow' ? 'border-b-2 border-blue-600 text-blue-600 bg-white' : 'text-gray-400 hover:text-gray-600'}`}
                    >
                        Pasos del Flujo
                    </button>
                    <button
                        onClick={() => setActiveTab('map')}
                        className={`px-6 py-4 font-bold text-xs uppercase tracking-wider whitespace-nowrap transition-all ${activeTab === 'map' ? 'border-b-2 border-blue-600 text-blue-600 bg-white' : 'text-gray-400 hover:text-gray-600'}`}
                    >
                        Mapa Visual
                    </button>
                    <button
                        onClick={() => setActiveTab('faq')}
                        className={`px-6 py-4 font-bold text-xs uppercase tracking-wider whitespace-nowrap transition-all ${activeTab === 'faq' ? 'border-b-2 border-blue-600 text-blue-600 bg-white' : 'text-gray-400 hover:text-gray-600'}`}
                    >
                        Preguntas (FAQ)
                    </button>
                </div>

                <div className="p-6 bg-[#f8fafc] min-h-[500px]">
                    {loading ? (
                        <SkeletonLoader />
                    ) : (
                        <>
                            {activeTab === 'map' && (
                                <ScriptMapView script={script} onUpdate={handleUpdate} />
                            )}

                            {activeTab === 'flow' && (
                                <div className="space-y-4">
                                    {Object.entries(script.flow || {}).map(([key, step]) => (
                                        <div key={key} className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm hover:border-blue-200 transition-colors">
                                            <div className="flex justify-between items-center cursor-pointer" onClick={() => setExpandedCard(expandedCard === key ? null : key)}>
                                                <h3 className="font-bold text-gray-700 capitalize">{key.replace(/_/g, ' ')}</h3>
                                                <div className="flex items-center gap-3">
                                                    <span className="text-[10px] bg-blue-50 text-blue-600 px-2.5 py-1 rounded border border-blue-100 font-bold uppercase tracking-wide">{step.step || 'sin_paso'}</span>
                                                    <span className={`text-gray-300 transition-transform ${expandedCard === key ? 'rotate-180' : ''}`}>▼</span>
                                                </div>
                                            </div>
                                            {expandedCard === key && (
                                                <div className="mt-4 space-y-4 animate-fade-in border-t border-gray-100 pt-4">
                                                    <div>
                                                        <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Respuesta del Bot</label>
                                                        <textarea
                                                            className="w-full p-3 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all leading-relaxed"
                                                            rows={4}
                                                            value={step.response}
                                                            onChange={(e) => handleFlowChange(key, 'response', e.target.value)}
                                                        />
                                                    </div>
                                                    <div className="grid grid-cols-2 gap-4">
                                                        <div>
                                                            <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Siguiente Paso</label>
                                                            <input
                                                                type="text"
                                                                className="w-full p-2.5 border border-gray-200 rounded-lg text-sm font-mono focus:ring-2 focus:ring-blue-500/20 outline-none"
                                                                value={step.nextStep || ''}
                                                                onChange={(e) => handleFlowChange(key, 'nextStep', e.target.value)}
                                                            />
                                                        </div>
                                                        {step.step && (
                                                            <div>
                                                                <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">ID del Paso (Fase)</label>
                                                                <input
                                                                    type="text"
                                                                    className="w-full p-2.5 border border-gray-200 rounded-lg text-sm bg-gray-50 font-mono text-gray-500"
                                                                    value={step.step}
                                                                    onChange={(e) => handleFlowChange(key, 'step', e.target.value)}
                                                                />
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}

                            {activeTab === 'faq' && (
                                <div className="space-y-4">
                                    {script.faq.map((item, idx) => (
                                        <div key={idx} className="bg-white p-5 rounded-lg border border-gray-200 shadow-sm relative group hover:border-blue-200 transition-colors">
                                            <button
                                                onClick={() => deleteFAQ(idx)}
                                                className="absolute top-4 right-4 text-gray-300 hover:text-red-500 transition-colors"
                                                title="Eliminar FAQ"
                                            >✕</button>
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                                <div>
                                                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Palabras Clave (separadas por coma)</label>
                                                    <input
                                                        type="text"
                                                        className="w-full p-2.5 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 outline-none"
                                                        value={item.keywords.join(', ')}
                                                        onChange={(e) => handleFAQChange(idx, 'keywords', e.target.value.split(',').map(s => s.trim()))}
                                                    />
                                                </div>
                                                <div>
                                                    <label className="block text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Respuesta Automática</label>
                                                    <textarea
                                                        className="w-full p-2.5 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500/20 outline-none"
                                                        rows={2}
                                                        value={item.response}
                                                        onChange={(e) => handleFAQChange(idx, 'response', e.target.value)}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                    <button
                                        onClick={addFAQ}
                                        className="w-full py-4 border-2 border-dashed border-gray-300 rounded-xl text-gray-400 hover:border-blue-400 hover:text-blue-500 hover:bg-blue-50 transition-all font-bold text-sm uppercase tracking-wide flex items-center justify-center gap-2"
                                    >
                                        <span className="text-xl">+</span> Agregar Nueva Pregunta
                                    </button>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default Script;
