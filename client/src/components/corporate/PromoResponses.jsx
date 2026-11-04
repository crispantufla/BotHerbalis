import React, { useState, useEffect, useCallback } from 'react';
import { Users, RefreshCw, MessageCircle, Download } from 'lucide-react';
import api from '../../config/axios';
import { Card, Button, Badge, useToast } from '../ui';

// Tabla de quiénes respondieron a la promo y en qué quedó cada uno
// (GET /api/promo/responses). Por defecto, solo los interesados: los que
// aceptaron o pidieron una asesora / hicieron una consulta.

const TONE = { accepted: 'success', handed_off: 'accent', declined: 'neutral', opted_out: 'danger', talking: 'info' };
const fmt = (iso) => iso ? new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtPhone = (p) => {
    const m = String(p || '').match(/^549(\d{3})(\d{3})(\d{4})$/);
    return m ? `+54 9 ${m[1]} ${m[2]}-${m[3]}` : `+${p}`;
};

function toCsv(rows) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Nombre', 'Teléfono', 'Estado', 'Campaña', 'Respondió', 'Último mensaje'];
    const lines = rows.map((r) => [r.name || '', fmtPhone(r.phone), r.statusLabel, r.campaign, fmt(r.repliedAt), r.lastMessage || ''].map(esc).join(','));
    return '﻿' + [head.map(esc).join(','), ...lines].join('\n');
}

export default function PromoResponses({ onGoToChat }) {
    const toast = useToast();
    const [rows, setRows] = useState([]);
    const [all, setAll] = useState(false);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const r = await api.get('/api/promo/responses', { params: all ? { all: 1 } : {} });
            setRows(r.data.responses || []);
        } catch (e) {
            toast.error('No pude cargar las respuestas: ' + (e.response?.data?.error || e.message));
        } finally {
            setLoading(false);
        }
    }, [all, toast]);

    useEffect(() => { load(); }, [load]);

    const download = () => {
        const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `interesados-promo-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const nInterested = rows.filter((r) => r.interested).length;

    return (
        <Card padding="md">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <Users className="w-5 h-5 text-accent-600 dark:text-accent-400" />
                    <div>
                        <h3 className="font-bold text-slate-900 dark:text-slate-100">{all ? 'Todos los que respondieron' : 'Interesados en la promo'}</h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                            {all ? `${rows.length} respondieron · ${nInterested} interesados` : `${rows.length} aceptaron o pidieron hablar con una asesora`}
                        </p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
                        Ver todos los que respondieron
                    </label>
                    <Button size="sm" variant="secondary" leftIcon={Download} onClick={download} disabled={!rows.length}>Excel (CSV)</Button>
                    <Button size="sm" variant="secondary" leftIcon={RefreshCw} onClick={load} loading={loading}>Actualizar</Button>
                </div>
            </div>

            {rows.length === 0 ? (
                <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">{loading ? 'Cargando…' : 'Todavía no hay respuestas.'}</p>
            ) : (
                <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                                <th className="pb-2 pr-3 font-medium">Persona</th>
                                <th className="pb-2 pr-3 font-medium">Estado</th>
                                <th className="pb-2 pr-3 font-medium">Respondió</th>
                                <th className="pb-2 pr-3 font-medium">Último mensaje</th>
                                <th className="pb-2 font-medium" />
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r) => (
                                <tr key={r.phone + r.campaign} className="border-t border-slate-100 dark:border-slate-800 align-top">
                                    <td className="py-2 pr-3">
                                        <div className="font-medium text-slate-800 dark:text-slate-200">{r.name || 'Sin nombre'}</div>
                                        <a href={`https://wa.me/${r.phone}`} target="_blank" rel="noreferrer" className="text-xs font-mono text-accent-600 dark:text-accent-400 hover:underline">{fmtPhone(r.phone)}</a>
                                        {r.campaign && <div className="text-[11px] text-slate-400">{r.campaign}</div>}
                                    </td>
                                    <td className="py-2 pr-3"><Badge tone={TONE[r.status] || 'neutral'} size="sm">{r.statusLabel}</Badge></td>
                                    <td className="py-2 pr-3 text-xs text-slate-500 whitespace-nowrap">{fmt(r.repliedAt)}</td>
                                    <td className="py-2 pr-3 text-xs text-slate-600 dark:text-slate-300 max-w-xs">
                                        {r.lastMessage ? <>«{r.lastMessage}»<div className="text-[11px] text-slate-400">{fmt(r.lastMessageAt)}</div></> : '—'}
                                    </td>
                                    <td className="py-2 text-right">
                                        {onGoToChat && <Button size="sm" variant="ghost" leftIcon={MessageCircle} onClick={() => onGoToChat(`${r.phone}@c.us`)}>Chat</Button>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </Card>
    );
}
