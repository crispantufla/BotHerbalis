import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import ChatSidebarItem from './ChatSidebarItem';

// Alto aproximado de una fila (el real se mide al montarla).
const ROW_ESTIMATE = 68;

// Lista de chats del sidebar, virtualizada: solo se montan las filas a la vista.
// Vive en su propio componente memoizado para que escribir en la caja de mensaje
// (estado de CommsView) no la vuelva a renderizar, y para que el scroll de la
// lista no re-renderice CommsView.
//
// `alertPhones` es un Set con los `userPhone` de las alertas activas.
function ChatList({ chats, selectedChatId, alertPhones, searchTerm, onSelect }) {
    const scrollRef = useRef(null);

    const virtualizer = useVirtualizer({
        count: chats.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_ESTIMATE,
        getItemKey: (index) => chats[index]?.id ?? index,
        overscan: 8,
        paddingStart: 8,
        paddingEnd: 8,
    });

    return (
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2">
            <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
                {virtualizer.getVirtualItems().map((row) => {
                    const chat = chats[row.index];
                    if (!chat) return null;
                    const id = chat.id || '';
                    return (
                        <div
                            key={row.key}
                            ref={virtualizer.measureElement}
                            data-index={row.index}
                            className="pb-1"
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                transform: `translateY(${row.start}px)`,
                            }}
                        >
                            <ChatSidebarItem
                                chat={chat}
                                isSelected={selectedChatId === chat.id}
                                hasAlert={alertPhones.has(id) || alertPhones.has(id.split('@')[0])}
                                searchTerm={searchTerm}
                                onSelect={onSelect}
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export default React.memo(ChatList);
