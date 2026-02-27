const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'src/components/corporate/v2');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsx')).map(f => path.join(dir, f));

// Also include Dashboard panels? Let's just do base components for now
const extraDirs = [
    path.join(__dirname, 'src/components/corporate/v2/dashboard')
];

let allFiles = [...files];

try {
    const panels = fs.readdirSync(extraDirs[0]).filter(f => f.endsWith('.jsx')).map(f => path.join(extraDirs[0], f));
    allFiles = [...allFiles, ...panels];
} catch (e) { }

allFiles.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');

    // ONLY apply dark classes if they aren't already there.

    // Backgrounds
    content = content.replace(/bg-white(?!\/| |dark:|-[a-z]|"|'|>)/g, 'bg-white dark:bg-slate-800');
    content = content.replace(/bg-white\/(\d+)(?! |dark:|")/g, 'bg-white/$1 dark:bg-slate-800/$1');
    content = content.replace(/bg-slate-50(?!\/| |dark:|-[a-z]|"|'|>)/g, 'bg-slate-50 dark:bg-slate-800/80');
    content = content.replace(/bg-slate-50\/(\d+)(?! |dark:|")/g, 'bg-slate-50/$1 dark:bg-slate-800/$1');
    content = content.replace(/bg-slate-100(?!\/| |dark:|-[a-z]|"|'|>)/g, 'bg-slate-100 dark:bg-slate-700/50');
    content = content.replace(/bg-slate-100\/(\d+)(?! |dark:|")/g, 'bg-slate-100/$1 dark:bg-slate-700/$1');

    // Borders
    content = content.replace(/border-white(?!\/| |dark:|-[a-z]|"|'|>)/g, 'border-white dark:border-slate-700');
    content = content.replace(/border-white\/(\d+)(?! |dark:|")/g, 'border-white/$1 dark:border-slate-700/$1');
    content = content.replace(/border-slate-100(?!\/| |dark:|-[a-z]|"|'|>)/g, 'border-slate-100 dark:border-slate-700/50');
    content = content.replace(/border-slate-200(?!\/| |dark:|-[a-z]|"|'|>)/g, 'border-slate-200 dark:border-slate-600/50');

    // Text
    content = content.replace(/text-slate-800(?!\/| |dark:|-[a-z]|"|'|>)/g, 'text-slate-800 dark:text-slate-100');
    content = content.replace(/text-slate-700(?!\/| |dark:|-[a-z]|"|'|>)/g, 'text-slate-700 dark:text-slate-200');
    content = content.replace(/text-slate-600(?!\/| |dark:|-[a-z]|"|'|>)/g, 'text-slate-600 dark:text-slate-300');
    content = content.replace(/text-slate-500(?!\/| |dark:|-[a-z]|"|'|>)/g, 'text-slate-500 dark:text-slate-400');
    content = content.replace(/text-slate-400(?!\/| |dark:|-[a-z]|"|'|>)/g, 'text-slate-400 dark:text-slate-500');

    fs.writeFileSync(file, content);
});
console.log('Applied dark mode classes to', allFiles.length, 'V2 components');
