// Descarga la conversación como .txt (lo que hace "/descargar" en el input): con
// fecha y hora de cada mensaje y los audios transcriptos, para analizarla afuera.
export function downloadChatHistory(messages, chat) {
    let txtContent = `Analiza esta conversacion:\n\n`;
    messages.forEach(msg => {
        let dateStr = '';
        try {
            const d = new Date(msg.timestamp);
            if (!isNaN(d.getTime())) {
                dateStr = `[${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' })}, ${d.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}] `;
            }
        } catch { /* */ }
        const sender = msg.fromMe ? 'Herbalis' : (chat.name || chat.id).split('@')[0];
        let body = msg.body || '';
        if (body.startsWith('MEDIA_IMAGE:')) body = '[Imagen adjunta]';
        if (body.startsWith('MEDIA_AUDIO:')) {
            const parts = body.split('|');
            const trans = parts[1] ? parts[1].replace('TRANSCRIPTION:', '').trim() : '';
            body = trans ? `[Audio transcrito]: ${trans}` : `[Audio adjunto]`;
        }
        if (body.startsWith('🎤 Audio:')) body = `[Audio transcrito]: ${body.replace(/^🎤\s*Audio:\s*/, '').replace(/^"|"$/g, '').trim()}`;
        txtContent += `${dateStr}${sender}: ${body}\n`;
    });
    const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safePhone = chat.id.split('@')[0].replace(/\D/g, '');
    a.download = `chat_${safePhone}_${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
