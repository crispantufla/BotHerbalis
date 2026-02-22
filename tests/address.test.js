require('dotenv').config();
const { aiService } = require('../src/services/ai');

// Setting a longer timeout for tests since they interact with the OpenAI API
jest.setTimeout(30000);

describe('Address Extraction AI Tests', () => {

    // Check if OPENAI_API_KEY is present, otherwise these tests will always fail
    beforeAll(() => {
        if (!process.env.OPENAI_API_KEY) {
            console.warn("⚠️ OPENAI_API_KEY is missing. Address extraction tests will likely fail.");
        }
    });

    const testCases = [
        {
            input: "marta pastor bengas 77 rosario 2000",
            expectedContains: { nombre: "marta pastor", ciudad: "rosario", cp: "2000" }
        },
        {
            input: "Juan perez, San martin 1234, cordoba capital, cp 5000",
            expectedContains: { nombre: "Juan perez", ciudad: "cordoba capital", cp: "5000" }
        },
        {
            input: "mi dirección es av belgrano 45D, san miguel de tucuman",
            expectedContains: { calle: "av belgrano 45D", ciudad: "san miguel de tucuman" }
        },
        {
            input: "calle falsa 123 esquina siempre viva",
            expectedContains: { calle: "calle falsa 123 esquina siempre viva" }
        },
        {
            input: "12 de octubre 456, entre rios, parana",
            expectedContains: { calle: "12 de octubre 456", provincia: "entre rios", ciudad: "parana" }
        }
    ];

    test.each(testCases)('Extracts correctly for: "$input"', async ({ input, expectedContains }) => {
        const result = await aiService.parseAddress(input);

        let data = result;
        if (result && result.extractedData) data = result.extractedData;

        expect(data).toBeDefined();

        // Assert that the extracted data contains the expected substrings/values (case and accent insensitive)
        const normalize = str => (str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

        for (const [key, expectedValue] of Object.entries(expectedContains)) {
            expect(data[key]).toBeDefined();
            expect(normalize(data[key])).toContain(normalize(expectedValue));
        }
    });

    test('It isolates the person name from street name correctly', async () => {
        const result = await aiService.parseAddress("soy lucia, mendoza 123, bs as");
        let data = result.extractedData || result;

        const normalize = str => (str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

        console.log("Extracted data 2:", data);
        expect(data).toBeDefined();
        expect(normalize(data.nombre)).toContain("lucia");
        expect(normalize(data.calle)).toContain("mendoza 123");
    });
});
