import React, { useState, useEffect } from 'react';
import { Upload, Search, Filter, Trash2, Maximize, Image as ImageIcon } from 'lucide-react';
import api from '../../config/axios';
import { API_URL } from '../../config/api';
import {
    Card, Button, IconButton, Badge, Input, Select, EmptyState, useToast, cn
} from '../ui';

const GalleryView = () => {
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
        } catch { toast.error('Error al cargar la galería'); }
        setLoading(false);
    };

    // Upload via prompt() para categoría/tags — preservamos el flujo simple
    // (cambiar a modal sería otro PR; no es la prioridad de este refactor).
    const handleFileUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) return toast.error('La imagen no puede superar los 5MB');

        setUploading(true);
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const base64 = reader.result;
                const category = prompt('Categoría (ej: producto, receta, extra):', 'general') || 'general';
                const tagsStr = prompt('Etiquetas (separadas por coma):', '') || '';
                const tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean);
                const res = await api.post('/api/gallery', { image: base64, filename: file.name, category, tags });
                if (res.data.success) {
                    setImages(prev => [res.data.image, ...prev]);
                    toast.success('Imagen subida correctamente');
                }
            } catch { toast.error('Error al subir la imagen'); }
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
            toast.success('Imagen eliminada');
        } catch { toast.error('Error al eliminar'); }
    };

    const filteredImages = images.filter(img => {
        const matchesCategory = selectedCategory === 'all' || img.category === selectedCategory;
        const matchesSearch = img.filename.toLowerCase().includes(filter.toLowerCase()) ||
            (img.tags && img.tags.some(t => t.toLowerCase().includes(filter.toLowerCase())));
        return matchesCategory && matchesSearch;
    });

    const categories = ['all', ...new Set(images.map(i => i.category || 'general'))];

    return (
        <div className="h-full flex flex-col animate-fade-in relative z-10 w-full space-y-4">
            <Card padding="md">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
                    <div>
                        <h1 className="text-display text-slate-900 dark:text-slate-100">Recursos y galería</h1>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                            Imágenes utilizadas por el bot y el guión de ventas.
                        </p>
                    </div>

                    <label className={cn(
                        'inline-flex items-center gap-2 px-4 h-10 rounded-control text-sm font-semibold cursor-pointer transition-colors',
                        'bg-accent-600 text-white hover:bg-accent-700',
                        'focus-within:outline-none focus-within:ring-2 focus-within:ring-accent-500 focus-within:ring-offset-2',
                        uploading && 'opacity-60 pointer-events-none'
                    )}>
                        {uploading ? (
                            <>
                                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
                                    <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
                                </svg>
                                Procesando…
                            </>
                        ) : (
                            <>
                                <Upload className="w-4 h-4" aria-hidden="true" />
                                Cargar imagen
                            </>
                        )}
                        <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} disabled={uploading} />
                    </label>
                </div>
            </Card>

            {/* Filtros */}
            <Card padding="sm">
                <div className="flex flex-col md:flex-row gap-2">
                    <div className="flex-1">
                        <Input
                            leftIcon={Search}
                            placeholder="Buscar por nombre o #etiqueta…"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            aria-label="Buscar imágenes"
                        />
                    </div>
                    <div className="md:w-56">
                        <Select
                            leftIcon={Filter}
                            value={selectedCategory}
                            onChange={(e) => setSelectedCategory(e.target.value)}
                            aria-label="Filtrar por categoría"
                        >
                            {categories.map(c => (
                                <option key={c} value={c}>
                                    {c === 'all' ? 'Todas las categorías' : c}
                                </option>
                            ))}
                        </Select>
                    </div>
                </div>
            </Card>

            {/* Grid */}
            <div className="flex-1 overflow-y-auto custom-scrollbar pb-6">
                {loading ? (
                    <div className="flex flex-col items-center justify-center h-full min-h-[300px] gap-3">
                        <div className="w-10 h-10 border-[3px] border-accent-200 dark:border-accent-900 border-t-accent-600 dark:border-t-accent-500 rounded-full animate-spin" />
                        <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                            Escaneando galería
                        </p>
                    </div>
                ) : filteredImages.length === 0 ? (
                    <Card padding="lg" className="border-dashed">
                        <EmptyState
                            icon={ImageIcon}
                            title="Galería vacía"
                            description="Utilizá el botón de carga para añadir imágenes."
                        />
                    </Card>
                ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                        {filteredImages.map(img => (
                            <Card key={img.id} padding="none" interactive className="group overflow-hidden flex flex-col">
                                <div className="aspect-square relative overflow-hidden bg-slate-100 dark:bg-slate-800">
                                    <img
                                        src={`${API_URL}${img.url}`}
                                        alt={img.originalName}
                                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                                        loading="lazy"
                                    />

                                    {/* Hover overlay */}
                                    <div className="absolute inset-0 bg-slate-900/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center gap-2">
                                        <IconButton
                                            label="Ver completa"
                                            icon={Maximize}
                                            variant="subtle"
                                            size="sm"
                                            onClick={() => window.open(`${API_URL}${img.url}`, '_blank')}
                                            className="!bg-white/90 !text-slate-700 hover:!bg-white"
                                        />
                                        <IconButton
                                            label="Eliminar imagen"
                                            icon={Trash2}
                                            variant="subtle"
                                            size="sm"
                                            onClick={() => handleDelete(img)}
                                            className="!bg-danger-500/90 !text-white hover:!bg-danger-600"
                                        />
                                    </div>
                                </div>

                                <div className="p-3 flex flex-col gap-2 flex-1">
                                    <p
                                        className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate"
                                        title={img.originalName}
                                    >
                                        {img.originalName}
                                    </p>

                                    <div className="flex items-center justify-between gap-2">
                                        <Badge tone="accent" size="sm">{img.category}</Badge>
                                        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500 tabular-nums">
                                            {new Date(img.createdAt).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })}
                                        </span>
                                    </div>

                                    {img.tags && img.tags.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mt-auto pt-2 border-t border-slate-100 dark:border-slate-700/60">
                                            {img.tags.slice(0, 3).map(t => (
                                                <Badge key={t} tone="neutral" size="sm">#{t}</Badge>
                                            ))}
                                            {img.tags.length > 3 && (
                                                <span className="text-[10px] text-slate-400 dark:text-slate-500 self-center">
                                                    +{img.tags.length - 3}
                                                </span>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </Card>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default GalleryView;
