import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';

const ThemeContext = createContext();

export const useTheme = () => useContext(ThemeContext);

const STORAGE_KEY = 'herbalis-theme';

// Sin preferencia guardada, arranca con el tema del sistema.
const getInitialTheme = () => {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) return saved === 'dark';
    } catch { /* sin localStorage: se usa el tema del sistema */ }
    return typeof window !== 'undefined'
        && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
};

export const ThemeProvider = ({ children }) => {
    const [isDark, setIsDark] = useState(getInitialTheme);

    // La preferencia se guarda recién cuando la persona elige: mientras no toque
    // el interruptor, cada carga sigue al sistema.
    const userChose = useRef(false);

    useEffect(() => {
        document.documentElement.classList.toggle('dark', isDark);
        if (!userChose.current) return;
        try { localStorage.setItem(STORAGE_KEY, isDark ? 'dark' : 'light'); } catch { /* no se pudo guardar */ }
    }, [isDark]);

    const toggleTheme = useCallback(() => {
        userChose.current = true;
        setIsDark(prev => !prev);
    }, []);

    const value = useMemo(() => ({ isDark, toggleTheme }), [isDark, toggleTheme]);

    return (
        <ThemeContext.Provider value={value}>
            {children}
        </ThemeContext.Provider>
    );
};
