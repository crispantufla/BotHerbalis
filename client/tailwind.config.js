/** @type {import('tailwindcss').Config} */
export default {
    darkMode: 'class',
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            // Tokens semánticos: en vez de inventar gradientes y rgba arbitrarios
            // en cada vista, las primitives `ui/*` consumen estos tokens.
            colors: {
                // Acento primario — sigue siendo indigo para no romper marca,
                // pero ahora hay UNA escala canónica en lugar de "indigo a veces
                // / blue a veces / purple a veces".
                accent: {
                    50:  '#eef2ff',
                    100: '#e0e7ff',
                    200: '#c7d2fe',
                    300: '#a5b4fc',
                    400: '#818cf8',
                    500: '#6366f1',
                    600: '#4f46e5',
                    700: '#4338ca',
                    800: '#3730a3',
                    900: '#312e81',
                },
                // Semánticos — mismas escalas Tailwind, renombrados por intención.
                // Resultado: las vistas dicen `text-success-600` en lugar de
                // adivinar "¿emerald o teal o green?".
                success: {
                    50:  '#ecfdf5', 100: '#d1fae5', 500: '#10b981',
                    600: '#059669', 700: '#047857', 900: '#064e3b',
                },
                warning: {
                    50:  '#fffbeb', 100: '#fef3c7', 500: '#f59e0b',
                    600: '#d97706', 700: '#b45309', 900: '#78350f',
                },
                danger: {
                    50:  '#fff1f2', 100: '#ffe4e6', 500: '#f43f5e',
                    600: '#e11d48', 700: '#be123c', 900: '#881337',
                },
                info: {
                    50:  '#f0f9ff', 100: '#e0f2fe', 500: '#0ea5e9',
                    600: '#0284c7', 700: '#0369a1', 900: '#0c4a6e',
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
                'focus':        '0 0 0 3px rgb(99 102 241 / 0.25)',
                'focus-danger': '0 0 0 3px rgb(244 63 94 / 0.25)',
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
