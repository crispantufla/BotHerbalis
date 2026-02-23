const fs = require('fs');
const pdf = require('pdf-parse');

let dataBuffer = fs.readFileSync('recursos/ventas actualizado (1).pdf');

pdf(dataBuffer).then(function (data) {
    console.log(data.text);
}).catch(err => {
    console.error(err);
});
