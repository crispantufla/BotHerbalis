module.exports = {
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/jest.setup.js'],
    // /archive/: ahí viven las suites retiradas del fork (tests-argentina/).
    // Reproducen incidentes del mercado argentino —"sucursal del correo",
    // retiro-first, precios en pesos— sobre un paso de envío que España
    // reescribió a propósito (domicilio vs oficina, ambos contrarreembolso).
    // Llevaban rojas desde el fork y camuflaban fallos reales. Los incidentes
    // originales siguen cubiertos en el repo argentino; el harness de
    // simulación PROPIO de España está pendiente.
    testPathIgnorePatterns: ['/node_modules/', '/dist/', '/mobile-app/', '/\\.claude/', '/archive/'],
};
