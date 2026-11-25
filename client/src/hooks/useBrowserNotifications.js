// Avisos del navegador (Notification API) para cuando el panel está abierto pero
// en segundo plano: otra pestaña, la ventana minimizada o tapada.
//
// Esto NO es push. Con el panel cerrado no llega nada: el aviso lo dispara el
// socket de esta misma página. Push de verdad exige un service worker, claves
// VAPID en el servidor y una tabla con la suscripción de cada dispositivo; nada
// de eso existe hoy. Por lo mismo, Chrome en Android no deja crear una
// `Notification` desde la página (pide service worker): ahí `new Notification`
// tira y el aviso simplemente no sale.
//
// Reglas:
//  - Nunca pide permiso solo: `setEnabled(true)` se llama desde un clic.
//  - Solo avisa con la página oculta (`document.visibilityState !== 'visible'`).
//  - No repite una alerta (por id) y no avisa las que ya estaban al cargar:
//    quien lo usa las pasa por `markSeen`.
//  - La preferencia es por dispositivo y vive en localStorage.
import { useCallback, useEffect, useRef, useState } from 'react';

const PREF_KEY = 'herbalis_browser_notifications';

const isSupported = () => typeof window !== 'undefined' && 'Notification' in window;

const readPermission = () => (isSupported() ? window.Notification.permission : 'unsupported');

const readPref = () => {
    try { return window.localStorage.getItem(PREF_KEY) === '1'; } catch { return false; }
};

const writePref = (value) => {
    try { window.localStorage.setItem(PREF_KEY, value ? '1' : '0'); } catch { /* modo privado: queda solo en memoria */ }
};

// El backend manda un id por alerta; el respaldo cubre una que llegue sin él.
const alertKey = (alert) => String(alert?.id ?? `${alert?.userPhone || ''}|${alert?.reason || ''}`);

const phoneOf = (alert) => (alert?.userPhone ? String(alert.userPhone).split('@')[0] : '');

export default function useBrowserNotifications({ onOpen } = {}) {
    const supported = isSupported();
    const [permission, setPermission] = useState(readPermission);
    const [wanted, setWanted] = useState(() => isSupported() && readPref());
    const enabled = supported && wanted && permission === 'granted';

    const seenRef = useRef(new Set());
    const enabledRef = useRef(enabled);
    const onOpenRef = useRef(onOpen);
    useEffect(() => {
        enabledRef.current = enabled;
        onOpenRef.current = onOpen;
    });

    // El permiso se puede cambiar desde los ajustes del sitio con el panel abierto:
    // se relee al volver a la pestaña.
    useEffect(() => {
        if (!supported) return;
        const sync = () => setPermission(readPermission());
        document.addEventListener('visibilitychange', sync);
        window.addEventListener('focus', sync);
        return () => {
            document.removeEventListener('visibilitychange', sync);
            window.removeEventListener('focus', sync);
        };
    }, [supported]);

    // Alertas que ya se conocen (las de la carga inicial, las de `alerts_updated`):
    // quedan anotadas para no avisarlas después.
    const markSeen = useCallback((list) => {
        if (!Array.isArray(list)) return;
        for (const alert of list) seenRef.current.add(alertKey(alert));
    }, []);

    // Para una alerta que acaba de llegar por socket.
    const notify = useCallback((alert) => {
        if (!alert) return;
        const key = alertKey(alert);
        if (seenRef.current.has(key)) return;
        seenRef.current.add(key);
        if (!enabledRef.current) return;
        if (typeof document === 'undefined' || document.visibilityState === 'visible') return;
        if (readPermission() !== 'granted') return;
        try {
            const body = [alert.reason, phoneOf(alert)].filter(Boolean).join(' · ');
            const notification = new window.Notification('Un chat necesita atención', {
                body,
                tag: `herbalis-alert-${key}`,
                icon: '/logo.svg',
            });
            notification.onclick = () => {
                try { window.focus(); } catch { /* el navegador puede negarlo */ }
                notification.close();
                onOpenRef.current?.(alert);
            };
        } catch { /* Android Chrome sin service worker, o el sistema las tiene apagadas */ }
    }, []);

    // Llamar SOLO desde un clic: prender puede abrir el pedido de permiso.
    const setEnabled = useCallback(async (next) => {
        if (!isSupported()) return;
        if (!next) {
            setWanted(false);
            writePref(false);
            return;
        }
        let current = readPermission();
        if (current === 'default') {
            try {
                current = await window.Notification.requestPermission();
            } catch {
                current = readPermission();
            }
        }
        setPermission(current);
        const granted = current === 'granted';
        setWanted(granted);
        writePref(granted);
    }, []);

    return {
        supported,
        permission,              // 'granted' | 'denied' | 'default' | 'unsupported'
        blocked: permission === 'denied',
        enabled,
        setEnabled,
        notify,
        markSeen,
    };
}
