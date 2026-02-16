import React, { useState, useEffect } from 'react';
import { useSocket } from '../context/SocketContext';
import ZenSidebar from '../components/zen/ZenSidebar';
import ZenHeader from '../components/zen/ZenHeader';

// View Imports (Placeholders for now)
import DashboardView from '../components/zen/views/DashboardView';
import CommsView from '../components/zen/views/CommsView';
import SalesView from '../components/zen/views/SalesView';

const ZenRoot = () => {
    const { socket } = useSocket();
    const [status, setStatus] = useState('initializing');
    const [activeView, setActiveView] = useState('dashboard');
    const [userData, setUserData] = useState({ name: 'Crispantufla' });

    // Global Socket Listeners
    useEffect(() => {
        if (socket) {
            socket.on('qr', () => setStatus('scan_qr'));
            socket.on('ready', () => setStatus('ready'));
            socket.on('status_change', ({ status }) => setStatus(status));
            // We can add globalToast listeners here if needed
        }
    }, [socket]);

    // View Routing Logic
    const renderView = () => {
        switch (activeView) {
            case 'dashboard': return <DashboardView />;
            case 'comms': return <CommsView />;
            case 'sales': return <SalesView />;
            default: return <DashboardView />;
        }
    };

    return (
        <div className="min-h-screen bg-[#F5F5F7] text-[#1D1D1F] font-sans selection:bg-purple-100 selection:text-purple-900 relative overflow-hidden transition-colors duration-500">
            {/* 1. Ambient Background (The "Glass" Feel) */}
            <div className="fixed top-0 left-0 w-full h-full pointer-events-none z-0">
                <div className="absolute top-[-20%] left-[-10%] w-[900px] h-[900px] bg-blue-100/40 rounded-full blur-[120px] opacity-50 animate-pulse transition-all duration-[3000ms]"></div>
                <div className="absolute bottom-[-20%] right-[-10%] w-[700px] h-[700px] bg-purple-100/40 rounded-full blur-[100px] opacity-50 animate-pulse transition-all duration-[4000ms]"></div>
            </div>

            {/* 2. Navigation Shell */}
            <ZenSidebar activeView={activeView} setActiveView={setActiveView} />

            {/* 3. Main Content Area */}
            <main className="ml-24 p-6 lg:p-8 max-w-[1600px] mx-auto relative z-10 min-h-screen flex flex-col">
                <ZenHeader status={status} user={userData.name} />

                {/* Dynamic View Container */}
                <div className="flex-1 bg-white/40 backdrop-blur-lg rounded-3xl border border-white/50 shadow-sm overflow-hidden relative transition-all duration-300">
                    {renderView()}
                </div>
            </main>
        </div>
    );
};

export default ZenRoot;
