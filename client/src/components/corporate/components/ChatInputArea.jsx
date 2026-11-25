import React, { useRef, useState, useLayoutEffect, lazy, Suspense } from 'react';
import { Send, Paperclip, Smile, Zap, CreditCard, FileText } from 'lucide-react';
import QuickRepliesPanel from './QuickRepliesPanel';
import MpLinkPanel from './MpLinkPanel';
import LazyBoundary from '../../ui/LazyBoundary';
import { useToast } from '../../ui/Toast';

// El selector de emojis (~300 KB con sus datos) se descarga la primera vez que se abre.
const EmojiPicker = lazy(() => import('emoji-picker-react'));

// Alto máximo de la caja de mensaje (igual a max-h-40); pasado eso, scrollea.
const MAX_INPUT_HEIGHT = 160;

// Botones de la fila: 44px en móvil (objetivo táctil), 48px desde `sm`.
const TOOL_BTN = 'w-11 h-11 sm:w-12 sm:h-12 items-center justify-center shrink-0 rounded-xl sm:rounded-2xl border transition-colors shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500';
const TOOL_IDLE = 'bg-white dark:bg-slate-700 border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-300 hover:bg-accent-50 dark:hover:bg-slate-600';
const TOOL_IDLE_ACCENT = `${TOOL_IDLE} hover:text-accent-600 dark:hover:text-accent-400 hover:border-accent-300`;
const TOOL_ON_ACCENT = 'bg-accent-50 dark:bg-slate-600 border-accent-300 dark:border-accent-500/50 text-accent-600 dark:text-accent-400';
const TOOL_IDLE_SUCCESS = 'bg-white dark:bg-slate-700 border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-300 hover:text-success-600 dark:hover:text-success-500 hover:border-success-500/50 hover:bg-success-50 dark:hover:bg-slate-600';
const TOOL_ON_SUCCESS = 'bg-success-50 dark:bg-slate-600 border-success-500/50 text-success-600 dark:text-success-500';

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
    const { toast } = useToast();
    const fileInputRef = useRef(null);
    const textareaRef = useRef(null);
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [showQuickReplies, setShowQuickReplies] = useState(false);
    const [showMpLink, setShowMpLink] = useState(false);

    // La caja crece con el texto: los pasos del guion tienen varias líneas.
    useLayoutEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        const borders = el.offsetHeight - el.clientHeight;
        el.style.height = `${Math.min(el.scrollHeight + borders, MAX_INPUT_HEIGHT)}px`;
    }, [input]);

    // El mismo criterio que el botón de enviar: sin texto ni adjunto, o mientras
    // sube un adjunto, Enter no manda nada (antes Ctrl+Enter podía mandar dos veces).
    const canSend = (input.trim() || attachment) && !sendingMedia;

    const handleFileSelect = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const isImage = file.type.startsWith('image/');
        const isPdf = file.type === 'application/pdf';
        if (!isImage && !isPdf) {
            toast.warning('Solo se pueden adjuntar imágenes o PDFs');
            e.target.value = '';
            return;
        }
        const MAX_PDF_MB = 16;
        if (isPdf && file.size > MAX_PDF_MB * 1024 * 1024) {
            toast.warning(`El PDF supera el límite de ${MAX_PDF_MB} MB`);
            e.target.value = '';
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

    // En el teléfono, mientras se escribe, el link de MP y el adjunto se
    // esconden para darle el ancho a la caja (con los tres botones quedaba en
    // ~126px a 375). Vuelven apenas la caja queda vacía.
    const typing = (input || '').trim().length > 0;

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
                <div className="absolute bottom-full left-4 sm:left-6 mb-2 z-50 shadow-2xl rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-700 animate-fade-in motion-reduce:animate-none origin-bottom-left">
                    <LazyBoundary fallback={<p className="w-[320px] p-4 text-xs text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-800">No se pudieron cargar los emojis. Recargá la página.</p>}>
                        <Suspense fallback={<div className="w-[320px] h-[400px] bg-white dark:bg-slate-800" />}>
                            <EmojiPicker
                                onEmojiClick={onEmojiClick}
                                autoFocusSearch={false}
                                theme="auto"
                                lazyLoadEmojis={true}
                                searchPlaceHolder="Buscar emoji..."
                                width={320}
                                height={400}
                            />
                        </Suspense>
                    </LazyBoundary>
                </div>
            )}

            {attachment && (
                <div className="mb-2 p-3 sm:p-4 bg-white dark:bg-slate-800/80 rounded-2xl border border-accent-100 dark:border-accent-900/40 shadow-sm flex items-center gap-3 sm:gap-4">
                    {attachment.kind === 'pdf' ? (
                        <div className="w-12 h-12 sm:w-16 sm:h-16 flex items-center justify-center rounded-xl bg-danger-50 dark:bg-danger-900/30 text-danger-500 shrink-0">
                            <FileText className="w-6 h-6 sm:w-8 sm:h-8" aria-hidden="true" />
                        </div>
                    ) : (
                        <img src={attachment.preview} alt="Vista previa del adjunto" className="w-12 h-12 sm:w-16 sm:h-16 object-cover rounded-xl" />
                    )}
                    <div className="flex-1 min-w-0">
                        <p className="font-bold text-slate-800 dark:text-slate-200 text-sm truncate">{attachment.file.name}</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                            {attachment.kind === 'pdf' ? 'PDF · ' : ''}{(attachment.file.size / 1024).toFixed(0)} KB
                        </p>
                    </div>
                    <button type="button" aria-label="Quitar adjunto" title="Quitar adjunto" onClick={() => setAttachment(null)} className="w-11 h-11 sm:w-9 sm:h-9 flex items-center justify-center bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300 hover:bg-danger-100 dark:hover:bg-danger-900/50 hover:text-danger-600 dark:hover:text-danger-500 rounded-xl transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-danger-500"><span aria-hidden="true">✕</span></button>
                </div>
            )}
            <form onSubmit={attachment ? (e) => { e.preventDefault(); handleSendMedia(); } : handleSend} className="flex gap-1.5 sm:gap-3 items-end w-full">
                <input ref={fileInputRef} type="file" accept="image/*,application/pdf" onChange={handleFileSelect} className="hidden" />

                {/* Emojis: desde `sm`. En el teléfono los da el teclado y el botón le
                    sacaba ancho a la caja de mensaje (a 360px quedaban ~95px). */}
                <button type="button" aria-label="Emojis" title="Emojis" aria-expanded={showEmojiPicker} onClick={() => { setShowEmojiPicker(prev => !prev); setShowQuickReplies(false); setShowMpLink(false); }} className={`hidden sm:flex ${TOOL_BTN} ${showEmojiPicker ? TOOL_ON_ACCENT : TOOL_IDLE_ACCENT}`}>
                    <Smile className="w-5 h-5" aria-hidden="true" />
                </button>

                <button type="button" aria-label="Respuestas rápidas" title="Respuestas rápidas" aria-expanded={showQuickReplies} onClick={() => { setShowQuickReplies(prev => !prev); setShowEmojiPicker(false); setShowMpLink(false); }} className={`flex ${TOOL_BTN} ${showQuickReplies ? TOOL_ON_ACCENT : TOOL_IDLE_ACCENT}`}>
                    <Zap className="w-5 h-5" aria-hidden="true" />
                </button>

                <button type="button" aria-label="Enviar link de MercadoPago" title="Enviar link de MercadoPago" aria-expanded={showMpLink} onClick={() => { setShowMpLink(prev => !prev); setShowEmojiPicker(false); setShowQuickReplies(false); }} className={`${typing ? 'hidden sm:flex' : 'flex'} ${TOOL_BTN} ${showMpLink ? TOOL_ON_SUCCESS : TOOL_IDLE_SUCCESS}`}>
                    <CreditCard className="w-5 h-5" aria-hidden="true" />
                </button>

                <button type="button" aria-label="Adjuntar imagen o PDF" title="Adjuntar imagen o PDF" onClick={() => fileInputRef.current?.click()} className={`${typing ? 'hidden sm:flex' : 'flex'} ${TOOL_BTN} ${TOOL_IDLE_ACCENT}`}>
                    <Paperclip className="w-5 h-5" aria-hidden="true" />
                </button>

                <textarea
                    ref={textareaRef}
                    rows={1}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onFocus={() => { setShowEmojiPicker(false); setShowQuickReplies(false); setShowMpLink(false); }}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') { setShowEmojiPicker(false); }
                        // Enter envía; Shift+Enter agrega un salto de línea. Mientras un
                        // teclado IME está componiendo, Enter confirma el carácter y no envía.
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            if (!canSend) return;
                            if (attachment) handleSendMedia();
                            else handleSend(e);
                        }
                    }}
                    enterKeyHint="send"
                    placeholder="Mensaje..."
                    aria-label="Mensaje"
                    className="block w-full min-w-0 flex-1 resize-none max-h-40 overflow-y-auto bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-xl sm:rounded-2xl px-3 sm:px-6 py-2.5 sm:py-4 text-slate-800 dark:text-slate-200 font-medium leading-snug focus:ring-4 focus:ring-accent-500/20 focus:border-accent-400 outline-none transition-[border-color,box-shadow] shadow-inner placeholder:text-slate-400 dark:placeholder:text-slate-500 text-base"
                />
                <button type="submit" disabled={!canSend} aria-label={sendingMedia ? 'Enviando adjunto' : 'Enviar'} title="Enviar" className="w-11 h-11 sm:w-12 sm:h-12 flex items-center justify-center shrink-0 rounded-xl sm:rounded-2xl bg-accent-600 text-white shadow-lg shadow-accent-500/30 hover:shadow-accent-500/50 hover:scale-105 active:scale-95 motion-reduce:transform-none transition-all disabled:opacity-50 disabled:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-800">
                    {sendingMedia ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" aria-hidden="true"></div> : <Send className="w-5 h-5" aria-hidden="true" />}
                </button>
            </form>
        </div>
    );
};

export default ChatInputArea;
