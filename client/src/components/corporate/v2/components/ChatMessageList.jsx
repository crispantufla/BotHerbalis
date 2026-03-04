import React, { useRef, useLayoutEffect, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Trash2 as Trash, Play } from 'lucide-react';
import { API_URL } from '../../../../config/api';

const ChatMessageList = ({ messages, isLoading, chatFontSize, handleDeleteMessage, onScrollBottom }) => {
    const parentRef = useRef(null);

    const rowVirtualizer = useVirtualizer({
        count: messages.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => 64, // estimated message height
        overscan: 10,
    });

    // Auto scroll to bottom when new messages arrive
    useEffect(() => {
        if (messages.length > 0) {
            rowVirtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
        }
    }, [messages.length, rowVirtualizer]);

    const renderMessageBody = (msg) => {
        if (msg.body && msg.body.startsWith('MEDIA_IMAGE:')) {
            const url = msg.body.split('|')[0].replace('MEDIA_IMAGE:', '');
            return <img src={`${API_URL}${url}`} alt="Media" className="rounded-2xl max-w-full h-auto max-h-64 object-cover border border-white/2 dark:border-slate-700/20 shadow-sm" />;
        }
        if (msg.body && (msg.body.startsWith('MEDIA_AUDIO:') || msg.body.startsWith('🎤'))) {
            let audioUrl = '';
            let transcription = msg.body.includes('TRANSCRIPTION:') ? msg.body.split('TRANSCRIPTION:')[1].trim() : msg.body.replace(/^🎤\s*Audio:\s*/, '').replace(/^"|"$/g, '').trim();

            if (msg.body.startsWith('MEDIA_AUDIO:')) {
                audioUrl = msg.body.split('|')[0].replace('MEDIA_AUDIO:', '').trim();
            }

            return (
                <div className="space-y-3 min-w-[200px] sm:min-w-[250px]">
                    {audioUrl && audioUrl !== 'PENDING' ? (
                        <div className="bg-black/5 dark:bg-white/5 rounded-2xl p-2 border border-white/10 dark:border-slate-700/30">
                            <audio
                                controls
                                preload="metadata"
                                className="w-full h-10 drop-shadow-sm [&::-webkit-media-controls-panel]:bg-emerald-50 [&::-webkit-media-controls-play-button]:bg-emerald-500 [&::-webkit-media-controls-play-button]:rounded-full [&::-webkit-media-controls-current-time-display]:text-emerald-700 [&::-webkit-media-controls-time-remaining-display]:text-emerald-700 pl-1"
                                src={`${API_URL}${audioUrl}`}
                            >
                                Tu navegador no soporta el elemento de audio.
                            </audio>
                        </div>
                    ) : (
                        <div className="flex items-center gap-3 bg-black/10 rounded-2xl p-3 border border-white/1 dark:border-slate-700/10">
                            <div className="w-10 h-10 rounded-full bg-slate-400/90 text-white flex items-center justify-center shadow-lg"><Play className="w-5 h-5" /></div>
                            <div className="flex-1 h-2 bg-black/10 rounded-full overflow-hidden text-slate-500 font-mono text-[8px] leading-none text-center">Audio PENDING...</div>
                        </div>
                    )}
                    {transcription && transcription !== 'PENDING' && (
                        <div className="bg-white/4 dark:bg-slate-800/40 p-3 rounded-xl text-xs flex items-start gap-2 text-slate-700 dark:text-slate-300 font-medium">
                            <span className="text-emerald-600 mt-0.5">📝</span>
                            <span className="italic leading-relaxed flex-1">"{transcription}"</span>
                        </div>
                    )}
                </div>
            );
        }
        return <p className="whitespace-pre-wrap font-medium">{msg.body}</p>;
    };

    if (isLoading) {
        return (
            <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 pt-8 pb-2 space-y-6 custom-scrollbar relative z-10 w-full h-full flex flex-col justify-end">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className={`flex ${i % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
                        <div className="w-64 h-16 bg-slate-200 dark:bg-slate-700/50 rounded-3xl animate-pulse"></div>
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 pt-8 pb-2 custom-scrollbar relative z-10 w-full">
            <div
                style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                }}
            >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const msg = messages[virtualRow.index];
                    return (
                        <div
                            key={virtualRow.index}
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                transform: `translateY(${virtualRow.start}px)`,
                                paddingBottom: '24px', // acts like space-y-6
                            }}
                        >
                            <div className={`flex ${msg.fromMe ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[75%] p-4 leading-relaxed shadow-sm relative group ${msg.fromMe ? 'bg-gradient-to-br from-indigo-600 to-purple-600 text-white rounded-3xl rounded-tr-sm shadow-indigo-500/20' : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-3xl rounded-tl-sm border border-slate-100 dark:border-slate-700'}`} style={{ fontSize: `${chatFontSize}px` }}>
                                    {renderMessageBody(msg)}
                                    <span className={`text-[10px] block text-right mt-2 font-mono font-bold ${msg.fromMe ? 'text-indigo-200' : 'text-slate-400'}`}>
                                        {new Date(msg.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' })}
                                    </span>
                                    {msg.fromMe && (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleDeleteMessage(msg.id); }}
                                            className="absolute -left-9 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-full transition-all opacity-0 group-hover:opacity-100"
                                            title="Eliminar mensaje para todos"
                                        >
                                            <Trash className="w-5 h-5" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default ChatMessageList;
