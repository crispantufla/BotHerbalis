import React, { useState, useEffect } from 'react';
import axios from 'axios';

const Script = () => {
    const [script, setScript] = useState({ flow: {}, faq: [] });
    const [activeTab, setActiveTab] = useState('flow');
    const [expandedCard, setExpandedCard] = useState(null);
    const API_URL = 'http://localhost:3001';

    useEffect(() => {
        fetchScript();
    }, []);

    const fetchScript = async () => {
        try {
            const res = await axios.get(`${API_URL}/api/script`);
            setScript(res.data);
        } catch (e) { console.error(e); }
    };

    const saveScript = async () => {
        try {
            await axios.post(`${API_URL}/api/script`, script);
            alert('Guión guardado correctamente');
        } catch (e) { alert('Error al guardar'); }
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

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <h2 className="text-2xl font-bold text-gray-800">Editor de Guiones</h2>
                <button onClick={saveScript} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 shadow-sm font-medium">
                    💾 Guardar Cambios
                </button>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                <div className="border-b flex">
                    <button
                        onClick={() => setActiveTab('flow')}
                        className={`px-6 py-3 font-medium text-sm ${activeTab === 'flow' ? 'border-b-2 border-blue-500 text-blue-600 bg-blue-50' : 'text-gray-500 hover:bg-gray-50'}`}
                    >
                        Flujo de Venta Principal
                    </button>
                    <button
                        onClick={() => setActiveTab('faq')}
                        className={`px-6 py-3 font-medium text-sm ${activeTab === 'faq' ? 'border-b-2 border-blue-500 text-blue-600 bg-blue-50' : 'text-gray-500 hover:bg-gray-50'}`}
                    >
                        Preguntas Frecuentes (FAQ)
                    </button>
                </div>

                <div className="p-6 bg-gray-50 min-h-[500px]">
                    {activeTab === 'flow' && (
                        <div className="space-y-4">
                            {Object.entries(script.flow || {}).map(([key, step]) => (
                                <div key={key} className="bg-white p-4 rounded-lg border shadow-sm">
                                    <div className="flex justify-between items-center cursor-pointer" onClick={() => setExpandedCard(expandedCard === key ? null : key)}>
                                        <h3 className="font-bold text-gray-700 capitalize">{key.replace(/_/g, ' ')}</h3>
                                        <span className="text-gray-400">{expandedCard === key ? '▲' : '▼'}</span>
                                    </div>
                                    {expandedCard === key && (
                                        <div className="mt-4 space-y-3 animate-fade-in">
                                            <div>
                                                <label className="block text-xs font-bold text-gray-400 uppercase">Respuesta del Bot</label>
                                                <textarea
                                                    className="w-full mt-1 p-3 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                                                    rows={3}
                                                    value={step.response}
                                                    onChange={(e) => handleFlowChange(key, 'response', e.target.value)}
                                                />
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
                                <div key={idx} className="bg-white p-4 rounded-lg border shadow-sm relative group">
                                    <button onClick={() => deleteFAQ(idx)} className="absolute top-2 right-2 text-gray-300 hover:text-red-500 transition">✕</button>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-xs font-bold text-gray-400 uppercase">Keywords (coma)</label>
                                            <input
                                                type="text"
                                                className="w-full mt-1 p-2 border rounded-lg text-sm"
                                                value={item.keywords.join(', ')}
                                                onChange={(e) => handleFAQChange(idx, 'keywords', e.target.value.split(',').map(s => s.trim()))}
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-xs font-bold text-gray-400 uppercase">Respuesta</label>
                                            <textarea
                                                className="w-full mt-1 p-2 border rounded-lg text-sm"
                                                rows={1}
                                                value={item.response}
                                                onChange={(e) => handleFAQChange(idx, 'response', e.target.value)}
                                            />
                                        </div>
                                    </div>
                                </div>
                            ))}
                            <button onClick={addFAQ} className="w-full py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-400 hover:border-gray-400 hover:bg-gray-100 transition font-medium">
                                + Agregar Nueva Pregunta
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default Script;
