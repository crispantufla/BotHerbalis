import React, { useState, useEffect } from 'react';
import api from '../../../config/axios';
import { API_URL } from '../../../config/api';
import { useToast } from '../../ui/Toast';

const IconsV3 = {
    Upload: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>,
    Search: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>,
    Filter: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>,
    Trash: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
    Maximize: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
};

const GalleryViewV3 = () => {
    const { toast, confirm } = useToast();
    const [images, setImages] = useState([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);

    // Filters
    const [filter, setFilter] = useState('');
    const [selectedCategory, setSelectedCategory] = useState('all');

    useEffect(() => { fetchGallery(); }, []);

    const fetchGallery = async () => {
        try {
            const res = await api.get('/api/gallery');
            setImages(res.data);
        } catch (e) { toast.error('Error al cargar la galería'); }
        setLoading(false);
    };

    const handleFileUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (file.size > 5 * 1024 * 1024) return toast.warning('Tamaño máximo soportado es 5MB');

        setUploading(true);
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const base64 = reader.result;
                const category = prompt("Asigna una categoría (ej: producto, receta, promo):", "general") || "general";
                const tagsStr = prompt("Etiquetas (separadas por coma):", "") || "";
                const tags = tagsStr.split(',').map(t => t.trim()).filter(t => t);

                const res = await api.post('/api/gallery', {
                    image: base64,
                    filename: file.name,
                    category,
                    tags
                });

                if (res.data.success) {
                    setImages(prev => [res.data.image, ...prev]);
                    toast.success('Recurso añadido al servidor');
                }
            } catch (e) { toast.error('Fallo en la subida del archivo'); }
            setUploading(false);
        };
        reader.readAsDataURL(file);
    };

    const handleDelete = async (img) => {
        const ok = await confirm(`¿Borrar el recurso "${img.originalName}" para siempre?`);
        if (!ok) return;

        try {
            await api.delete(`/api/gallery/${img.id}`);
            setImages(prev => prev.filter(i => i.id !== img.id));
            toast.success('Recurso purgado con éxito');
        } catch (e) { toast.error('Error comunicando borrado al servidor'); }
    };

    const filteredImages = images.filter(img => {
        const matchesCategory = selectedCategory === 'all' || img.category === selectedCategory;
        const matchesSearch = img.filename?.toLowerCase().includes(filter.toLowerCase()) ||
            (img.tags && img.tags.some(t => t.toLowerCase().includes(filter.toLowerCase())));
        return matchesCategory && matchesSearch;
    });

    const categories = ['all', ...new Set(images.map(i => i.category || 'general'))];

    return (
        <div className="w-full max-w-7xl mx-auto flex flex-col h-[calc(100vh-140px)] relative z-10 animate-fade-in">

            {/* Header Super Premium */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-8 shrink-0 bg-white/70 backdrop-blur-xl p-8 rounded-[2rem] border border-slate-200/60 shadow-sm relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/10 blur-[50px] rounded-full pointer-events-none"></div>

                <div className="relative z-10">
                    <h1 className="text-3xl font-black text-slate-800 tracking-tight">
                        Repositorio <span className="text-blue-600">Multimedia</span>
                    </h1>
                    <p className="text-slate-500 mt-1 font-medium text-sm">Central de imágenes y catálogos vinculados por el Asesor IA.</p>
                </div>

                <label className={`px-6 py-3.5 bg-blue-600 text-white rounded-2xl text-sm font-bold shadow-lg shadow-blue-500/20 transition-all flex items-center gap-3 cursor-pointer group relative z-10 ${uploading ? 'opacity-70 pointer-events-none' : 'hover:bg-blue-700 hover:-translate-y-0.5'}`}>
                    {uploading ? (
                        <>
                            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            <span>Enviando...</span>
                        </>
                    ) : (
                        <>
                            <span className="group-hover:-translate-y-0.5 transition-transform block"><IconsV3.Upload /></span>
                            <span>Añadir Archivo</span>
                        </>
                    )}
                    <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} disabled={uploading} />
                </label>
            </div>

            {/* Smart Filters Bar */}
            <div className="flex flex-col md:flex-row gap-4 mb-6 shrink-0 relative z-20">
                <div className="flex-1 relative group">
                    <input
                        type="text"
                        placeholder="Buscar por hashtag o nombre..."
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-2xl pl-12 pr-4 py-3 text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all shadow-sm placeholder:text-slate-400"
                    />
                    <span className="absolute left-4 top-3 text-slate-400 group-focus-within:text-blue-500 transition-colors"><IconsV3.Search /></span>
                </div>

                <div className="relative">
                    <select
                        value={selectedCategory}
                        onChange={(e) => setSelectedCategory(e.target.value)}
                        className="appearance-none bg-white border border-slate-200 rounded-2xl pl-12 pr-10 py-3 text-sm font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all shadow-sm cursor-pointer min-w-[220px]"
                    >
                        {categories.map(c => (
                            <option key={c} value={c}>{c === 'all' ? 'Mostrar Todas' : c.toUpperCase()}</option>
                        ))}
                    </select>
                    <span className="absolute left-4 top-3 text-slate-400"><IconsV3.Filter /></span>
                    <div className="absolute inset-y-0 right-4 flex items-center pointer-events-none text-slate-400">
                        <span className="text-[10px]">▼</span>
                    </div>
                </div>
            </div>

            {/* Grid Area */}
            <div className="flex-1 overflow-y-auto hide-scrollbar pb-10">
                {loading ? (
                    <div className="flex flex-col items-center justify-center h-64 text-blue-500">
                        <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin shadow-sm mb-4" />
                        <span className="font-bold tracking-widest text-xs uppercase text-slate-400">Loading</span>
                    </div>
                ) : filteredImages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64 bg-white/50 rounded-[2rem] border-2 border-dashed border-slate-200 text-center">
                        <div className="w-16 h-16 bg-white shadow-sm border border-slate-100 rounded-full flex items-center justify-center mb-4 text-slate-300">
                            <IconsV3.Upload />
                        </div>
                        <p className="text-xl font-bold text-slate-700 mb-1">El baúl está vacío</p>
                        <p className="text-sm font-medium text-slate-400">Sube tus primeras fotos para anexarlas a las promociones.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                        {filteredImages.map(img => (
                            <div key={img.id} className="group bg-white rounded-[1.5rem] border border-slate-200/60 shadow-sm overflow-hidden hover:-translate-y-1 hover:shadow-xl transition-all duration-300 flex flex-col">

                                {/* Image Block */}
                                <div className="aspect-square relative overflow-hidden bg-slate-50 border-b border-slate-100">
                                    <div className="absolute inset-0 bg-gradient-to-br from-slate-100 to-slate-200 animate-pulse -z-10"></div>
                                    <img src={`${API_URL}${img.url}`} alt={img.originalName} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" loading="lazy" />

                                    {/* Action Hover Glass */}
                                    <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-[2px] opacity-0 group-hover:opacity-100 transition-all duration-300 flex items-center justify-center gap-3">
                                        <button
                                            onClick={() => window.open(`${API_URL}${img.url}`, '_blank')}
                                            className="w-10 h-10 rounded-full bg-white text-slate-700 hover:text-blue-600 flex items-center justify-center shadow-lg transform translate-y-2 group-hover:translate-y-0 transition-all duration-300"
                                            title="Ver Full Screen"
                                        >
                                            <IconsV3.Maximize />
                                        </button>
                                        <button
                                            onClick={() => handleDelete(img)}
                                            className="w-10 h-10 rounded-full bg-rose-500 text-white hover:bg-rose-600 flex items-center justify-center shadow-lg transform translate-y-2 group-hover:translate-y-0 transition-all duration-300 delay-75"
                                            title="Eliminar"
                                        >
                                            <IconsV3.Trash />
                                        </button>
                                    </div>
                                </div>

                                {/* Meta Block */}
                                <div className="p-4 flex flex-col flex-1 bg-white">
                                    <p className="text-sm font-bold text-slate-800 line-clamp-1 mb-2" title={img.originalName}>
                                        {img.originalName}
                                    </p>

                                    <div className="flex items-center justify-between mb-3">
                                        <span className="text-[9px] uppercase font-black tracking-widest text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-100 shadow-sm">
                                            {img.category}
                                        </span>
                                        <span className="text-[10px] font-bold text-slate-400">
                                            {new Date(img.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                        </span>
                                    </div>

                                    {img.tags && img.tags.length > 0 ? (
                                        <div className="flex flex-wrap gap-1 mt-auto pt-3 border-t border-slate-100">
                                            {img.tags.slice(0, 2).map(t => (
                                                <span key={t} className="text-[10px] font-bold text-slate-500 bg-slate-50 px-1.5 py-0.5 rounded-md border border-slate-200">#{t}</span>
                                            ))}
                                            {img.tags.length > 2 && <span className="text-[10px] font-bold text-slate-400 pt-0.5">+{img.tags.length - 2}</span>}
                                        </div>
                                    ) : (
                                        <div className="mt-auto pt-3 border-t border-slate-100">
                                            <span className="text-[10px] font-medium text-slate-300">#sin_etiquetas</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default GalleryViewV3;
