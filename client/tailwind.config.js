/** @type {import('tailwindcss').Config} */
export default {
    darkMode: 'class',
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            // ── Paleta España (azulejo + albero) ───────────────────────────
            // El bot argentino usa índigo; este usa el azul de la cerámica
            // española como acento y el ocre albero como color secundario.
            //
            // Las escalas van COMPLETAS (50-900) a propósito: las vistas usan
            // tonos intermedios (-300, -400, -800) y, con escalas parciales,
            // esas clases se compilaban a nada y el elemento quedaba sin color.
            //
            // Regla de uso: el rojo es SOLO para error/peligro. Por eso el
            // acento es azul y no el rojo de la bandera — en un panel lleno de
            // alertas, un botón primario rojo se lee como "algo va mal".
            colors: {
                // Azulejo — acento primario (botones, enlaces, barra lateral).
                accent: {
                    50:  '#f0f6fc',
                    100: '#dbeafa',
                    200: '#b9d5f3',
                    300: '#8bb9e8',
                    400: '#5695d8',
                    500: '#3176bd',
                    600: '#1e5ea8',
                    700: '#1a4d89',
                    800: '#1a4171',
                    900: '#17375e',
                },
                // Albero — ocre del ruedo. Secundario: KPIs, gráficos y realces
                // decorativos. NO usar para avisos (eso es `warning`).
                albero: {
                    50:  '#fdf8ec',
                    100: '#faeecd',
                    200: '#f4dc9c',
                    300: '#ecc463',
                    400: '#e5b03a',
                    500: '#e0a526',
                    600: '#c1851a',
                    700: '#9a6417',
                    800: '#7d521a',
                    900: '#684318',
                },
                // Semánticos — renombrados por intención. Las vistas dicen
                // `text-success-600` en lugar de adivinar "¿emerald o green?".
                success: {
                    50:  '#f3f9ee', 100: '#e1f0d4', 200: '#c6e2ae',
                    300: '#a3ce82', 400: '#7fb457', 500: '#4d8b31',
                    600: '#3f7328', 700: '#335c21', 800: '#2a4a1d',
                    900: '#1f3a14',
                },
                warning: {
                    50:  '#fffbeb', 100: '#fef3c7', 200: '#fde68a',
                    300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b',
                    600: '#d97706', 700: '#b45309', 800: '#92400e',
                    900: '#78350f',
                },
                // Carmesí — reservado a errores, cancelaciones y destructivo.
                danger: {
                    50:  '#fdf2f4', 100: '#fbe0e5', 200: '#f6bfc9',
                    300: '#ee92a4', 400: '#e05f78', 500: '#c8102e',
                    600: '#a80c26', 700: '#8a0b20', 800: '#6d0919',
                    900: '#55060f',
                },
                info: {
                    50:  '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd',
                    300: '#7dd3fc', 400: '#38bdf8', 500: '#0ea5e9',
                    600: '#0284c7', 700: '#0369a1', 800: '#075985',
                    900: '#0c4a6e',
                },
            },
            // Radii consistentes. Quitamos `rounded-3xl` (24px) y
            // `rounded-[2rem]` (32px) del léxico común — quedaban exagerados
            // en cards densas.
            borderRadius: {
                card: '1rem',         // 16px — para cards y modales
                control: '0.625rem',  // 10px — inputs, selects, buttons
            },
            boxShadow: {
                // 3 niveles de elevación + 2 focus rings, vs los ~12 que había
                // diseminados por el código con rgba hardcodeados.
                'card':         '0 1px 3px 0 rgb(15 23 42 / 0.04), 0 1px 2px -1px rgb(15 23 42 / 0.04)',
                'card-hover':   '0 4px 12px -2px rgb(15 23 42 / 0.08), 0 2px 6px -1px rgb(15 23 42 / 0.04)',
                'elevated':     '0 12px 32px -8px rgb(15 23 42 / 0.12), 0 4px 8px -2px rgb(15 23 42 / 0.06)',
                'focus':        '0 0 0 3px rgb(30 94 168 / 0.25)',
                'focus-danger': '0 0 0 3px rgb(200 16 46 / 0.25)',
            },
            fontFamily: {
                sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
            },
            fontSize: {
                // Tipos fluid con `clamp()` para no escribir
                // `text-lg sm:text-xl 2xl:text-3xl` en cada vista.
                'display': ['clamp(1.5rem, 2vw + 1rem, 2rem)', { lineHeight: '1.15', letterSpacing: '-0.02em', fontWeight: '700' }],
                'h2':      ['clamp(1.125rem, 1vw + 0.875rem, 1.375rem)', { lineHeight: '1.25', letterSpacing: '-0.01em', fontWeight: '600' }],
            },
            animation: {
                'fade-in': 'fadeIn 0.3s ease-out',
            },
            keyframes: {
                fadeIn: {
                    '0%': { opacity: '0', transform: 'translateY(4px)' },
                    '100%': { opacity: '1', transform: 'translateY(0)' },
                },
            },
        },
    },
    plugins: [
        require('tailwind-scrollbar'),
    ],
}
