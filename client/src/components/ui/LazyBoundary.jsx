import React from 'react';

// Envuelve una parte del panel que se descarga aparte (React.lazy). Si no carga
// —red caída, o un deploy que dejó la pestaña pidiendo un archivo viejo— muestra
// `fallback` en ese lugar en vez de tirar abajo todo el dashboard. React.lazy
// recuerda el fallo, así que para reintentar hay que recargar la página.
export default class LazyBoundary extends React.Component {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    render() {
        if (this.state.failed) return this.props.fallback ?? null;
        return this.props.children;
    }
}
