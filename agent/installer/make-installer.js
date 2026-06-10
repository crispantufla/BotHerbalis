/**
 * make-installer.js — Genera el instalador personalizado de un vendedor.
 *
 * Lee agent/config.json (el del vendedor a instalar), embebe el config en
 * base64 dentro de install.ps1 y deja la carpeta lista para copiar a la otra
 * PC en agent/installer/dist/<sellerId>/.
 *
 *   node agent/installer/make-installer.js
 *
 * ANTES de correrlo: regenerar el apiToken con vida larga (los botones del
 * panel mueren cuando expira el JWT):
 *   $env:JWT_SECRET='<de railway variables>'
 *   npx tsx -r dotenv/config prisma/gen-token.ts horacio 365d
 */
'use strict';

const fs = require('fs');
const path = require('path');

const cfgPath = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(cfgPath)) { console.error('Falta agent/config.json'); process.exit(1); }
const raw = fs.readFileSync(cfgPath, 'utf8');
const cfg = JSON.parse(raw);

for (const k of ['gatewayUrl', 'sellerId', 'token', 'apiBase']) {
    if (!cfg[k]) { console.error(`config.json sin "${k}"`); process.exit(1); }
}
if (!cfg.apiToken) console.warn('⚠ config.json sin apiToken — los botones del panel no van a andar');
if (/localhost|127\.0\.0\.1/.test(cfg.gatewayUrl + cfg.apiBase)) {
    console.error('config.json apunta a localhost — el instalador es para la PC del vendedor (usar URLs de Railway)');
    process.exit(1);
}

const outDir = path.join(__dirname, 'dist', cfg.sellerId);
fs.mkdirSync(outDir, { recursive: true });

const b64 = Buffer.from(raw, 'utf8').toString('base64');
const template = fs.readFileSync(path.join(__dirname, 'install.ps1'), 'utf8');
const ps1 = template.replace(/__CONFIG_B64__/g, b64);
if (ps1 === template) { console.error('No encontré el placeholder __CONFIG' + '_B64__ en install.ps1'); process.exit(1); }
// BOM para que PowerShell 5.1 lea el archivo como UTF-8 (sin BOM asume ANSI).
fs.writeFileSync(path.join(outDir, 'install.ps1'), '\ufeff' + ps1.replace(/^\ufeff/, ''), 'utf8');
fs.copyFileSync(path.join(__dirname, 'Instalar Bot Herbalis.bat'), path.join(outDir, 'Instalar Bot Herbalis.bat'));

console.log(`✅ Instalador de "${cfg.sellerId}" listo en ${outDir}`);
console.log('   Copiar esa carpeta a la PC del vendedor y doble click en "Instalar Bot Herbalis.bat".');
