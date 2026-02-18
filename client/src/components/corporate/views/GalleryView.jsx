import React, { useState, useEffect } from 'react';
import api from '../../../config/axios';
import { useToast } from '../../ui/Toast';

const GalleryView = () => {
    const { toast, confirm } = useToast();
    const [images, setImages] = useState([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [filter, setFilter] = useState('');
    const [selectedCategory, setSelectedCategory] = useState('all');

    // Load gallery
    useEffect(() => {
        fetchGallery();
    }, []);

    const fetchGallery = async () => {
        try {
            const res = await api.get('/api/gallery');
            setImages(res.data);
        } catch (e) {
            console.error("Error loading gallery:", e);
            toast.error('Error al cargar la galería');
        } finally {
            setLoading(false);
        }
    };

    // Handle File Upload
    const handleFileUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        if (file.size > 5 * 1024 * 1024) { // 5MB limit
            return toast.error('La imagen no puede superar los 5MB');
        }

        setUploading(true);
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const base64 = reader.result;
                const category = prompt("Categoría (ej: capsulas, gotas, greeting):", "general") || "general";
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
            } catch (e) {
                console.error("Upload error:", e);
                toast.error('Error al subir imagen');
            } finally {
                setUploading(false);
            }
        };
        reader.readAsDataURL(file);
    };

    // Delete Image
    const handleDelete = async (img) => {
        const ok = await confirm(`¿Eliminar esta imagen?`);
        if (!ok) return;

        try {
            await api.delete(`/api/gallery/${img.id}`);
            setImages(prev => prev.filter(i => i.id !== img.id));
            toast.success('Imagen eliminada');
        } catch (e) {
            console.error("Delete error:", e);
            toast.error('Error al eliminar');
        }
    };

    // Filter Logic
    const filteredImages = images.filter(img => {
        const matchesCategory = selectedCategory === 'all' || img.category === selectedCategory;
        const matchesSearch = img.filename.toLowerCase().includes(filter.toLowerCase()) ||
            (img.tags && img.tags.some(t => t.toLowerCase().includes(filter.toLowerCase())));
        return matchesCategory && matchesSearch;
    });

    const categories = ['all', ...new Set(images.map(i => i.category || 'general'))];

    return (
        <div className="h-full flex flex-col animate-fade-in">
            {/* Header */}
            <div className="flex justify-between items-center mb-6">
                <div>
                    <h2 className="text-2xl font-bold text-slate-800 tracking-tight">Galería de Imágenes</h2>
                    <p className="text-sm text-slate-500">Administra fotos de productos y recursos del bot.</p>
                </div>
                <label className={`px-4 py-2 bg-slate-900 text-white rounded-md text-sm font-medium shadow-sm hover:bg-slate-800 transition flex items-center gap-2 cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
                    {uploading ? (
                        <>
                            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                            Subiendo...
                        </>
                    ) : (
                        <>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                            Subir Imagen
                        </>
                    )}
                    <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} disabled={uploading} />
                </label>
            </div>

            {/* Filters */}
            <div className="flex gap-4 mb-6 bg-white p-3 rounded-lg border border-slate-200 shadow-sm">
                <div className="flex-1 relative">
                    <svg className="w-4 h-4 absolute left-3 top-3 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                    <input
                        type="text"
                        placeholder="Buscar por nombre o etiqueta..."
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-md text-sm outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
                    />
                </div>
                <select
                    value={selectedCategory}
                    onChange={(e) => setSelectedCategory(e.target.value)}
                    className="px-3 py-2 border border-slate-200 rounded-md text-sm outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 bg-white min-w-[150px]"
                >
                    {categories.map(c => (
                        <option key={c} value={c}>{c === 'all' ? 'Todas las categorías' : c.charAt(0).toUpperCase() + c.slice(1)}</option>
                    ))}
                </select>
            </div>

            {/* Grid */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-1">
                {loading ? (
                    <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                        <div className="w-8 h-8 border-4 border-slate-200 border-t-blue-500 rounded-full animate-spin mb-4" />
                        <p>Cargando galería...</p>
                    </div>
                ) : filteredImages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64 text-slate-400 border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                        <svg className="w-12 h-12 mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                        <p>No hay imágenes. ¡Sube la primera!</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                        {filteredImages.map(img => (
                            <div key={img.id} className="group relative bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden hover:shadow-md transition">
                                <div className="aspect-square bg-slate-100 relative overflow-hidden">
                                    <img src={img.url} alt={img.originalName} className="w-full h-full object-cover transition transform group-hover:scale-105" />
                                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                                        <button
                                            onClick={() => window.open(img.url, '_blank')}
                                            className="p-2 bg-white/20 hover:bg-white/40 rounded-full text-white backdrop-blur-sm transition"
                                            title="Ver completa"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                        </button>
                                        <button
                                            onClick={() => handleDelete(img)}
                                            className="p-2 bg-red-500/80 hover:bg-red-600 rounded-full text-white backdrop-blur-sm transition shadow-sm"
                                            title="Eliminar"
                                        >
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                        </button>
                                    </div>
                                </div>
                                <div className="p-3">
                                    <p className="text-sm font-medium text-slate-800 truncate" title={img.originalName}>{img.originalName}</p>
                                    <div className="flex items-center justify-between mt-1">
                                        <span className="text-[10px] uppercase font-bold tracking-wider text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">{img.category}</span>
                                        <span className="text-[10px] text-slate-400">{new Date(img.createdAt).toLocaleDateString()}</span>
                                    </div>
                                    {img.tags && img.tags.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mt-2">
                                            {img.tags.slice(0, 3).map(t => (
                                                <span key={t} className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">#{t}</span>
                                            ))}
                                            {img.tags.length > 3 && <span className="text-[10px] text-slate-400">+{img.tags.length - 3}</span>}
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

export default GalleryView;
