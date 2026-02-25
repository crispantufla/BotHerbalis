const { z } = require('zod');

// Validador para POST /config
const configSchema = z.object({
    action: z.enum(['add', 'remove']).optional(),
    number: z.string().optional(),
    alertNumber: z.string().optional()
}).refine(data => {
    // Debe tener (action y number) o (alertNumber)
    return (data.action !== undefined && data.number !== undefined) || data.alertNumber !== undefined;
}, {
    message: "Faltan parámetros requeridos: 'action' + 'number' o 'alertNumber'"
});

// Validador para POST /script
const scriptSchema = z.object({
    version: z.string().optional(),
    // Un poco permisivos con flow y faq porque son dinámicos, pero requerimos que sean objetos/arrays
    flow: z.record(z.string(), z.any()).optional(),
    faq: z.array(z.any()).optional()
}).passthrough(); // Permitir cualquier otro campo por si acaso para no romper compatibilidad

module.exports = {
    configSchema,
    scriptSchema
};
