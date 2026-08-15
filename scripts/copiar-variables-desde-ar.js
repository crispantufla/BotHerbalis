/**
 * Copia a "Herbalis Bot Esp" las variables de entorno que SÍ se comparten con
 * el bot argentino, y solo esas.
 *
 *   node scripts/copiar-variables-desde-ar.js            (simulación, no escribe)
 *   node scripts/copiar-variables-desde-ar.js --aplicar  (escribe en Railway)
 *
 * Los valores NUNCA se imprimen ni se guardan en disco: van del CLI de Railway
 * de un proyecto al del otro, en memoria.
 *
 * POR QUÉ NO SE COPIA TODO: hay variables del proyecto argentino que aquí
 * romperían cosas o mezclarían los dos negocios. Ver EXCLUIDAS abajo.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DIR_AR = 'D:\\Bot Whatsapp';          // repo argentino (enlazado a "Herbalis Bots")
const DIR_ES = path.join(__dirname, '..');   // este repo (enlazado a "Herbalis Bot Esp")
const SERVICIO_AR = 'MainHerbalisBot';
const SERVICIO_ES = 'bot-es';

// Lo que se copia tal cual: credenciales de servicios externos que los dos
// negocios comparten de verdad (misma cuenta de OpenAI, misma de Google…).
const COPIAR = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'CLAUDE_AB_SELLERS',      // ⚠️ si trae nombres de vendedores argentinos, cámbialo a "*"
    'CLAUDE_AB_PERCENT',
    'GOOGLE_MAPS_KEY',
    'ELEVENLABS_API_KEY',
    'ELEVENLABS_VOICE_ID',
    'SEED_ADMIN_USERNAME',
    'SEED_ADMIN_EMAIL',
    'SEED_ADMIN_PASSWORD',    // misma contraseña de panel en los dos; cámbiala luego si quieres
];

// Documentado para que se vea que la omisión es a propósito, no un olvido:
//   DATABASE_URL, REDIS_URL  → apuntan a la base y al Redis de ESTE proyecto.
//                              Copiarlas mezclaría los pedidos de los dos países.
//   MP_ACCESS_TOKEN, MP_PUBLIC_KEY, MP_WEBHOOK_URL
//                            → Mercado Pago no existe en el bot español.
//   WA_*_HORACIO             → configuración del vendedor argentino.
//   DASHBOARD_URL            → apunta al panel argentino.
//   INSTANCE_ID              → aquí vale "herbalis-es".
//   PORT, NODE_ENV, DATA_DIR, PUPPETEER_EXECUTABLE_PATH
//                            → los pone el Dockerfile o Railway.
//   RAILWAY_*                → los gestiona Railway, son de solo lectura.
//   JWT_SECRET, API_KEY      → NO se copian: ver abajo.

// Localiza el BINARIO real del CLI. Todo se invoca por ruta y con los
// argumentos en un array — nunca por shell — para que un valor con espacios,
// comillas o `&` no se rompa ni se interprete como comando.
//
// Dos trampas de Windows que obligan a buscarlo a mano:
//   1. El `railway.cmd` de npm no sirve: desde Node 18, spawn se niega a
//      ejecutar .cmd/.bat sin `shell: true` (EINVAL), y activar el shell es
//      justo lo que queremos evitar manejando secretos.
//   2. `where railway` solo funciona si la carpeta de npm está en el PATH de
//      la terminal desde la que lo lances. En PowerShell muchas veces no está,
//      así que primero probamos las rutas conocidas.
function resolverRailway() {
    const esWindows = process.platform === 'win32';
    const SUB = ['node_modules', '@railway', 'cli', 'bin', esWindows ? 'railway.exe' : 'railway'];
    const probados = [];

    const mirar = (p) => {
        if (!p) return null;
        probados.push(p);
        return fs.existsSync(p) ? p : null;
    };

    // 1) Ruta indicada a mano (escape hatch definitivo).
    let hit = mirar(process.env.RAILWAY_BIN);
    if (hit) return hit;

    // 2) Sitios donde npm deja los paquetes globales. No damos por hecho que
    //    APPDATA exista: según cómo se lance la terminal puede no estar, y
    //    entonces el candidato salía como ruta relativa y nunca casaba.
    const raices = [];
    if (esWindows) {
        if (process.env.APPDATA) raices.push(path.join(process.env.APPDATA, 'npm'));
        if (process.env.USERPROFILE) raices.push(path.join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm'));
        raices.push(path.join(path.dirname(process.execPath)));                      // C:\Program Files\nodejs
        if (process.env.ProgramFiles) raices.push(path.join(process.env.ProgramFiles, 'nodejs'));
    } else {
        raices.push('/usr/local/lib', '/usr/lib', path.join(process.env.HOME || '', '.npm-global', 'lib'));
    }
    for (const raiz of raices) {
        hit = mirar(path.join(raiz, ...SUB));
        if (hit) return hit;
    }

    // 3) Último recurso: preguntarle al sistema. Depende del PATH de la
    //    terminal, que es justo lo que falla en muchas PowerShell.
    try {
        const salida = execFileSync(esWindows ? 'where' : 'which', ['railway'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const rutas = salida.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
        const exe = rutas.find((r) => r.toLowerCase().endsWith(esWindows ? '.exe' : 'railway'));
        if (exe) return exe;
        if (rutas[0]) {
            hit = mirar(path.join(path.dirname(rutas[0]), ...SUB));
            if (hit) return hit;
        }
    } catch { /* no está en el PATH */ }

    throw new Error(
        'No encontré el binario de Railway. Probé:\n  ' + probados.join('\n  ') +
        '\n\nSi sabes dónde está, lánzalo así (PowerShell, todo en una línea):\n' +
        '  $env:RAILWAY_BIN="C:\\ruta\\a\\railway.exe"; node "D:\\Bot Whatsapp ES\\scripts\\copiar-variables-desde-ar.js" --aplicar\n' +
        '\nPara localizarlo:  Get-ChildItem -Path $env:APPDATA,$env:USERPROFILE -Filter railway.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 3 FullName'
    );
}

