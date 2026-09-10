const { cleanEnv, str, num, url } = require('envalid');
const dotenv = require('dotenv');
dotenv.config();

const env = cleanEnv(process.env, {
    // Servidor / Instancia
    PORT: num({ default: 3000 }),
    INSTANCE_ID: str({ default: 'default' }),
    PORT_INTERNAL: num({ default: 3001 }),
    DASHBOARD_URL: url({ default: 'http://localhost:3000' }),

    // Base de Datos y Redis
    DATABASE_URL: url(),
    REDIS_URL: url({ default: 'redis://127.0.0.1:6379' }),

    // APIs Externas
    OPENAI_API_KEY: str({ desc: 'API Key de OpenAI' }),
    ELEVENLABS_API_KEY: str({ default: '', desc: 'API Key de ElevenLabs (opcional)' }),
    ELEVENLABS_VOICE_ID: str({ default: '', desc: 'ID de voz para ElevenLabs (opcional)' }),

    // JWT Auth (reemplaza ADMIN_USER/ADMIN_PASSWORD)
    JWT_SECRET: str({ default: 'dev-jwt-secret-change-in-production', desc: 'Secreto JWT para tokens de sesión' }),

    // API Key legacy (backward compat con dashboard antiguo)
    API_KEY: str({ default: '', desc: 'Clave interna legacy para autenticación del dashboard' }),

    // Panel de ventas (ventas-app) — botón "Enviar a sistema".
    // Con cualquiera de las dos vacía el botón queda deshabilitado.
    SISTEMA_URL: str({ default: '', desc: 'URL base del panel de ventas, ej https://herbalis-app-production.up.railway.app' }),
    SISTEMA_TOKEN: str({ default: '', desc: 'Bearer token del panel de ventas (su INTEGRATION_TOKEN)' }),

    // Tienda web (web-v5) → confirmación por WhatsApp de pedidos pagos.
    // La web llama POST /api/web-orders/:id/notify con este token en el header
    // x-web-notify-token. Vacío = endpoint deshabilitado (503).
    WEB_NOTIFY_TOKEN: str({ default: '', desc: 'Secreto compartido con la tienda web para /web-orders/:id/notify' }),
    // Seller cuyo WhatsApp manda las confirmaciones web (ej. "horacio").
    // Vacío = el primer seller conectado del pool.
    WEB_ORDERS_SELLER: str({ default: '', desc: 'sellerId que envía las confirmaciones de pedidos web' }),

    // Legacy fallback — mantenidos para no romper instancias viejas
    ADMIN_USER: str({ default: '' }),
    ADMIN_PASSWORD: str({ default: '' }),
});

module.exports = { env };
export {};
