import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { SocketProvider } from './context/SocketContext';
import Layout from './components/layout/Layout';
import Dashboard from './pages/Dashboard';
import Chats from './pages/Chats';
import Sales from './pages/Sales';
import Script from './pages/Script';

function App() {
    return (
        <SocketProvider>
            <BrowserRouter>
                <Routes>
                    <Route path="/" element={<Layout />}>
                        <Route index element={<Dashboard />} />
                        <Route path="chats" element={<Chats />} />
                        <Route path="ventas" element={<Sales />} />
                        <Route path="script" element={<Script />} />
                        <Route path="settings" element={<div className="p-8">Configuración (En construcción)</div>} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Route>
                </Routes>
            </BrowserRouter>
        </SocketProvider>
    );
}

export default App;
