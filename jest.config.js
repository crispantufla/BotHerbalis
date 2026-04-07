module.exports = {
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/jest.setup.js'],
    testPathIgnorePatterns: ['/node_modules/', '/dist/', '/mobile-app/'],
};
