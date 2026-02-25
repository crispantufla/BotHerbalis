const { z } = require('zod');

// Validador para POST /prices
// Requiere un record de strings para los productos, donde cada uno o es un objeto o tiene valores de precio
const pricesSchema = z.record(z.string(), z.record(z.string(), z.string()));

// Validador para POST /script/switch
const scriptSwitchSchema = z.object({
    script: z.string().min(2, "El nombre del script es requerido")
});

const pairingCodeSchema = z.object({
    phoneNumber: z.string().min(8, "Se requiere un número de teléfono válido")
});

const toggleBotSchema = z.object({
    chatId: z.string().min(5, "Se requiere el ID del chat"),
    paused: z.boolean()
});

const adminCommandSchema = z.object({
    chatId: z.string().min(5, "Se requiere el ID del chat"),
    command: z.string().min(1, "El comando no puede estar vacío")
});

module.exports = {
    pricesSchema,
    scriptSwitchSchema,
    pairingCodeSchema,
    toggleBotSchema,
    adminCommandSchema
};
