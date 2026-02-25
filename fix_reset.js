const http = require('http');

const data = JSON.stringify({ chatId: '34621332862@c.us' });

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/reset-chat',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'b20cbba9d5bc48f4bc73c255a0dc3583',
        'Content-Length': data.length
    }
};

const req = http.request(options, res => {
    console.log(`statusCode: ${res.statusCode}`);
    res.on('data', d => process.stdout.write(d));
});

req.on('error', error => console.error(error));
req.write(data);
req.end();
