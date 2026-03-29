import { useEffect } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { useTheme } from '../context/ThemeContext';
import { useLocation, useNavigate } from 'react-router-dom';

const CapacitorInit = () => {
    const { isDark } = useTheme();
    const location = useLocation();
    const navigate = useNavigate();

    // Configure Status Bar based on Theme
    useEffect(() => {
        const initStatusBar = async () => {
            try {
                // Determine if it's running natively
                if (!window.Capacitor || !window.Capacitor.isNative) return;

                // Adjust style to background
                await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
                
                // Allow the view to draw underneath the status bar (to use safe-area padding)
                await StatusBar.setOverlaysWebView({ overlay: true });
            } catch (e) {
                console.warn('StatusBar configuration not available', e);
            }
        };

        initStatusBar();
    }, [isDark]);

    // Configure Hardware Back Button
    useEffect(() => {
        if (!window.Capacitor || !window.Capacitor.isNative) return;

        const handleBackButton = async ({ canGoBack }) => {
            // If we are not at the root (dashboard), go back via React Router instead of closing app
            if (location.pathname !== '/' && location.pathname !== '/login') {
                navigate(-1);
            } else {
                // If we are at the root dashboard, maybe ask for confirmation or Exit
                // We'll just minimize the app instead of force killing it (standard Android behavior)
                CapacitorApp.minimizeApp();
            }
        };

        const backListener = CapacitorApp.addListener('backButton', handleBackButton);

        return () => {
            // Clean up listener
            if (backListener.remove) {
                backListener.remove();
            }
        };
    }, [location.pathname, navigate]);

    // This component renders nothing
    return null;
};

export default CapacitorInit;
