import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import api from '../../../config/axios';
import { API_URL } from '../../../config/api';
import ScriptMapView from '../views/ScriptMapView'; // We'll keep using the original map view as it's a complex generic component, maybe style it later if needed. Wait, we can wrap it or build a V2. For now, let's keep it.
import { useToast } from '../../ui/Toast';

import { RefreshCw as Refresh, Save, Image as ImageIcon, X as Close, Check, Play, Trash2 as Trash } from 'lucide-react';

const ScriptViewV2 = () => {
    const { toast } = useToast();
    const [script, setScript] = useState({ flow: {}, faq: [] });
    const [activeTab, setActiveTab] = useState('flow');
    const [expandedCard, setExpandedCard] = useState(null);
    const [loading, setLoading] = useState(true);
    const [showGallery, setShowGallery] = useState(null);
    const [galleryImages, setGalleryImages] = useState([]);
    const [faqSearchTerm, setFaqSearchTerm] = useState('');

    // Multi-script support
    const [viewingVersion, setViewingVersion] = useState('v3');
    const [activeScript, setActiveScript] = useState('v3');
    const [availableScripts, setAvailableScripts] = useState(['v1', 'v2', 'v3', 'v4']);

    useEffect(() => {
        fetchActiveInfo();
        fetchScript('v3');
    }, []);

    const fetchActiveInfo = async () => {
        try {
            const res = await api.get('/api/script/active');
            setActiveScript(res.data.active);
            setAvailableScripts(res.data.available || ['v1', 'v2', 'v3', 'v4']);
        } catch (e) { console.error(e); }
    };

    const fetchScript = async (version = viewingVersion) => {
        setLoading(true);
        try {
            const res = await api.get(`/api/script/${version}`);
            setScript(res.data);
            setViewingVersion(version);
            setExpandedCard(null); // Reset expansions when switching
        } catch (e) {
            toast.error(`Error al cargar la versión ${version}`);
            // Fallback to active if specific fails
            if (version !== 'active') fetchScript('active');
        }
        setLoading(false);
    };

    const saveScript = async () => {
        try {
            // Note: Our backend /api/script (POST) usually only saves the active/default one.
            // If we want to save a specific version, we might need a dedicated endpoint or 
            // the backend should detect which file to update based on some logic.
            // For now, let's assume POST /api/script saves the current global one.
            // Wait, I should probably add a parameter to save specific versions too.
            await api.post('/api/script', { ...script, version: viewingVersion });
            toast.success(`Guión ${viewingVersion.toUpperCase()} guardado correctamente`);
        } catch (e) { toast.error('Error al guardar'); }
    };

    const switchActiveScript = async (version) => {
        try {
            await api.post('/api/script/switch', { script: version });
            setActiveScript(version);
            toast.success(`Bot activado con Guión ${version.toUpperCase()}`);
        } catch (e) { toast.error('Error al cambiar script activo'); }
    };

    const handleUpdate = (newScript) => setScript(newScript);

    const handleFlowChange = (stepKey, field, value) => {
        setScript(prev => ({
            ...prev,
            flow: { ...prev.flow, [stepKey]: { ...prev.flow[stepKey], [field]: value } }
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

    const addFAQ = () => setScript(prev => ({ ...prev, faq: [...prev.faq, { keywords: [], response: "Nueva respuesta" }] }));

    return (
        <div className="h-full flex flex-col animate-fade-in relative z-10 w-full space-y-6">

            {/* Header V2 */}
            <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-200 dark:border-slate-700 shadow-[0_8px_30px_rgb(0,0,0,0.04)] p-5 lg:p-6">
                <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-4">
                    <div className="flex-1">
                        <div className="flex items-center gap-3">
                            <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-700 to-purple-600 tracking-tight">
                                Editor de Guiones AI
                            </h1>
                            <span className="px-3 py-1 bg-indigo-100 text-indigo-700 text-[10px] font-black rounded-full uppercase tracking-tighter">
                                Versionador {viewingVersion.toUpperCase()}
                            </span>
                        </div>
                        <p className="text-slate-500 mt-1 font-medium text-sm">Revisa, edita y activa diferentes estrategias de venta para tu bot.</p>

                        {/* WARNING MESSAGE ADDED PER USER REQUEST */}
                        <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 rounded-xl flex items-start gap-3">
                            <div className="text-amber-500 mt-0.5">⚠️</div>
                            <p className="text-xs md:text-sm text-amber-800 dark:text-amber-200 font-medium">
                                <strong className="font-bold">Aviso importante:</strong> Este editor aún no funciona para guardar permanentemente, solo hace cambios temporales en memoria. Cualquier cambio constante necesario, <strong className="font-bold">pedíselo a Cristian</strong>.
                            </p>
                        </div>

                        {/* Version Selector Buttons */}
                        <div className="flex flex-wrap gap-2 mt-4">
                            {availableScripts.map(v => (
                                <button
                                    key={v}
                                    onClick={() => fetchScript(v)}
                                    className={`px-5 py-2.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2 border shadow-sm ${viewingVersion === v
                                        ? 'bg-indigo-600 text-white border-indigo-500 shadow-indigo-200'
                                        : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300 hover:bg-indigo-50'
                                        }`}
                                >
                                    {v.toUpperCase()}
                                    {activeScript === v && (
                                        <span className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse shadow-sm shadow-emerald-400/50" title="Activo en el Bot"></span>
                                    )}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-4 w-full xl:w-auto">
                        {activeScript !== viewingVersion && (
                            <button
                                onClick={() => switchActiveScript(viewingVersion)}
                                className="px-6 py-3 bg-white border border-indigo-200 text-indigo-600 rounded-xl text-sm font-bold shadow-sm hover:bg-indigo-50 hover:shadow-md transition-all flex items-center gap-2 group"
                            >
                                <Play className="w-4 h-4" />
                                <span>Activar en el Bot</span>
                            </button>
                        )}
                        <button onClick={() => fetchScript(viewingVersion)} className="p-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-600 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition-all shadow-sm active:scale-95 group" title="Recargar">
                            <span className="group-hover:rotate-180 transition-transform duration-500 block"><Refresh className="w-5 h-5" /></span>
                        </button>
                        <button onClick={saveScript} className="px-8 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl text-sm font-bold shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:scale-105 transition-all flex items-center gap-2">
                            <Save className="w-5 h-5" />
                            <span>Guardar Cambios</span>
                        </button>
                    </div>
                </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 bg-slate-50 dark:bg-slate-900 rounded-[2rem] border border-slate-200 dark:border-slate-800 shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden flex flex-col relative text-sm">

                {/* Background Glow */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full max-w-2xl max-h-2xl bg-indigo-400/5 blur-[120px] rounded-full pointer-events-none"></div>

                {/* Glass Tabs */}
                <div className="border-b border-white/6 dark:border-slate-700/60 flex overflow-x-auto bg-white/3 dark:bg-slate-800/30 backdrop-blur-md sticky top-0 z-20">
                    <button onClick={() => setActiveTab('flow')} className={`px-8 py-5 font-extrabold text-xs uppercase tracking-widest whitespace-nowrap transition-all ${activeTab === 'flow' ? 'border-b-2 border-indigo-600 text-indigo-700 bg-white/50 dark:bg-slate-800/50' : 'text-slate-400 hover:text-indigo-500 hover:bg-white/20 dark:bg-slate-800/20'}`}>
                        Pasos del Flujo
                    </button>
                    <button onClick={() => setActiveTab('map')} className={`px-8 py-5 font-extrabold text-xs uppercase tracking-widest whitespace-nowrap transition-all ${activeTab === 'map' ? 'border-b-2 border-indigo-600 text-indigo-700 bg-white/50 dark:bg-slate-800/50' : 'text-slate-400 hover:text-indigo-500 hover:bg-white/20 dark:bg-slate-800/20'}`}>
                        Mapa Visual
                    </button>
                    <button onClick={() => setActiveTab('faq')} className={`px-8 py-5 font-extrabold text-xs uppercase tracking-widest whitespace-nowrap transition-all ${activeTab === 'faq' ? 'border-b-2 border-indigo-600 text-indigo-700 bg-white/50 dark:bg-slate-800/50' : 'text-slate-400 hover:text-indigo-500 hover:bg-white/20 dark:bg-slate-800/20'}`}>
                        Preguntas (FAQ)
                    </button>
                </div>

                <div className="p-8 flex-1 overflow-y-auto custom-scrollbar relative z-10">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center h-full gap-4 text-indigo-500">
                            <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin shadow-lg"></div>
                            <span className="font-bold tracking-widest text-xs uppercase text-slate-400">Cargando Estructura</span>
                        </div>
                    ) : (
                        <>
                            {activeTab === 'map' && (
                                <div className="bg-white/5 dark:bg-slate-800/50 rounded-2xl p-4 border border-white shadow-inner h-full min-h-[500px]">
                                    <ScriptMapView script={script} onUpdate={handleUpdate} />
                                </div>
                            )}

                            {activeTab === 'flow' && (
                                <div className="space-y-6 max-w-5xl 2xl:max-w-7xl mx-auto">
                                    {Object.entries(script.flow || {}).map(([key, step]) => (
                                        <div key={key} className="bg-white/8 dark:bg-slate-800/80 backdrop-blur-md p-6 rounded-3xl border border-white shadow-sm hover:shadow-md hover:border-indigo-200 transition-all duration-300">
                                            <div className="flex justify-between items-center cursor-pointer group" onClick={() => setExpandedCard(expandedCard === key ? null : key)}>
                                                <h3 className="font-extrabold text-slate-800 dark:text-slate-100 capitalize text-base group-hover:text-indigo-600 transition-colors">{key.replace(/_/g, ' ')}</h3>
                                                <div className="flex items-center gap-4">
                                                    <span className="text-[10px] bg-indigo-50 text-indigo-700 px-3 py-1.5 rounded-lg border border-indigo-100 font-bold uppercase tracking-widest shadow-sm">ID: {step.step || 'sin_paso'}</span>
                                                    <span className={`text-slate-300 transition-transform duration-300 ${expandedCard === key ? 'rotate-180 text-indigo-500' : ''}`}>▼</span>
                                                </div>
                                            </div>

                                            {expandedCard === key && (
                                                <div className="mt-6 space-y-6 animate-fade-in border-t border-slate-100/50 pt-6">
                                                    <div>
                                                        <label className="block text-[10px] font-extrabold text-slate-500 dark:text-slate-300 uppercase tracking-widest mb-2 ml-1">Respuesta del Agente IA</label>
                                                        <textarea
                                                            className="w-full p-4 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-medium text-slate-700 dark:text-slate-200 focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all leading-relaxed shadow-inner"
                                                            rows={4}
                                                            value={step.response}
                                                            onChange={(e) => handleFlowChange(key, 'response', e.target.value)}
                                                        />
                                                    </div>

                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                                        <div>
                                                            <label className="block text-[10px] font-extrabold text-slate-500 dark:text-slate-300 uppercase tracking-widest mb-2 ml-1">Clave Siguiente Paso</label>
                                                            <input
                                                                type="text"
                                                                className="w-full p-3.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-mono font-bold text-slate-600 dark:text-slate-300 focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all shadow-inner"
                                                                value={step.nextStep || ''}
                                                                onChange={(e) => handleFlowChange(key, 'nextStep', e.target.value)}
                                                            />
                                                        </div>
                                                        {step.step && (
                                                            <div>
                                                                <label className="block text-[10px] font-extrabold text-slate-500 dark:text-slate-300 uppercase tracking-widest mb-2 ml-1">ID Módulo (Lectura AI)</label>
                                                                <input
                                                                    type="text"
                                                                    className="w-full p-3.5 bg-slate-100/5 dark:bg-slate-700/50 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-mono font-bold text-slate-400 shadow-inner cursor-not-allowed"
                                                                    value={step.step}
                                                                    onChange={(e) => handleFlowChange(key, 'step', e.target.value)}
                                                                />
                                                            </div>
                                                        )}
                                                    </div>

                                                    {/* Image Configuration */}
                                                    <div className="border-t border-slate-100/50 pt-6 mt-4">
                                                        <label className="flex items-center gap-3 cursor-pointer group w-fit">
                                                            <div className="relative flex items-center justify-center">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={!!step.imageEnabled}
                                                                    onChange={(e) => handleFlowChange(key, 'imageEnabled', e.target.checked)}
                                                                    className="peer sr-only"
                                                                />
                                                                <div className="w-12 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500 shadow-sm transition-colors"></div>
                                                            </div>
                                                            <span className="text-xs font-extrabold text-slate-500 group-hover:text-slate-800 uppercase tracking-widest transition-colors">
                                                                Acompañar con Imagen
                                                            </span>
                                                        </label>

                                                        {step.imageEnabled && (
                                                            <div className="mt-5 space-y-4 animate-fade-in bg-slate-50 p-5 rounded-2xl border border-slate-200 shadow-inner">
                                                                {step.image ? (
                                                                    <div className="flex gap-6 items-center">
                                                                        <div className="relative group/img">
                                                                            <img
                                                                                src={step.image.startsWith('http') ? step.image : step.image.startsWith('/media/') ? `${API_URL}${step.image}` : `data:${step.imageMimetype || 'image/jpeg'};base64,${step.image}`}
                                                                                alt="Step cover"
                                                                                className="rounded-xl border border-slate-300 shadow-md max-h-32 object-cover"
                                                                            />
                                                                            <button
                                                                                onClick={() => {
                                                                                    handleFlowChange(key, 'image', null);
                                                                                    handleFlowChange(key, 'imageMimetype', null);
                                                                                    handleFlowChange(key, 'imageFilename', null);
                                                                                }}
                                                                                className="absolute -top-3 -right-3 w-8 h-8 bg-rose-500 text-white rounded-xl shadow-lg flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-all transform scale-75 group-hover/img:scale-100"
                                                                                title="Eliminar imagen adjunta"
                                                                            >
                                                                                <Close className="w-4 h-4" />
                                                                            </button>
                                                                        </div>
                                                                        <div className="flex-1">
                                                                            <p className="text-xs font-bold text-slate-700 mb-1">Imagen Adjunta:</p>
                                                                            <p className="text-[10px] text-slate-400 font-mono truncate max-w-xs">{step.imageFilename || 'Media cargada'}</p>
                                                                        </div>
                                                                    </div>
                                                                ) : (
                                                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                                                        <button
                                                                            onClick={() => { setShowGallery(key); fetchGallery(); }}
                                                                            className="py-4 bg-white border border-indigo-200 text-indigo-600 rounded-xl text-xs font-bold hover:bg-indigo-50 transition-colors shadow-sm flex items-center justify-center gap-2"
                                                                        >
                                                                            <ImageIcon className="w-4 h-4" />
                                                                            Abrir Galería
                                                                        </button>
                                                                        <label className="flex flex-col items-center justify-center py-4 border-2 border-dashed border-indigo-200 rounded-xl cursor-pointer hover:border-indigo-400 hover:bg-indigo-50/50 transition-all group bg-white">
                                                                            <span className="text-xs text-indigo-400 group-hover:text-indigo-600 font-bold uppercase tracking-widest">O Subir Archivo</span>
                                                                            <input
                                                                                type="file" accept="image/*" className="hidden"
                                                                                onChange={(e) => {
                                                                                    const file = e.target.files[0];
                                                                                    if (!file) return;
                                                                                    const reader = new FileReader();
                                                                                    reader.onload = () => {
                                                                                        handleFlowChange(key, 'image', reader.result.split(',')[1]);
                                                                                        handleFlowChange(key, 'imageMimetype', file.type);
                                                                                        handleFlowChange(key, 'imageFilename', file.name);
                                                                                    };
                                                                                    reader.readAsDataURL(file);
                                                                                }}
                                                                            />
                                                                        </label>
                                                                    </div>
                                                                )}
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
                                <div className="space-y-6 max-w-5xl 2xl:max-w-7xl mx-auto">
                                    <div className="flex flex-col sm:flex-row justify-between items-center gap-4 mb-4">
                                        <div className="relative w-full sm:w-96 group">
                                            <input
                                                type="text"
                                                placeholder="Buscar por palabra clave o respuesta..."
                                                value={faqSearchTerm}
                                                onChange={(e) => setFaqSearchTerm(e.target.value)}
                                                className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl pl-11 pr-4 py-3.5 text-sm font-bold text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 transition-all shadow-inner placeholder:text-slate-400 placeholder:font-medium"
                                            />
                                            <span className="absolute left-4 top-3.5 text-slate-400 group-focus-within:text-indigo-500 transition-colors">
                                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                                            </span>
                                        </div>
                                        <button onClick={addFAQ} className="w-full sm:w-auto px-6 py-3 bg-white border border-indigo-200 text-indigo-600 rounded-xl text-xs font-extrabold uppercase tracking-widest hover:bg-indigo-50 shadow-sm transition-all flex items-center justify-center gap-2">
                                            <span className="text-lg leading-none mb-0.5">+</span> Nueva Respuesta
                                        </button>
                                    </div>
                                    <div className="grid gap-6">
                                        {script.faq.map((item, originalIndex) => ({ item, originalIndex }))
                                            .filter(({ item }) => {
                                                if (!faqSearchTerm) return true;
                                                const term = faqSearchTerm.toLowerCase();
                                                return item.keywords.some(k => k.toLowerCase().includes(term)) || (item.response && item.response.toLowerCase().includes(term));
                                            })
                                            .map(({ item, originalIndex }) => (
                                                <div key={originalIndex} className="bg-white/8 dark:bg-slate-800/80 backdrop-blur-md p-6 rounded-3xl border border-white shadow-sm hover:shadow-md transition-all duration-300 relative group">
                                                    <button onClick={() => deleteFAQ(originalIndex)} className="absolute top-4 right-4 w-8 h-8 bg-rose-50 text-rose-400 hover:bg-rose-500 hover:text-white rounded-xl flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all" title="Eliminar FAQ">
                                                        <Trash className="w-5 h-5" />
                                                    </button>
                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-2">
                                                        <div>
                                                            <label className="block text-[10px] font-extrabold text-slate-500 dark:text-slate-300 uppercase tracking-widest mb-2 ml-1">Palabras Clave (Tokens)</label>
                                                            <input
                                                                type="text"
                                                                className="w-full p-4 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-mono text-slate-600 dark:text-slate-300 focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all shadow-inner"
                                                                value={item.keywords.join(', ')}
                                                                placeholder="ej: envios, correo, andreani"
                                                                onChange={(e) => handleFAQChange(originalIndex, 'keywords', e.target.value.split(',').map(s => s.trim()))}
                                                            />
                                                            <p className="text-[10px] font-medium text-slate-400 mt-2 ml-2">Separadas por comas. El bot usará esto como triggers.</p>
                                                        </div>
                                                        <div>
                                                            <label className="block text-[10px] font-extrabold text-slate-500 dark:text-slate-300 uppercase tracking-widest mb-2 ml-1">Respuesta Estática</label>
                                                            <textarea
                                                                className="w-full p-4 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm font-medium text-slate-700 dark:text-slate-200 focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all shadow-inner"
                                                                rows={3}
                                                                placeholder="Respuesta literal que mandará el bot..."
                                                                value={item.response}
                                                                onChange={(e) => handleFAQChange(originalIndex, 'response', e.target.value)}
                                                            />
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </div>
            </div>

            {/* GALLERY MODAL V2 */}
            {showGallery && createPortal(
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[100] flex items-center justify-center p-4 animate-fade-in">
                    <div className="bg-white/9 dark:bg-slate-800/95 backdrop-blur-2xl rounded-[2rem] shadow-2xl w-full max-w-6xl 2xl:max-w-7xl max-h-[85vh] flex flex-col border border-white relative overflow-hidden">
                        <div className="p-8 border-b border-white flex justify-between items-center bg-white/4 dark:bg-slate-800/40 sticky top-0 z-10 backdrop-blur-md">
                            <div>
                                <h3 className="text-2xl font-extrabold text-slate-800 tracking-tight">Galería de Medios</h3>
                                <p className="text-xs font-bold text-indigo-500 uppercase tracking-widest mt-1">Selecciona una imagen para el paso</p>
                            </div>
                            <button onClick={() => setShowGallery(null)} className="w-12 h-12 rounded-full bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors flex items-center justify-center">
                                <Close className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="p-8 overflow-y-auto custom-scrollbar flex-1 bg-slate-50/5 dark:bg-slate-800/50">
                            {galleryImages.length === 0 ? (
                                <div className="text-center py-20">
                                    <div className="w-20 h-20 bg-white shadow-sm border border-slate-200 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-300">
                                        <ImageIcon className="w-4 h-4" />
                                    </div>
                                    <p className="text-slate-500 font-bold text-lg mb-1">Galería Vacía</p>
                                    <p className="text-sm text-slate-400">Dirigite a la pestaña principal de Galería para subir archivos.</p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6">
                                    {galleryImages.map(img => (
                                        <div
                                            key={img.id}
                                            onClick={() => {
                                                handleFlowChange(showGallery, 'image', img.url);
                                                handleFlowChange(showGallery, 'imageFilename', img.originalName);
                                                handleFlowChange(showGallery, 'imageMimetype', null);
                                                setShowGallery(null);
                                            }}
                                            className="cursor-pointer group relative aspect-square rounded-2xl overflow-hidden border-2 border-white shadow-md hover:border-indigo-400 hover:shadow-xl hover:-translate-y-1 transition-all duration-300 bg-white"
                                        >
                                            <img src={`${API_URL}${img.url}`} alt={img.originalName} className="w-full h-full object-cover" />
                                            <div className="absolute inset-0 bg-gradient-to-t from-slate-900/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-4">
                                                <div className="transform translate-y-4 group-hover:translate-y-0 transition-transform">
                                                    {img.category && <span className="inline-block px-2 py-0.5 rounded-md bg-indigo-500/80 backdrop-blur-sm text-white text-[9px] font-bold uppercase tracking-wider mb-1">{img.category}</span>}
                                                    <p className="text-white text-xs font-bold truncate drop-shadow-md">{img.originalName}</p>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
};

export default ScriptViewV2;
