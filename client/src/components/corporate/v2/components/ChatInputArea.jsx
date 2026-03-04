import React, { useRef } from 'react';
import { Send, Paperclip } from 'lucide-react';

const ChatInputArea = ({
    input,
    setInput,
    attachment,
    setAttachment,
    handleSend,
    handleSendMedia,
    sendingMedia
}) => {
    const fileInputRef = useRef(null);

    const handleFileSelect = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            alert('Solo imágenes');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const base64Full = reader.result;
            setAttachment({ file, preview: base64Full, base64: base64Full.split(',')[1], mimetype: file.type });
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    };

    return (
        <div className="flex-shrink-0 p-3 sm:px-6 sm:py-4 pb-[max(1rem,env(safe-area-inset-bottom))] lg:pb-4 bg-white dark:bg-slate-800 border-t border-slate-200 dark:border-slate-800 z-20">
            {attachment && (
                <div className="mb-2 p-3 sm:p-4 bg-white/8 dark:bg-slate-800/80 rounded-2xl border border-indigo-100 shadow-sm flex items-center gap-4">
                    <img src={attachment.preview} alt="Preview" className="w-12 h-12 sm:w-16 sm:h-16 object-cover rounded-xl" />
                    <div className="flex-1 min-w-0">
                        <p className="font-bold text-slate-800 dark:text-slate-200 text-sm truncate">{attachment.file.name}</p>
                        <p className="text-xs text-slate-500">{(attachment.file.size / 1024).toFixed(0)} KB</p>
                    </div>
                    <button type="button" onClick={() => setAttachment(null)} className="p-2 sm:p-2 bg-slate-100 dark:bg-slate-700 hover:bg-rose-100 dark:hover:bg-rose-900/50 hover:text-rose-600 dark:text-slate-300 rounded-xl transition-colors shrink-0">✕</button>
                </div>
            )}
            <form onSubmit={attachment ? (e) => { e.preventDefault(); handleSendMedia(); } : handleSend} className="flex gap-1.5 sm:gap-4 items-center w-full">
                <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileSelect} className="hidden" />
                <button type="button" onClick={() => fileInputRef.current?.click()} className="w-11 h-11 sm:w-14 sm:h-14 flex items-center justify-center shrink-0 rounded-xl sm:rounded-2xl bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-300 hover:bg-indigo-50 dark:hover:bg-slate-600 transition-all shadow-sm">
                    <Paperclip className="w-6 h-6" />
                </button>
                <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Mensaje..."
                    className="w-full min-w-0 flex-1 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-xl sm:rounded-2xl px-3 sm:px-6 py-2.5 sm:py-4 text-slate-800 dark:text-slate-200 font-medium focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all shadow-inner placeholder:text-slate-400 text-[15px] sm:text-base"
                />
                <button type="submit" disabled={(!input.trim() && !attachment) || sendingMedia} className="w-11 h-11 sm:w-14 sm:h-14 flex items-center justify-center shrink-0 rounded-xl sm:rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:scale-105 active:scale-95 transition-all disabled:opacity-50 disabled:scale-100">
                    {sendingMedia ? <div className="w-5 h-5 sm:w-6 sm:h-6 border-2 border-white/5 dark:border-slate-700/50 border-t-white rounded-full animate-spin"></div> : <Send className="w-5 h-5" />}
                </button>
            </form>
        </div>
    );
};

export default ChatInputArea;
