import { useEffect, useState } from 'react';
import api from '../../../config/axios';

// El guion activo y los precios del Editor, para el panel de guion y los textos
// que se insertan. V7 es el único guion desde may-2026: los chats viejos con
// assignedScript 'v5'/'v6' grabado también ven V7.
export function useScriptFlow() {
    const [scriptFlow, setScriptFlow] = useState({});
    const [prices, setPrices] = useState(null);

    useEffect(() => {
        (async () => {
            try {
                const [scriptV7, pricesRes] = await Promise.all([
                    api.get('/api/script/v7'),
                    api.get('/api/prices'),
                ]);
                setScriptFlow(scriptV7.data?.flow || {});
                if (pricesRes.data) setPrices(pricesRes.data);
            } catch (e) { console.error('Error fetching scripts:', e); }
        })();
    }, []);

    return { scriptFlow, prices };
}
