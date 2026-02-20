const fs = require('fs');
const path = require('path');

const salesFlowPath = path.join(__dirname, 'src', 'flows', 'salesFlow.js');
let content = fs.readFileSync(salesFlowPath, 'utf8');

// The regex looks for `currentState.history.push({ role: '...', content: ... });`
const regex = /currentState\.history\.push\(\{\s*role:\s*(['"`]\w+['"`]),\s*content:\s*(.*?)\s*\}\);/g;

const newContent = content.replace(regex, (match, p1, p2) => {
    return `currentState.history.push({ role: ${p1}, content: ${p2}, timestamp: Date.now() });`;
});

fs.writeFileSync(salesFlowPath, newContent, 'utf8');
console.log('Replaced successfully.');
