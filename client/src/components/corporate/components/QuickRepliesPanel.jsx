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

    // Close on outside click
    useEffect(() => {
        const handler = (e) => {
            if (panelRef.current && !panelRef.current.contains(e.target)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    const fetchReplies = async () => {
        try {
            setLoading(true);
            const res = await api.get('/api/quick-replies');
            setReplies(res.data.replies || []);
        } catch (e) {
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
        } catch (e) {
            setError('Error al eliminar');
        } finally {
            setDeletingId(null);
        }
    };

    return (
        <div
            ref={panelRef}
            className="absolute bottom-full left-4 sm:left-6 mb-2 z-50 w-80 sm:w-96 shadow-2xl rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 animate-fade-in origin-bottom-left"
        >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-700">
                <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-indigo-500" />
                    <span className="font-semibold text-sm text-slate-700 dark:text-slate-200">Respuestas rápidas</span>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => { setShowForm(v => !v); setError(''); }}
                        className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 transition-colors font-medium"
                    >
                        {showForm ? <ChevronUp className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                        {showForm ? 'Cancelar' : 'Nueva'}
                    </button>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Error */}
            {error && (
                <div className="mx-3 mt-2 px-3 py-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/30 rounded-lg">
                    {error}
                </div>
            )}

            {/* Create form */}
            {showForm && (
                <form onSubmit={handleCreate} className="px-3 py-3 border-b border-slate-100 dark:border-slate-700 space-y-2">
                    <input
                        ref={titleInputRef}
                        type="text"
                        placeholder="Título (ej: Consulta de stock)"
                        value={newTitle}
                        onChange={e => setNewTitle(e.target.value)}
                        maxLength={80}
                        className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400 placeholder:text-slate-400"
                    />
                    <textarea
                        placeholder="Texto del mensaje..."
                        value={newMessage}
                        onChange={e => setNewMessage(e.target.value)}
                        rows={3}
                        maxLength={1000}
                        className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-none placeholder:text-slate-400"
                    />
                    <button
                        type="submit"
                        disabled={saving || !newTitle.trim() || !newMessage.trim()}
                        className="w-full py-2 text-sm font-semibold rounded-xl bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white transition-colors flex items-center justify-center gap-2"
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
                        <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
                    </div>
                ) : replies.length === 0 ? (
                    <div className="py-8 px-4 text-center text-sm text-slate-400 dark:text-slate-500">
                        <Zap className="w-8 h-8 mx-auto mb-2 opacity-30" />
                        Aún no tenés respuestas rápidas.<br />
                        <span className="text-indigo-500 cursor-pointer hover:underline" onClick={() => setShowForm(true)}>Creá la primera</span>
                    </div>
                ) : (
                    replies.map(reply => (
                        <div
                            key={reply.id}
                            className="flex items-center gap-2 px-3 py-2.5 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 group transition-colors"
                        >
                            <button
                                className="flex-1 text-left min-w-0"
                                onClick={() => onSelect(reply.message)}
                            >
                                <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{reply.title}</p>
                                <p className="text-xs text-slate-400 dark:text-slate-500 truncate mt-0.5">{reply.message}</p>
                            </button>
                            <button
                                onClick={() => handleDelete(reply.id)}
                                disabled={deletingId === reply.id}
                                className="shrink-0 p-1.5 rounded-lg text-slate-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/30 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-50"
                            >
                                {deletingId === reply.id
                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    : <Trash2 className="w-3.5 h-3.5" />
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
