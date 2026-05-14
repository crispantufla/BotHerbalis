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

module.exports = {
    configSchema
};
