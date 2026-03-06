import React, { useRef, useLayoutEffect, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Trash2 as Trash, Play, AlertTriangle } from 'lucide-react';
import { API_URL } from '../../../../config/api';

const formatDateSeparator = (date) => {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Normalize to midnight for accurate day comparison
    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);
    const todayNormalized = new Date(today);
    todayNormalized.setHours(0, 0, 0, 0);
    const yesterdayNormalized = new Date(yesterday);
    yesterdayNormalized.setHours(0, 0, 0, 0);

    if (targetDate.getTime() === todayNormalized.getTime()) {
        return 'Hoy';
    } else if (targetDate.getTime() === yesterdayNormalized.getTime()) {
        return 'Ayer';
    } else {
        // Formato dd/mm/yyyy
        return targetDate.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
};

const ChatMessageList = ({ messages, isLoading, chatFontSize, handleDeleteMessage, handleReportMessage, onScrollBottom }) => {
    const parentRef = useRef(null);

    const rowVirtualizer = useVirtualizer({
        count: messages.length,
        getScrollElement: () => parentRef.current,
        // Increment estimated size if there tends to be date dividers
        estimateSize: () => 80,
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

    const virtualItems = rowVirtualizer.getVirtualItems();
    let floatingDateText = '';

    if (virtualItems.length > 0) {
        const scrollOffset = parentRef.current ? parentRef.current.scrollTop : 0;
        let topVisibleRow = virtualItems[0];
        for (const item of virtualItems) {
            // Buscamos el primer mensaje que aún sea visible en pantalla
            if (item.end > scrollOffset) {
                topVisibleRow = item;
                break;
            }
        }
        const msg = messages[topVisibleRow.index];
        if (msg && msg.timestamp) {
            floatingDateText = formatDateSeparator(msg.timestamp);
        }
    }

    return (
        <div ref={parentRef} className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-8 pt-4 pb-2 custom-scrollbar relative z-10 w-full">
            {floatingDateText && (
                <div className="sticky top-2 z-50 flex justify-center mb-[-28px] pointer-events-none">
                    <div className="bg-slate-200/95 dark:bg-slate-700/95 backdrop-blur-md px-4 py-1.5 rounded-full text-[11px] font-medium text-slate-600 dark:text-slate-300 shadow-sm border border-slate-300/50 dark:border-slate-600/50">
                        {floatingDateText}
                    </div>
                </div>
            )}

            <div
                style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                }}
            >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const msg = messages[virtualRow.index];
                    const prevMsg = virtualRow.index > 0 ? messages[virtualRow.index - 1] : null;

                    let showDateSeparator = false;
                    let dateSeparatorText = '';

                    if (msg && msg.timestamp) {
                        const msgDate = new Date(msg.timestamp).toDateString();
                        const prevMsgDate = prevMsg && prevMsg.timestamp ? new Date(prevMsg.timestamp).toDateString() : null;

                        if (!prevMsgDate || msgDate !== prevMsgDate) {
                            showDateSeparator = true;
                            dateSeparatorText = formatDateSeparator(msg.timestamp);
                        }
                    }

                    return (
                        <div
                            key={virtualRow.key}
                            ref={rowVirtualizer.measureElement}
                            data-index={virtualRow.index}
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                transform: `translateY(${virtualRow.start}px)`,
                                paddingBottom: '32px', // increased slightly to give breathing room for long messages
                            }}
                        >
                            {showDateSeparator && (
                                <div className="flex justify-center mb-6 mt-2">
                                    <div className="bg-slate-200/80 dark:bg-slate-700/60 px-4 py-1.5 rounded-full text-[11px] font-medium text-slate-600 dark:text-slate-300 border border-transparent">
                                        {dateSeparatorText}
                                    </div>
                                </div>
                            )}

                            <div className={`flex ${msg.fromMe ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[75%] p-4 leading-relaxed shadow-sm relative group ${msg.fromMe ? 'bg-gradient-to-br from-indigo-600 to-purple-600 text-white rounded-3xl rounded-tr-sm shadow-indigo-500/20' : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-3xl rounded-tl-sm border border-slate-100 dark:border-slate-700'}`} style={{ fontSize: `${chatFontSize}px` }}>
                                    {renderMessageBody(msg)}
                                    <span className={`text-[10px] block text-right mt-2 font-mono font-bold ${msg.fromMe ? 'text-indigo-200' : 'text-slate-400'}`}>
                                        {new Date(msg.timestamp).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' })}
                                    </span>
                                    {msg.fromMe && (
                                        <div className="absolute -left-16 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-40 group-hover:opacity-100 transition-opacity">
                                            <button
                                                onClick={(e) => { e.stopPropagation(); if (typeof handleReportMessage === 'function') handleReportMessage(msg.id); }}
                                                className="p-1.5 text-amber-500 hover:text-white hover:bg-amber-500 rounded-full transition-all shadow-sm"
                                                title="Reportar mensaje incorrecto a la IA"
                                            >
                                                <AlertTriangle className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={(e) => { e.stopPropagation(); handleDeleteMessage(msg.id); }}
                                                className="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-full transition-all shadow-sm"
                                                title="Eliminar mensaje para todos"
                                            >
                                                <Trash className="w-4 h-4" />
                                            </button>
                                        </div>
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
