import React, { useState } from 'react';
import { Phone, Trash2 as Trash, Plus, QrCode } from 'lucide-react';
import { Card, Button, Input, IconButton, Badge, EmptyState } from '../../ui';

const STATUS_TONE = {
    ready:        { tone: 'success', label: 'Conectado' },
    scan_qr:      { tone: 'warning', label: 'Esperando QR' },
    qr_timeout:   { tone: 'warning', label: 'QR expirado' },
    initializing: { tone: 'neutral', label: 'Iniciando' },
};

const SystemStatusPanel = ({ status, adminNumbers = [], onAddPhone, onRemovePhone, onRegenerateQR }) => {
    const [newPhone, setNewPhone] = useState('');
    const [addingPhone, setAddingPhone] = useState(false);
    const [regenerating, setRegenerating] = useState(false);

    const handleRegenerateQR = async () => {
        setRegenerating(true);
        try {
            await onRegenerateQR();
        } finally {
            setTimeout(() => setRegenerating(false), 5000);
        }
    };

    const handleAdd = async () => {
        if (!newPhone.trim()) return;
        setAddingPhone(true);
        await onAddPhone(newPhone);
        setAddingPhone(false);
        setNewPhone('');
    };

    const tone = STATUS_TONE[status] || { tone: 'danger', label: 'Desconectado' };

    return (
        <Card padding="none" className="flex flex-col">
            <Card.Header
                title="Sistema"
                action={<Badge tone={tone.tone} dot size="sm">{tone.label}</Badge>}
            />

            <div className="p-4 sm:p-5 flex flex-col gap-5">
                {/* Regenerar QR */}
                <Button
                    variant="subtle"
                    fullWidth
                    leftIcon={QrCode}
                    loading={regenerating}
                    disabled={regenerating || status === 'scan_qr' || status === 'initializing'}
                    onClick={handleRegenerateQR}
                >
                    {regenerating ? 'Desconectando…' : status === 'scan_qr' ? 'Esperando escaneo…' : 'Regenerar QR'}
                </Button>

                {/* Admin Phone Numbers */}
                <div className="flex flex-col">
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                            <Phone className="w-4 h-4 text-slate-500 dark:text-slate-400" aria-hidden="true" />
                            <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Administradores</h4>
                        </div>
                        <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                            {adminNumbers.length} configurado{adminNumbers.length === 1 ? '' : 's'}
                        </span>
                    </div>

                    {adminNumbers.length === 0 ? (
                        <div className="border border-dashed border-slate-200 dark:border-slate-700 rounded-card">
                            <EmptyState
                                icon={Phone}
                                description="No hay números configurados para recibir alertas por WhatsApp."
                                className="py-6"
                            />
                        </div>
                    ) : (
                        <ul className="space-y-1.5 max-h-40 overflow-auto custom-scrollbar pr-1">
                            {adminNumbers.map((num, idx) => (
                                <li
                                    key={idx}
                                    className="group flex items-center justify-between bg-slate-50 dark:bg-slate-800/50 border border-slate-200/70 dark:border-slate-700/70 rounded-control px-3 py-2"
                                >
                                    <div className="flex items-center gap-2.5 min-w-0">
                                        <span className="w-1.5 h-1.5 rounded-full bg-success-500 flex-shrink-0" />
                                        <span className="text-sm font-mono text-slate-700 dark:text-slate-200 truncate">+{num}</span>
                                    </div>
                                    <IconButton
                                        label={`Eliminar ${num}`}
                                        icon={Trash}
                                        variant="danger"
                                        size="sm"
                                        onClick={() => onRemovePhone(num)}
                                        className="opacity-0 group-hover:opacity-100 transition-opacity"
                                    />
                                </li>
                            ))}
                        </ul>
                    )}

                    <div className="flex gap-2 mt-3">
                        <Input
                            value={newPhone}
                            onChange={(e) => setNewPhone(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                            placeholder="Ej: 5493411234567"
                            aria-label="Número administrador"
                        />
                        <Button
                            variant="primary"
                            onClick={handleAdd}
                            loading={addingPhone}
                            disabled={!newPhone.trim()}
                            leftIcon={Plus}
                            className="flex-shrink-0"
                        >
                            <span className="sr-only sm:not-sr-only">Agregar</span>
                        </Button>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5">
                        Formato internacional sin + ni espacios
                    </p>
                </div>
            </div>
        </Card>
    );
};

export default SystemStatusPanel;