const RAILWAY = resolverRailway();

function leerVariables(cwd, servicio) {
    const salida = execFileSync(RAILWAY, ['variables', '--service', servicio, '--kv'], {
        cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    });
    const vars = {};
    for (const linea of salida.split(/\r?\n/)) {
        const i = linea.indexOf('=');
        if (i > 0) vars[linea.slice(0, i).trim()] = linea.slice(i + 1);
    }
    return vars;
}

function main() {
    const aplicar = process.argv.includes('--aplicar');

    console.log(`Leyendo variables de "${SERVICIO_AR}" (proyecto argentino)…`);
    const ar = leerVariables(DIR_AR, SERVICIO_AR);

    const pares = [];
    const faltan = [];
    for (const clave of COPIAR) {
        if (ar[clave] !== undefined && ar[clave] !== '') pares.push([clave, ar[clave]]);
        else faltan.push(clave);
    }

    // JWT_SECRET se GENERA nuevo, no se copia: es la llave con la que se firman
    // las sesiones del panel. Si los dos proyectos comparten la misma, un token
    // emitido por el panel argentino vale también en el español. Son negocios
    // distintos; que cada uno tenga la suya.
    pares.push(['JWT_SECRET', crypto.randomBytes(48).toString('hex')]);

    console.log(`\nSe van a poner ${pares.length} variables en "${SERVICIO_ES}":`);
    for (const [k] of pares) console.log(`  - ${k}${k === 'JWT_SECRET' ? '  (generada nueva, no copiada)' : ''}`);
    if (faltan.length) console.log(`\nNo estaban en el proyecto argentino (se omiten): ${faltan.join(', ')}`);

    if (!aplicar) {
        console.log('\n(SIMULACIÓN — no se ha escrito nada.)');
        console.log('Para aplicarlo:  node scripts/copiar-variables-desde-ar.js --aplicar');
        return;
    }

    const args = ['variables', '--service', SERVICIO_ES];
    for (const [k, v] of pares) args.push('--set', `${k}=${v}`);
    execFileSync(RAILWAY, args, { cwd: DIR_ES, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

    console.log('\n✅ Listo. Railway redespliega solo.');
    console.log('   Comprueba con:  railway logs --service bot-es');
}

main();
