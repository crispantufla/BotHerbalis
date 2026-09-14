import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const queryClient = new QueryClient();

// Tras un deploy, una pestaña abierta puede pedir un pedazo del panel que ya no
// existe (cambió su hash). Recargar trae el index nuevo. Como mucho una vez por
// minuto: si el archivo falta de verdad, LazyBoundary muestra el aviso.
window.addEventListener('vite:preloadError', (event) => {
    const last = Number(sessionStorage.getItem('chunk-reload-at') || 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem('chunk-reload-at', String(Date.now()));
    event.preventDefault();
    window.location.reload();
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
