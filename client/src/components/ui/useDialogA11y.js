import { useEffect, useMemo, useRef } from 'react';

// Comportamiento de teclado y foco de un diálogo modal, compartido por `ui/Modal`,
// el `confirm()` de `ui/Toast` y los modales artesanales del panel:
//   - al abrir, el foco entra al diálogo (al elemento con `data-autofocus` o, si no
//     hay, al contenedor); al cerrar vuelve a quien lo tenía;
//   - Tab / Shift+Tab giran adentro;
//   - Escape llama a `onClose`;
//   - bloquea el scroll del body (opcional).
//
// Con varios diálogos abiertos a la vez (un `confirm()` encima de un modal) solo
// responde el último que se abrió: sin esta pila, Escape cerraba los dos.
//
// Capas (z-index), de abajo hacia arriba:
//   z-[100]  ui/Modal
//   z-[200]  modales artesanales (pueden abrirse encima de un ui/Modal)
//   z-[9999] toasts y confirm() — SIEMPRE por encima de cualquier modal
//
// Uso: `const ref = useDialogA11y({ open, onClose })` y poner `ref` + `tabIndex={-1}`
// en el elemento que lleva `role="dialog"`.
const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

const openDialogs = [];

const focusableIn = (node) =>
    Array.from(node.querySelectorAll(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);

export function useDialogA11y({ open, onClose, closeOnEscape = true, lockScroll = true }) {
    const containerRef = useRef(null);
    const onCloseRef = useRef(onClose);
    const escapeRef = useRef(closeOnEscape);

    // `onClose` suele ser una flecha nueva en cada render: va por ref para que el
    // effect de abajo dependa solo de `open` (si no, cada render devolvería el foco).
    useEffect(() => {
        onCloseRef.current = onClose;
        escapeRef.current = closeOnEscape;
    });

    // Se lee en el render y no en el effect: un hijo con `autoFocus` toma el foco
    // durante el commit, antes de cualquier effect, y ahí ya se perdió quién lo tenía.
    const opener = useMemo(
        () => (open && typeof document !== 'undefined' ? document.activeElement : null),
        [open]
    );

    useEffect(() => {
        if (!open) return undefined;

        const token = {};
        openDialogs.push(token);
        const isTop = () => openDialogs[openDialogs.length - 1] === token;

        const node = containerRef.current;
        if (node && !node.contains(document.activeElement)) {
            (node.querySelector('[data-autofocus]') || node).focus({ preventScroll: true });
        }

        const onKey = (e) => {
            if (!isTop()) return;
            const el = containerRef.current;
            if (e.key === 'Escape') {
                if (escapeRef.current) onCloseRef.current?.();
                return;
            }
            if (e.key !== 'Tab' || !el) return;
            const items = focusableIn(el);
            if (items.length === 0) {
                e.preventDefault();
                el.focus({ preventScroll: true });
                return;
            }
            const first = items[0];
            const last = items[items.length - 1];
            const active = document.activeElement;
            const outside = !el.contains(active) || active === el;
            if (e.shiftKey && (outside || active === first)) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && (outside || active === last)) {
                e.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', onKey);

        const prevOverflow = document.body.style.overflow;
        if (lockScroll) document.body.style.overflow = 'hidden';

        return () => {
            document.removeEventListener('keydown', onKey);
            if (lockScroll) document.body.style.overflow = prevOverflow;
            const i = openDialogs.indexOf(token);
            if (i !== -1) openDialogs.splice(i, 1);
            if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === 'function') {
                opener.focus({ preventScroll: true });
            }
        };
    }, [open, lockScroll, opener]);

    return containerRef;
}

export default useDialogA11y;
