/**
 * updater.js — Auto-actualización del agente desde Railway (/agent-dist).
 *
 * Sin dependencias (https/crypto/fs nativos): baja el manifest, compara sha256
 * de los archivos locales, descarga los que difieren (verificando el hash de lo
 * descargado) y los sobreescribe. Devuelve true si cambió algo — el caller sale
 * con código 99 y run.bat relanza el proceso con el código nuevo.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const log = (...a) => console.log('[UPDATER]', ...a);
const DIR = __dirname;
// run.bat corre npm install cuando ve este flag (lo dejamos si cambian las deps).
const DEPS_FLAG = path.join(DIR, 'update-deps.flag');
const VERSION_FILE = path.join(DIR, '.agent-version.json');
const ANTI_LOOP_MS = 10 * 60 * 1000;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function get(url, headers, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    });
}

async function checkAndUpdate(cfg) {
    const base = String(cfg.apiBase).replace(/\/$/, '');
    const headers = { 'x-seller-id': cfg.sellerId, 'x-agent-token': cfg.token };
    const manifest = JSON.parse((await get(base + '/agent-dist/manifest', headers)).toString('utf8'));

    // Anti-loop: si esta misma versión ya se aplicó hace <10 min y los hashes
    // siguen difiriendo, algo externo pisa los archivos (antivirus, disco).
    // Mejor seguir corriendo que reiniciar en círculos.
    try {
        const last = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
        if (last.version === manifest.version && Date.now() - last.ts < ANTI_LOOP_MS) {
            log('versión', manifest.version, 'ya aplicada hace <10min — anti-loop, sigo sin reiniciar');
            return false;
        }
    } catch (e) { /* primera vez */ }

    let changed = false;
    let depsChanged = false;
    for (const [name, want] of Object.entries(manifest.files || {})) {
        const local = path.join(DIR, name);
        let cur = null;
        try { cur = sha256(fs.readFileSync(local)); } catch (e) { /* no existe → bajar */ }
        if (cur === want) continue;
        const body = await get(base + '/agent-dist/file/' + name, headers);
        if (sha256(body) !== want) { log('⚠', name, 'no coincide con el manifest (¿deploy a medias?) — lo salto'); continue; }
        if (name === 'run.bat') {
            // run.bat se intercambia a sí mismo en su próxima vuelta (ver run.bat).
            fs.writeFileSync(local + '.new', body);
        } else {
            // .tmp + rename = reemplazo atómico en NTFS; los .js no quedan lockeados.
            fs.writeFileSync(local + '.tmp', body);
            fs.renameSync(local + '.tmp', local);
        }
        if (name === 'package.json' || name === 'package-lock.json') depsChanged = true;
        changed = true;
        log('✓ actualizado:', name);
    }
    if (depsChanged) fs.writeFileSync(DEPS_FLAG, '1');
    if (changed) fs.writeFileSync(VERSION_FILE, JSON.stringify({ version: manifest.version, ts: Date.now() }));
    return changed;
}

module.exports = { checkAndUpdate };
