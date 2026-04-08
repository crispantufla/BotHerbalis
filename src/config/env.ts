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

    // Legacy fallback — mantenidos para no romper instancias viejas
    ADMIN_USER: str({ default: '' }),
    ADMIN_PASSWORD: str({ default: '' }),
});

module.exports = { env };
export {};
