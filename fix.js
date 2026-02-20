const fs = require('fs');

function fixFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');

    // Account for \r?\n in Windows
    const regex = /^([ \t]*)(await sendMessageWithDelay\([^;]+;)[ \t]*\r?\n((?:[ \t]*(?:currentState\.history\.push[^;]+;|currentState\.step[ \t]*=[^;]+;|_setStep[^;]+;|saveState\(\);)[ \t]*\r?\n)+)/gm;

    let count = 0;
    const newContent = content.replace(regex, (match, indent, awaitStmt, mutations) => {
        count++;
        return mutations + indent + awaitStmt + '\r\n'; // or just use mutations' existing newline and append awaitStmt
    });

    console.log(`Replaced ${count} occurrences in ${filePath}`);
    fs.writeFileSync(filePath, newContent, 'utf8');
}

fixFile('src/flows/salesFlow.js');
