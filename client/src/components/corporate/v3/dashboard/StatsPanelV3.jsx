import React from 'react';

const StatsPanelV3 = ({ stats, loadingStats, alertsCount }) => {
    if (loadingStats) {
        return (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 animate-pulse">
                {[1, 2, 3, 4].map(i => (
                    <div key={i} className="bg-white/50 h-32 rounded-3xl border border-slate-100"></div>
                ))}
            </div>
        );
    }

    const cards = [
        {
            title: "Total Chats",
            value: stats?.totalConversations || 0,
            icon: (
                <svg className="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>
            ),
            bgColor: "bg-blue-50/50",
            textColor: "text-blue-600"
        },
        {
            title: "Pedidos Aprobados",
            value: stats?.totalOrders || 0,
            icon: (
                <svg className="w-6 h-6 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            ),
            bgColor: "bg-emerald-50/50",
            textColor: "text-emerald-600"
        },
        {
            title: "Conversión",
            value: `${stats?.conversionRate || 0}%`,
            icon: (
                <svg className="w-6 h-6 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
            ),
            bgColor: "bg-purple-50/50",
            textColor: "text-purple-600"
        },
        {
            title: "Alertas Activas",
            value: alertsCount || 0,
            icon: (
                <svg className="w-6 h-6 text-rose-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
            ),
            bgColor: "bg-rose-50/50",
            textColor: "text-rose-600",
            alert: alertsCount > 0
        }
    ];

    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 xl:gap-6 w-full relative z-10">
            {cards.map((card, idx) => (
                <div key={idx} className="group bg-white/70 backdrop-blur-xl border border-slate-200/60 p-6 rounded-3xl shadow-sm hover:shadow-md transition-all duration-300 relative overflow-hidden">
                    {/* Decorative Background Blob */}
                    <div className={`absolute -right-4 -top-4 w-24 h-24 ${card.bgColor} rounded-full blur-2xl opacity-50 group-hover:opacity-100 transition-opacity duration-300`}></div>

                    <div className="flex justify-between items-start relative z-10">
                        <div>
                            <p className="text-[12px] font-bold text-slate-400 uppercase tracking-widest mb-1">{card.title}</p>
                            <h3 className={`text-4xl font-extrabold tracking-tight ${card.alert ? 'text-rose-600' : 'text-slate-800'}`}>
                                {card.value}
                            </h3>
                        </div>
                        <div className={`w-12 h-12 flex items-center justify-center rounded-2xl ${card.bgColor} shadow-inner`}>
                            {card.icon}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
};

export default StatsPanelV3;
