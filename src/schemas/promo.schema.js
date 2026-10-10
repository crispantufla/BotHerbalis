const { z } = require('zod');

// Textos de la promo: por bloque, una lista de variantes (strings).
const templatesSchema = z.object({
    greeting: z.array(z.string()).optional(),
    reason: z.array(z.string()).optional(),
    empathy: z.array(z.string()).optional(),
    offer: z.array(z.string()).optional(),
    reassure: z.array(z.string()).optional(),
    cta: z.array(z.string()).optional(),
    signoff: z.array(z.string()).optional(),
}).partial();

const audienceSchema = z.object({
    minDaysSinceLastSeen: z.number().min(0).max(365).optional(),
    maxDaysSinceLastSeen: z.number().min(1).max(3650).optional(),
    limit: z.number().min(1).max(20000).optional(),
    cooldownDays: z.number().min(0).max(3650).optional(),
}).partial();

// Configuración de una campaña (los faltantes toman el default en normalizePromoConfig).
const promoConfigSchema = z.object({
    windowStartHour: z.number().min(0).max(23).optional(),
    windowEndHour: z.number().min(1).max(24).optional(),
    dailyCap: z.number().min(1).max(500).optional(),
    minGapMinutes: z.number().min(1).max(1440).optional(),
    maxGapMinutes: z.number().min(1).max(1440).optional(),
    longBreakEvery: z.number().min(0).max(1000).optional(),
    longBreakMinMinutes: z.number().min(1).max(1440).optional(),
    longBreakMaxMinutes: z.number().min(1).max(1440).optional(),
    skipWeekends: z.boolean().optional(),
    skipIfInboundHours: z.number().min(0).max(720).optional(),
    maxFailStreak: z.number().min(1).max(50).optional(),
    variationMode: z.enum(['ai', 'templates']).optional(),
    baseMessage: z.string().min(40, 'El mensaje base es muy corto').max(2000).optional(),
    templates: templatesSchema.nullable().optional(),
    imageEnabled: z.boolean().optional(),
    audience: audienceSchema.optional(),
}).partial();

const createCampaignSchema = z.object({
    name: z.string().min(2, 'La campaña necesita un nombre').max(80),
    config: promoConfigSchema.optional(),
});

const previewSchema = z.object({
    variationMode: z.enum(['ai', 'templates']).optional(),
    baseMessage: z.string().min(40, 'El mensaje base es muy corto').max(2000).optional(),
    templates: templatesSchema.nullable().optional(),
    count: z.number().min(1).max(6).optional(),
});

// Edición de una campaña existente: nombre y configuración de envío/textos. La
// audiencia no se toca (la lista quedó congelada al crearla).
const updateCampaignSchema = z.object({
    name: z.string().min(2).max(80).optional(),
    config: promoConfigSchema.omit({ audience: true }).optional(),
});

module.exports = { createCampaignSchema, updateCampaignSchema, promoConfigSchema, previewSchema, audienceSchema };
