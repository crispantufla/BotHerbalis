import React, { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, X, Zap, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import api from '../../../config/axios';

const QuickRepliesPanel = ({ onSelect, onClose }) => {
    const [replies, setReplies] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newMessage, setNewMessage] = useState('');
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState(null);
    const [error, setError] = useState('');
    const panelRef = useRef(null);
    const titleInputRef = useRef(null);

    useEffect(() => {
        fetchReplies();
    }, []);

    useEffect(() => {
        if (showForm) titleInputRef.current?.focus();
    }, [showForm]);

    // Se cierra al tocar fuera o con Escape
    useEffect(() => {
        const handler = (e) => {
            if (panelRef.current && !panelRef.current.contains(e.target)) {
                onClose();
            }
        };
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('mousedown', handler);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', handler);
            document.removeEventListener('keydown', onKey);
        };
    }, [onClose]);

    const fetchReplies = async () => {
        try {
            setLoading(true);
            const res = await api.get('/api/quick-replies');
            setReplies(res.data.replies || []);
        } catch {
            setError('No se pudieron cargar las respuestas');
        } finally {
            setLoading(false);
        }
    };

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!newTitle.trim() || !newMessage.trim()) return;
        try {
            setSaving(true);
            setError('');
            const res = await api.post('/api/quick-replies', {
                title: newTitle.trim(),
                message: newMessage.trim(),
            });
            setReplies(prev => [...prev, res.data.reply]);
            setNewTitle('');
            setNewMessage('');
            setShowForm(false);
        } catch (e) {
            setError(e.response?.data?.error || 'Error al guardar');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (id) => {
        try {
            setDeletingId(id);
            await api.delete(`/api/quick-replies/${id}`);
            setReplies(prev => prev.filter(r => r.id !== id));
        } catch {
            setError('Error al eliminar');
        } finally {
            setDeletingId(null);
        }
    };

    return (
        <div
            ref={panelRef}
            className="absolute bottom-full left-4 sm:left-6 mb-2 z-50 w-80 sm:w-96 max-w-[calc(100vw-2rem)] shadow-2xl rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 animate-fade-in motion-reduce:animate-none origin-bottom-left"
        >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-700">
                <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-accent-500" aria-hidden="true" />
                    <span className="font-semibold text-sm text-slate-700 dark:text-slate-200">Respuestas rápidas</span>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        aria-expanded={showForm}
                        onClick={() => { setShowForm(v => !v); setError(''); }}
                        className="flex items-center gap-1 text-xs px-2.5 min-h-[2.5rem] md:min-h-0 md:py-1.5 rounded-lg bg-accent-50 dark:bg-accent-900/40 text-accent-600 dark:text-accent-400 hover:bg-accent-100 dark:hover:bg-accent-900/60 transition-colors font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                    >
                        {showForm ? <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" /> : <Plus className="w-3.5 h-3.5" aria-hidden="true" />}
                        {showForm ? 'Cancelar' : 'Nueva'}
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Cerrar"
                        title="Cerrar"
                        className="w-10 h-10 md:w-7 md:h-7 flex items-center justify-center shrink-0 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                    >
                        <X className="w-4 h-4" aria-hidden="true" />
                    </button>
                </div>
            </div>

            {/* Error */}
            {error && (
                <div role="alert" className="mx-3 mt-2 px-3 py-2 text-xs text-danger-600 dark:text-danger-500 bg-danger-50 dark:bg-danger-900/30 rounded-lg">
                    {error}
                </div>
            )}

            {/* Create form */}
            {showForm && (
                <form onSubmit={handleCreate} className="px-3 py-3 border-b border-slate-100 dark:border-slate-700 space-y-2">
                    <input
                        ref={titleInputRef}
                        type="text"
                        aria-label="Título de la respuesta rápida"
                        placeholder="Título (ej: Consulta de stock)"
                        value={newTitle}
                        onChange={e => setNewTitle(e.target.value)}
                        maxLength={80}
                        className="w-full px-3 py-2 text-base md:text-sm rounded-xl border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-accent-400 placeholder:text-slate-400"
                    />
                    <textarea
                        aria-label="Texto del mensaje"
                        placeholder="Texto del mensaje..."
                        value={newMessage}
                        onChange={e => setNewMessage(e.target.value)}
                        rows={3}
                        maxLength={1000}
                        className="w-full px-3 py-2 text-base md:text-sm rounded-xl border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-accent-400 resize-none placeholder:text-slate-400"
                    />
                    <button
                        type="submit"
                        disabled={saving || !newTitle.trim() || !newMessage.trim()}
                        className="w-full min-h-[2.75rem] md:min-h-0 py-2 text-sm font-semibold rounded-xl bg-accent-500 hover:bg-accent-600 disabled:opacity-50 text-white transition-colors flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-800"
                    >
                        {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        Guardar
                    </button>
                </form>
            )}

            {/* Replies list */}
            <div className="max-h-72 overflow-y-auto divide-y divide-slate-50 dark:divide-slate-700/50">
                {loading ? (
                    <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-5 h-5 animate-spin text-accent-400" aria-label="Cargando" />
                    </div>
                ) : replies.length === 0 ? (
                    <div className="py-8 px-4 text-center text-sm text-slate-500 dark:text-slate-400">
                        <Zap className="w-8 h-8 mx-auto mb-2 opacity-30" aria-hidden="true" />
                        Aún no tenés respuestas rápidas.<br />
                        <button
                            type="button"
                            onClick={() => setShowForm(true)}
                            className="mt-1 px-2 min-h-[2.5rem] md:min-h-0 rounded-lg font-medium text-accent-600 dark:text-accent-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                        >
                            Creá la primera
                        </button>
                    </div>
                ) : (
                    replies.map(reply => (
                        <div
                            key={reply.id}
                            className="flex items-center gap-2 px-3 py-2.5 hover:bg-accent-50 dark:hover:bg-accent-900/20 group transition-colors"
                        >
                            <button
                                type="button"
                                className="flex-1 text-left min-w-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                                onClick={() => onSelect(reply.message)}
                            >
                                <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{reply.title}</p>
                                <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">{reply.message}</p>
                            </button>
                            {/* Siempre visible en táctil (no hay hover); en escritorio aparece
                                al pasar el mouse o al recibir foco. */}
                            <button
                                type="button"
                                onClick={() => handleDelete(reply.id)}
                                disabled={deletingId === reply.id}
                                aria-label={`Eliminar la respuesta rápida "${reply.title}"`}
                                title="Eliminar"
                                className="shrink-0 w-10 h-10 md:w-7 md:h-7 flex items-center justify-center rounded-lg text-slate-400 dark:text-slate-500 hover:text-danger-600 dark:hover:text-danger-500 hover:bg-danger-50 dark:hover:bg-danger-900/30 opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 transition-all disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-danger-500"
                            >
                                {deletingId === reply.id
                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                                    : <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                }
                            </button>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};

export default QuickRepliesPanel;
