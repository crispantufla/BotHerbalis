import React, { useRef, useState } from 'react';
import { Send, Paperclip, Smile, Zap, CreditCard, FileText } from 'lucide-react';
import EmojiPicker from 'emoji-picker-react';
import QuickRepliesPanel from './QuickRepliesPanel';
import MpLinkPanel from './MpLinkPanel';

const ChatInputArea = ({
    input,
    setInput,
    attachment,
    setAttachment,
    handleSend,
    handleSendMedia,
    sendingMedia,
    chatId
}) => {
    const fileInputRef = useRef(null);
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [showQuickReplies, setShowQuickReplies] = useState(false);
    const [showMpLink, setShowMpLink] = useState(false);

    const handleFileSelect = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const isImage = file.type.startsWith('image/');
        const isPdf = file.type === 'application/pdf';
        if (!isImage && !isPdf) {
            alert('Solo imágenes o PDFs');
            return;
        }
        const MAX_PDF_MB = 16;
        if (isPdf && file.size > MAX_PDF_MB * 1024 * 1024) {
            alert(`El PDF supera el límite de ${MAX_PDF_MB}MB`);
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const base64Full = reader.result;
            setAttachment({
                file,
                preview: isImage ? base64Full : null,
                base64: base64Full.split(',')[1],
                mimetype: file.type,
                kind: isPdf ? 'pdf' : 'image',
            });
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    };

    const onEmojiClick = (emojiObject) => {
        setInput(prev => prev + emojiObject.emoji);
    };

    return (
        <div className="flex-shrink-0 p-3 sm:px-6 sm:py-4 pb-[max(1rem,env(safe-area-inset-bottom))] lg:pb-4 bg-white dark:bg-slate-800 border-t border-slate-200 dark:border-slate-800 z-20 relative">
            {showQuickReplies && (
                <QuickRepliesPanel
                    onSelect={(text) => {
                        setInput(prev => prev ? prev + ' ' + text : text);
                        setShowQuickReplies(false);
                    }}
                    onClose={() => setShowQuickReplies(false)}
                />
            )}

            {showMpLink && (
                <MpLinkPanel
                    chatId={chatId}
                    onClose={() => setShowMpLink(false)}
                />
            )}

            {showEmojiPicker && (
                <div className="absolute bottom-full left-4 sm:left-6 mb-2 z-50 shadow-2xl rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700 animate-fade-in origin-bottom-left">
                    <EmojiPicker
                        onEmojiClick={onEmojiClick}
                        autoFocusSearch={false}
                        theme="auto"
                        lazyLoadEmojis={true}
                        searchPlaceHolder="Buscar emoji..."
                        width={320}
                        height={400}
                    />
                </div>
            )}

            {attachment && (
                <div className="mb-2 p-3 sm:p-4 bg-white dark:bg-slate-800/80 rounded-2xl border border-indigo-100 dark:border-indigo-900/40 shadow-sm flex items-center gap-3 sm:gap-4">
                    {attachment.kind === 'pdf' ? (
                        <div className="w-12 h-12 sm:w-16 sm:h-16 flex items-center justify-center rounded-xl bg-rose-50 dark:bg-rose-900/30 text-rose-500 dark:text-rose-400 shrink-0">
                            <FileText className="w-6 h-6 sm:w-8 sm:h-8" />
                        </div>
                    ) : (
                        <img src={attachment.preview} alt="Preview" className="w-12 h-12 sm:w-16 sm:h-16 object-cover rounded-xl" />
                    )}
                    <div className="flex-1 min-w-0">
                        <p className="font-bold text-slate-800 dark:text-slate-200 text-sm truncate">{attachment.file.name}</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                            {attachment.kind === 'pdf' ? 'PDF · ' : ''}{(attachment.file.size / 1024).toFixed(0)} KB
                        </p>
                    </div>
                    <button type="button" onClick={() => setAttachment(null)} className="p-2 bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300 hover:bg-rose-100 dark:hover:bg-rose-900/50 hover:text-rose-600 dark:hover:text-rose-400 rounded-xl transition-colors shrink-0">✕</button>
                </div>
            )}
            <form onSubmit={attachment ? (e) => { e.preventDefault(); handleSendMedia(); } : handleSend} className="flex gap-1 sm:gap-3 items-center w-full">
                <input ref={fileInputRef} type="file" accept="image/*,application/pdf" onChange={handleFileSelect} className="hidden" />

                <button type="button" onClick={() => { setShowEmojiPicker(prev => !prev); setShowQuickReplies(false); }} className={`w-9 h-9 sm:w-12 sm:h-12 flex items-center justify-center shrink-0 rounded-xl sm:rounded-2xl border transition-all shadow-sm ${showEmojiPicker ? 'bg-indigo-50 dark:bg-slate-600 border-indigo-300 dark:border-indigo-500/50 text-indigo-600 dark:text-indigo-400' : 'bg-white dark:bg-slate-700 border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-300 hover:bg-indigo-50 dark:hover:bg-slate-600'}`}>
                    <Smile className="w-4 h-4 sm:w-5 sm:h-5" />
                </button>

                <button type="button" onClick={() => { setShowQuickReplies(prev => !prev); setShowEmojiPicker(false); setShowMpLink(false); }} title="Respuestas rápidas" className={`w-9 h-9 sm:w-12 sm:h-12 flex items-center justify-center shrink-0 rounded-xl sm:rounded-2xl border transition-all shadow-sm ${showQuickReplies ? 'bg-indigo-50 dark:bg-slate-600 border-indigo-300 dark:border-indigo-500/50 text-indigo-600 dark:text-indigo-400' : 'bg-white dark:bg-slate-700 border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-300 hover:bg-indigo-50 dark:hover:bg-slate-600'}`}>
                    <Zap className="w-4 h-4 sm:w-5 sm:h-5" />
                </button>

                <button type="button" onClick={() => { setShowMpLink(prev => !prev); setShowEmojiPicker(false); setShowQuickReplies(false); }} title="Enviar link de MercadoPago" className={`w-9 h-9 sm:w-12 sm:h-12 flex items-center justify-center shrink-0 rounded-xl sm:rounded-2xl border transition-all shadow-sm ${showMpLink ? 'bg-emerald-50 dark:bg-slate-600 border-emerald-300 dark:border-emerald-500/50 text-emerald-600 dark:text-emerald-400' : 'bg-white dark:bg-slate-700 border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-300 hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-300 hover:bg-emerald-50 dark:hover:bg-slate-600'}`}>
                    <CreditCard className="w-4 h-4 sm:w-5 sm:h-5" />
                </button>

                <button type="button" onClick={() => fileInputRef.current?.click()} className="w-9 h-9 sm:w-12 sm:h-12 flex items-center justify-center shrink-0 rounded-xl sm:rounded-2xl bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:border-indigo-300 hover:bg-indigo-50 dark:hover:bg-slate-600 transition-all shadow-sm">
                    <Paperclip className="w-4 h-4 sm:w-5 sm:h-5" />
                </button>

                <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onFocus={() => { setShowEmojiPicker(false); setShowQuickReplies(false); setShowMpLink(false); }}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') { setShowEmojiPicker(false); }
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                            e.preventDefault();
                            if (attachment) handleSendMedia();
                            else handleSend(e);
                        }
                    }}
                    placeholder="Mensaje..."
                    className="w-full min-w-0 flex-1 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-xl sm:rounded-2xl px-3 sm:px-6 py-2 sm:py-4 text-slate-800 dark:text-slate-200 font-medium focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-400 outline-none transition-all shadow-inner placeholder:text-slate-400 dark:placeholder:text-slate-500 text-[15px] sm:text-base"
                />
                <button type="submit" disabled={(!input.trim() && !attachment) || sendingMedia} className="w-9 h-9 sm:w-12 sm:h-12 flex items-center justify-center shrink-0 rounded-xl sm:rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/50 hover:scale-105 active:scale-95 transition-all disabled:opacity-50 disabled:scale-100">
                    {sendingMedia ? <div className="w-4 h-4 sm:w-5 sm:h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> : <Send className="w-4 h-4 sm:w-5 sm:h-5" />}
                </button>
            </form>
        </div>
    );
};

export default ChatInputArea;
