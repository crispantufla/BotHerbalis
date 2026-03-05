require('dotenv').config();
const { aiService } = require('./src/services/ai');

const knowledgeStub = {
    business: {
        payment_methods: "Efectivo y transferencia.",
        delivery_time: "7 a 10 días."
    }
};

(async () => {
    // Escenario 1: Mensaje largo y emocional en el paso de toma de peso
    const test1 = "Hola, es lo mío. Es que tengo que bajar 20 kg. Por qué pesaba 61 resulta que tuve un accidente muy grande y todo fue en la cabeza... me siento muy gorda.";

    console.log("=== PRUEBA 1: WAITNG WEIGHT EMOCIONAL ===");
    console.log("Usuario: " + test1);
    const resp1 = await aiService.chat(test1, {
        step: 'waiting_weight',
        goal: 'Explicar brevemente el producto seleccionado y preguntar sutilmente cuánto peso buscan bajar para continuar. RESPONDÉ NATURALMENTE Y COMO HUMANO. 1) Si la persona envía un mensaje largo contando una historia, un problema personal, de salud, inseguridades de peso o miedos: TÓMATE TODO TU TIEMPO, usa párrafos largos, muestra muchísima empatía conectando tu respuesta con cada una de sus palabras antes de decirle nada del producto. No te limites, sé humana, reconfortala. 2) No te limites si el usuario hace preguntas sobre dietas, rebote o cuidados, dales respuestas completísimas, tenés espacio para escribir. 3) Solo si el usuario envía un texto rápido o escueto como "hola" o un número, sé más concisa. 4) TERMINA SIEMPRE con la pregunta "¿Cuántos kilos te gustaría bajar aproximadamente?" al final de tu respuesta de validación. 5) Si preguntan "cápsulas o gotas", o piden recomendación general, decirle EXACTAMENTE: "Mirá, las cápsulas son la opción más efectiva y práctica para la mayoría. ¿Cuántos kilos querés bajar?".',
        history: [],
        summary: "",
        knowledge: knowledgeStub,
        userState: {}
    });
    console.log("\nIA:\n" + resp1.response);
    console.log("Tokens aprox: " + resp1.response.length);


    // Escenario 2: Mensaje largo contando drama de salud en la toma de datos (Debería explayarse en vez de pedir calle)
    const test2 = "Hola mi nombre es Laura, vivo en San Martin 1234, Ramos Mejía, y la verdad estoy dudando porque tengo mucho miedo de que me haga mal, tengo gastritis crónica y no sé si las cápsulas me van a caer pesadas. Es seguro esto?";

    console.log("\n\n=== PRUEBA 2: WAITING DATA CON MEDO/ENFERMEDAD ===");
    console.log("Usuario: " + test2);
    const resp2 = await aiService.chat(test2, {
        step: 'waiting_data',
        goal: 'El usuario tiene una duda o expresa una preocupación en plena toma de datos (ej: pregunta cómo se paga, cuándo llega, si le entregan en el trabajo, o cuenta un largo problema personal). DEBES RESPONDER SU TEXTO DIRECTAMENTE de forma EXTENSA Y MUY EMPÁTICA usando el Knowledge. Si expresa miedos sobre demoras o recepción, redactá un párrafo largo brindando tranquilidad absoluta. Si pregunta si puede recibir en su TRABAJO: "Si estás en horario laboral del cartero no hay problema. Si no te encuentra, vas con el DNI a la sucursal.". Si pregunta formas de pago: "El pago a domicilio es al cartero en efectivo". Si pregunta tiempos: "Tarda de 7 a 10 días hábiles en promedio.". Nunca lo obligues a dar los datos, respondé su duda o drama con muchísima calidez, tómate tu tiempo, y cerrá sutilmente con: "¿Te parece que lo dejemos anotado?" o "¿Te tomo los datos?".',
        history: [],
        summary: "",
        knowledge: knowledgeStub,
        userState: {}
    });
    console.log("\nIA:\n" + resp2.response);
    console.log("Tokens aprox: " + resp2.response.length);

})();
