import { useEffect, useState } from 'react';
import api from '../../../config/axios';
import { useSocket } from '../../../context/SocketContext';
import { useToast } from '../../ui';

// Un ajuste on/off de Configuración: carga su valor, escucha el evento del socket
// (otro admin lo cambió) y lo cambia con update optimista — el switch se mueve ya y
// vuelve atrás si el backend falla.
// `defaultValue` también decide cómo se lee la respuesta: si es true, solo un
// `false` explícito lo apaga; si es false, cualquier valor verdadero lo prende.
export function useSettingSwitch({ endpoint, field, socketEvent, defaultValue, onText, offText }) {
    const { socket } = useSocket();
    const { toast } = useToast();
    const [value, setValue] = useState(defaultValue);
    const [toggling, setToggling] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const res = await api.get(endpoint);
                const v = res.data[field];
                setValue(defaultValue ? v !== false : !!v);
            } catch (e) { console.error(`Error loading ${endpoint}:`, e); }
        })();
    }, [endpoint, field, defaultValue]);

    useEffect(() => {
        if (!socket) return;
        const onChanged = (data) => { if (typeof data?.[field] === 'boolean') setValue(data[field]); };
        socket.on(socketEvent, onChanged);
        return () => { socket.off(socketEvent, onChanged); };
    }, [socket, socketEvent, field]);

    const toggle = async () => {
        if (toggling) return;
        const next = !value;
        setToggling(true);
        setValue(next);
        try {
            await api.post(endpoint, { enabled: next });
            toast.success(next ? onText : offText);
        } catch (e) {
            setValue(!next);
            toast.error(e.response?.data?.error || 'Error al cambiar el ajuste');
        }
        setToggling(false);
    };

    return { value, toggle, toggling };
}
