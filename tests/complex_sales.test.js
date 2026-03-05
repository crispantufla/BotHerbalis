const { processSalesFlow } = require('../src/flows/salesFlow');
const fs = require('fs');
const path = require('path');

const mockSendMessage = jest.fn();
const mockNotifyAdmin = jest.fn();
const mockSaveState = jest.fn();

const mockDependencies = {
    client: {}, notifyAdmin: mockNotifyAdmin, saveState: mockSaveState,
    sendMessageWithDelay: mockSendMessage, logAndEmit: jest.fn(),
    sharedState: { io: { emit: jest.fn() }, pausedUsers: new Set() },
    aiService: {
        chat: jest.fn().mockImplementation(async (text, context) => {
            let extractedData = null; let goalMet = false; let response = 'AI Default Response';
            if (/\b(60|120|180|240)\b/.test(text)) {
                const m = text.match(/\b(60|120|180|240)\b/);
                if (m) extractedData = m[1];
                goalMet = true;
            } else if (/gotas|semilla/i.test(text)) {
                extractedData = 'CHANGE_PRODUCT: ' + (/gotas/i.test(text) ? 'Gotas' : 'Semillas');
            } else if (/dale|si|ok/i.test(text)) { goalMet = true; }
            return { response, goalMet, extractedData };
        }),
        checkAndSummarize: jest.fn().mockResolvedValue(null),
        parseAddress: jest.fn().mockImplementation(async (text) => {
            if (text.length > 10 && /calle|av/i.test(text)) return { nombre: 'Test', calle: 'C1', ciudad: 'CABA', cp: '1425' };
            return null;
        })
    }
};

const knowledge = JSON.parse(fs.readFileSync(path.join(__dirname, '../knowledge_v3.json'), 'utf8'));

jest.mock('../src/services/ai', () => ({ aiService: mockDependencies.aiService }));
jest.mock('../safeWrite', () => ({ atomicWriteFile: jest.fn() }), { virtual: true });
jest.mock('../sheets_sync', () => ({ appendOrderToSheet: jest.fn() }), { virtual: true });
jest.mock('google-spreadsheet', () => ({}), { virtual: true });
jest.mock('@google/generative-ai', () => ({}), { virtual: true });

describe('Complex Sales Logic', () => {
    let userState = {};
    beforeEach(() => { userState = {}; mockSendMessage.mockClear(); mockNotifyAdmin.mockClear(); });
    const runFlow = async (u, m) => await processSalesFlow(u, m, userState, knowledge, mockDependencies);

    test('1. Cambio plan de 60 a 120 e interrumpe address', async () => {
        userState['u1'] = { step: 'waiting_data', selectedProduct: 'Capsulas', selectedPlan: '60', cart: [{ product: 'Capsulas', plan: '60', price: '45' }], partialAddress: { nombre: 'V' } };
        await runFlow('u1', 'Perdon voy a querer de 120 dias');
        expect(userState['u1'].selectedPlan).toBe('120');
        expect(Object.keys(userState['u1'].partialAddress).length).toBe(0);
    });

    test('2. Cambio de 120 a 60', async () => {
        userState['u2'] = { step: 'waiting_data', selectedProduct: 'Capsulas', selectedPlan: '120', cart: [], partialAddress: {} };
        await runFlow('u2', 'mejor de 60');
        expect(userState['u2'].selectedPlan).toBe('60');
    });

    test('3. Cambio de producto e interrumpe compra', async () => {
        userState['u3'] = { step: 'waiting_data', selectedProduct: 'Capsulas', selectedPlan: '60', cart: [], partialAddress: {} };
        await runFlow('u3', 'mejor gotas');
        expect(userState['u3'].selectedProduct).toContain('Gotas');
    });

    test('4. Cambio en etapa final de 120 a semillas de 60', async () => {
        userState['u4'] = { step: 'waiting_final_confirmation', selectedProduct: 'Capsulas', selectedPlan: '120', cart: [], partialAddress: {} };
        await runFlow('u4', 'no mejor pasame a semillas por 60');
        expect(userState['u4'].selectedProduct).toContain('Semillas');
        expect(userState['u4'].selectedPlan).toBe('60');
        expect(userState['u4'].step).toBe('waiting_final_confirmation');
    });

    test('5. Retries de direccion', async () => {
        userState['u5'] = { step: 'waiting_data', selectedProduct: 'Capsulas', selectedPlan: '60', cart: [], partialAddress: {}, addressAttempts: 0 };
        await runFlow('u5', 'Vero Ovejero');
        expect(userState['u5'].addressAttempts).toBe(1);
        await runFlow('u5', 'calle falsa 123 CABA');
        expect(userState['u5'].step).toBe('waiting_final_confirmation');
    });
});
