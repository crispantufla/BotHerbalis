import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SocketProvider } from './context/SocketContext';
import CorporateDashboard from './pages/designs/CorporateDashboard';

function App() {
    return (
        <SocketProvider>
            <Router>
                <div className="h-screen w-screen bg-slate-50 text-slate-900">
                    <Routes>
                        {/* Main Route - Corporate Enterprise */}
                        <Route path="/" element={<CorporateDashboard />} />

                        {/* Catch all - Redirect to Home */}
                        <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                </div>
            </Router>
        </SocketProvider>
    );
}

export default App;
