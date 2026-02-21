import React, { useState, useEffect } from 'react';
import api from '../../../config/axios';
import { useToast } from '../../ui/Toast';

const IconsV2 = {
    Upload: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>,
    Search: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>,
    Filter: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>,
    Trash: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>,
    Maximize: () => <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
};

const GalleryViewV2 = () => {
    const { toast, confirm } = useToast();
    const [images, setImages] = useState([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
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

        if (file.size > 5 * 1024 * 1024) return toast.error('La imagen no puede superar los 5MB');

        setUploading(true);
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const base64 = reader.result;
                const category = prompt("Categoría (ej: producto, receta, extra):", "general") || "general";
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
                    toast.success('Imagen subida correctamente');
                }
            } catch (e) { toast.error('Error al subir la imagen'); }
            setUploading(false);
        };
        reader.readAsDataURL(file);
    };

    const handleDelete = async (img) => {
        const ok = await confirm(`¿Eliminar definitivamente la imagen "${img.originalName}"?`);
        if (!ok) return;

        try {
            await api.delete(`/api/gallery/${img.id}`);
            setImages(prev => prev.filter(i => i.id !== img.id));
            toast.success('Imagen eliminada de la base de datos');
        } catch (e) { toast.error('Error al eliminar'); }
    };

    const filteredImages = images.filter(img => {
        const matchesCategory = selectedCategory === 'all' || img.category === selectedCategory;
        const matchesSearch = img.filename.toLowerCase().includes(filter.toLowerCase()) ||
            (img.tags && img.tags.some(t => t.toLowerCase().includes(filter.toLowerCase())));
        return matchesCategory && matchesSearch;
    });

    const categories = ['all', ...new Set(images.map(i => i.category || 'general'))];

    return (
        <div className="h-full flex flex-col animate-fade-in relative z-10 w-full space-y-6">

            {/* Header V2 & Upload Action */}
            <div className="bg-white/40 backdrop-blur-xl rounded-[2rem] border border-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)] p-8 relative overflow-hidden">
                <div className="absolute top-0 right-0 w-64 h-64 bg-fuchsia-400/10 blur-[60px] rounded-full pointer-events-none"></div>

                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 relative z-10">
                    <div>
                        <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-700 to-purple-600 tracking-tight">
                            Recursos y Galería
                        </h1>
                        <p className="text-slate-500 mt-2 font-medium">Bóveda de imágenes utilizadas por el Bot de IA y el Guión de Ventas.</p>
                    </div>

                    <label className={`px-8 py-4 bg-gradient-to-br from-indigo-600 to-purple-600 text-white rounded-2xl text-sm font-extrabold tracking-widest uppercase shadow-lg shadow-indigo-500/30 transition-all flex items-center gap-3 cursor-pointer group ${uploading ? 'opacity-70 pointer-events-none' : 'hover:shadow-indigo-500/50 hover:-translate-y-1'}`}>
                        {uploading ? (
                            <>
                                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                <span>Procesando...</span>
                            </>
                        ) : (
                            <>
                                <span className="group-hover:scale-110 transition-transform block"><IconsV2.Upload /></span>
                                <span>Cargar Nueva Imagen</span>
                            </>
                        )}
                        <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} disabled={uploading} />
                    </label>
                </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col relative">

                {/* Unified Filters Bar */}
                <div className="bg-white/60 backdrop-blur-xl rounded-2xl border border-white/80 shadow-sm p-4 mb-6 flex flex-col md:flex-row gap-4 relative z-20">
                    <div className="flex-1 relative group">
                        <input
                            type="text"
                            placeholder="Buscar por nombre de archivo o hashtag..."
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            className="w-full bg-white/70 border border-white rounded-xl pl-12 pr-4 py-3.5 text-sm font-bold text-slate-700 focus:outline-none focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition-all shadow-inner placeholder:text-slate-400 placeholder:font-medium"
                        />
                        <span className="absolute left-4 top-3.5 text-slate-400 group-focus-within:text-indigo-500 transition-colors"><IconsV2.Search /></span>
                    </div>

                    <div className="relative">
                        <select
                            value={selectedCategory}
                            onChange={(e) => setSelectedCategory(e.target.value)}
                            className="appearance-none bg-white/70 border border-white rounded-xl pl-12 pr-10 py-3.5 text-sm font-extrabold text-slate-700 focus:outline-none focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 focus:bg-white transition-all shadow-inner cursor-pointer min-w-[200px] uppercase tracking-wider"
                        >
                            {categories.map(c => (
                                <option key={c} value={c} className="font-bold text-slate-700">
                                    {c === 'all' ? 'Ver Todas (Cat.)' : c}
                                </option>
                            ))}
                        </select>
                        <span className="absolute left-4 top-3.5 text-slate-400"><IconsV2.Filter /></span>
                        <div className="absolute inset-y-0 right-4 flex items-center pointer-events-none text-slate-400">
                            <span className="text-[10px]">▼</span>
                        </div>
                    </div>
                </div>

                {/* Glassmorphism Gallery Grid */}
                <div className="flex-1 overflow-y-auto custom-scrollbar relative z-10 px-1 pb-10">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-indigo-500">
                            <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin shadow-lg mb-4" />
                            <span className="font-bold tracking-widest text-xs uppercase text-slate-400">Escaneando Bóveda</span>
                        </div>
                    ) : filteredImages.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full min-h-[400px] bg-white/40 backdrop-blur-xl rounded-[2rem] border border-white/60 border-dashed m-1">
                            <div className="w-20 h-20 bg-white shadow-sm border border-slate-200 rounded-full flex items-center justify-center mb-6 text-slate-300">
                                <IconsV2.Upload />
                            </div>
                            <p className="text-xl font-extrabold text-slate-700 mb-2">Bóveda Vacía</p>
                            <p className="text-sm font-medium text-slate-400">No hay imágenes que coincidan con los filtros actuales.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                            {filteredImages.map(img => (
                                <div key={img.id} className="group flex flex-col bg-white/60 backdrop-blur-xl rounded-2xl border border-white/80 shadow-[0_8px_30px_rgb(0,0,0,0.04)] overflow-hidden hover:-translate-y-1 hover:shadow-xl transition-all duration-300">

                                    {/* Abstract Image Container */}
                                    <div className="aspect-square relative overflow-hidden bg-slate-100/50">
                                        {/* Subtle loading placeholder */}
                                        <div className="absolute inset-0 bg-gradient-to-br from-slate-100 to-slate-200 animate-pulse -z-10"></div>

                                        <img src={img.url} alt={img.originalName} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" loading="lazy" />

                                        {/* Glass Overlay Actions */}
                                        <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px] opacity-0 group-hover:opacity-100 transition-all duration-300 flex items-center justify-center gap-4">
                                            <button
                                                onClick={() => window.open(img.url, '_blank')}
                                                className="w-12 h-12 rounded-full bg-white/20 hover:bg-white text-white hover:text-indigo-600 backdrop-blur-md flex items-center justify-center shadow-lg transform translate-y-4 group-hover:translate-y-0 transition-all duration-300"
                                                title="Visualización Completa"
                                            >
                                                <IconsV2.Maximize />
                                            </button>
                                            <button
                                                onClick={() => handleDelete(img)}
                                                className="w-12 h-12 rounded-full bg-rose-500/80 hover:bg-rose-600 text-white backdrop-blur-md flex items-center justify-center shadow-lg transform translate-y-4 group-hover:translate-y-0 transition-all duration-300 delay-75"
                                                title="Eliminar Recurso"
                                            >
                                                <IconsV2.Trash />
                                            </button>
                                        </div>
                                    </div>

                                    {/* Data Metadata */}
                                    <div className="p-4 flex flex-col flex-1 bg-gradient-to-b from-transparent to-white/50">
                                        <div className="flex justify-between items-start mb-2">
                                            <p className="text-sm font-extrabold text-slate-800 truncate pr-2 flex-1" title={img.originalName}>{img.originalName}</p>
                                        </div>

                                        <div className="flex items-center justify-between mb-3">
                                            <span className="text-[9px] uppercase font-extrabold tracking-widest text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full border border-indigo-100 shadow-sm">{img.category}</span>
                                            <span className="text-[10px] font-mono text-slate-400">{new Date(img.createdAt).toLocaleDateString()}</span>
                                        </div>

                                        {img.tags && img.tags.length > 0 ? (
                                            <div className="flex flex-wrap gap-1.5 mt-auto pt-2 border-t border-slate-100/50">
                                                {img.tags.slice(0, 3).map(t => (
                                                    <span key={t} className="text-[10px] font-bold text-slate-500 bg-white px-2 py-0.5 rounded-md border border-slate-200 shadow-sm">#{t}</span>
                                                ))}
                                                {img.tags.length > 3 && <span className="text-[10px] font-bold text-slate-400 pt-0.5">+{img.tags.length - 3}</span>}
                                            </div>
                                        ) : (
                                            <div className="mt-auto pt-2 border-t border-slate-100/50">
                                                <span className="text-[10px] font-medium text-slate-300 italic">Sin etiquetas</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default GalleryViewV2;
