import { useState } from 'react';

// Borrador de un comentario nuevo, en una sección o entre dos pasos: abrir y
// cerrar el formulario, los campos y el envío. `suggestionAllowed(tipo)` decide si
// el texto sugerido se muestra y se manda para ese tipo de comentario.
export function useCommentDraft({ sectionPath, defaultType, onAddComment, suggestionAllowed }) {
    const [showForm, setShowForm] = useState(false);
    const [draft, setDraft] = useState('');
    const [draftSuggested, setDraftSuggested] = useState('');
    const [draftType, setDraftType] = useState(defaultType);
    const [submitting, setSubmitting] = useState(false);
    const withSuggestion = suggestionAllowed(draftType);

    const submit = async () => {
        if (!draft.trim()) return;
        setSubmitting(true);
        try {
            await onAddComment({
                sectionPath, type: draftType, content: draft,
                suggestedText: withSuggestion && draftSuggested.trim() ? draftSuggested : null,
            });
            setDraft(''); setDraftSuggested(''); setDraftType(defaultType);
            setShowForm(false);
        } finally {
            setSubmitting(false);
        }
    };

    const cancel = () => { setShowForm(false); setDraft(''); setDraftSuggested(''); };

    return {
        showForm,
        open: () => setShowForm(true),
        formProps: {
            draft, setDraft, draftSuggested, setDraftSuggested, draftType, setDraftType,
            onSubmit: submit, onCancel: cancel, submitting, showSuggested: withSuggestion,
        },
    };
}
