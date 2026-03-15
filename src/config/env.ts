const { cleanEnv, str, num, url } = require('envalid');
const dotenv = require('dotenv');
dotenv.config();

const env = cleanEnv(process.env, {
    // Servidor / Instancia
    PORT: num({ default: 3000 }),
    INSTANCE_ID: str({ default: 'default' }),
    PORT_INTERNAL: num({ default: 3001 }),
    DASHBOARD_URL: url(),

    // Base de Datos y Redis
    DATABASE_URL: url(),
    REDIS_URL: url({ default: 'redis://127.0.0.1:6379' }),

    // APIs Externas
    OPENAI_API_KEY: str({ desc: 'API Key de OpenAI' }),
    ELEVENLABS_API_KEY: str({ desc: 'API Key de ElevenLabs' }),
    ELEVENLABS_VOICE_ID: str({ desc: 'ID de voz para audios en ElevenLabs' }),

    // Configuración Admin / Panel
    API_KEY: str({ desc: 'Clave interna para autenticación del dashboard' }),
    ADMIN_NUMBER: str({ default: '5491100000000@c.us' }),
    ADMIN_USER: str(),
    ADMIN_PASSWORD: str()
});

module.exports = { env };
