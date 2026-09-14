import { useEffect, useState } from 'react';
import api from '../../../config/axios';

// Búsqueda de chats del sidebar: mientras se tipea filtra al instante los chats
// en memoria y, con 2+ letras, busca debounced en el backend. Devuelve la lista
// combinada para mostrar.
export function useChatSearch(chats) {
    const [searchTerm, setSearchTerm] = useState('');
    const [searchResults, setSearchResults] = useState(null);
    const [isSearching, setIsSearching] = useState(false);

    // Búsqueda debounced contra el backend (mensajes, número, nombre, fuera de memoria).
    // Mientras el usuario tipea mostramos el filtro client-side instantáneo sobre los
    // chats ya cargados; cuando llega la respuesta del backend, hacemos merge.
    useEffect(() => {
        const term = searchTerm.trim();
        if (term.length < 2) {
            setSearchResults(null);
            setIsSearching(false);
            return;
        }
        setIsSearching(true);
        const t = setTimeout(async () => {
            try {
                const res = await api.get('/api/chats/search', { params: { q: term, limit: 50 } });
                setSearchResults(res.data || []);
            } catch (e) {
                console.error('[CHATS/SEARCH] error:', e);
                setSearchResults([]);
            } finally {
                setIsSearching(false);
            }
        }, 300);
        return () => clearTimeout(t);
    }, [searchTerm]);

    // Lista derivada para mostrar:
    //   - sin búsqueda activa → chats normales (en memoria)
    //   - mientras espera el backend → filter client-side instantáneo
    //   - con resultados → merge: backend primero (con snippet) + memoria que matcheó
    //     pero no apareció en backend (clientes manuales sin User en DB).
    const filteredChats = (() => {
        const term = searchTerm.trim();
        if (!term) return chats;

        const lower = term.toLowerCase();
        const digits = term.replace(/\D/g, '');
        const inMemMatches = chats.filter(c => {
            const nameMatch = c.name?.toLowerCase().includes(lower);
            const phoneMatch = digits.length >= 4 && c.id?.replace(/\D/g, '').includes(digits);
            const messageMatch = typeof c.lastMessage?.body === 'string' && c.lastMessage.body.toLowerCase().includes(lower);
            return nameMatch || phoneMatch || messageMatch;
        });

        if (searchResults === null) return inMemMatches;

        const inMemMap = new Map(chats.map(c => [c.id, c]));
        const backendIds = new Set(searchResults.map(r => r.id));
        const enrichedBackend = searchResults.map(r => {
            const inMem = inMemMap.get(r.id);
            return {
                ...r,
                ...(inMem || {}),
                searchSnippet: r.snippet,
                searchMatchedField: r.matchedField,
                searchSnippetRole: r.snippetRole,
                hasBought: r.hasBought ?? inMem?.hasBought,
            };
        });
        const inMemOnly = inMemMatches.filter(c => !backendIds.has(c.id));
        return [...enrichedBackend, ...inMemOnly];
    })();

    return { searchTerm, setSearchTerm, searchResults, isSearching, filteredChats };
}
