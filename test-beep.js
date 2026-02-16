console.log('🔊 Probando sonido...');
console.log('\u0007'); // Character BEL (Beep)
setTimeout(() => {
    console.log('\u0007'); // Another one
    console.log('🔔 Beep!');
}, 1000);
