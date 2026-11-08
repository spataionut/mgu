'use strict';
// A fake GitHub for test/probe_github.test.js: device flow, release creation, asset upload.
//   node test/fake_github.js <port> <outdir>
// Saves each uploaded asset to <outdir>/<name>; logs one JSON line per request to <outdir>/requests.log.
const http = require('http');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

const port = Number(process.argv[2]);
const out = process.argv[3];
const CLIENT = 'test-client';
const TOKEN = 'ghu_faketoken';
const REPO = '/repos/spataionut/mgu-dumps';
let polls = 0;

const log = (o) => fs.appendFileSync(path.join(out, 'requests.log'), JSON.stringify(o) + '\n');
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer((req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
        const body = Buffer.concat(parts);
        const auth = req.headers.authorization || '';
        const entry = { method: req.method, url: req.url, length: body.length, contentLength: Number(req.headers['content-length']), auth: auth === 'Bearer ' + TOKEN };
        log(entry);
        if (req.url === '/login/device/code') {
            const f = querystring.parse(body.toString());
            if (f.client_id !== CLIENT) return send(res, 401, { error: 'bad client' });
            return send(res, 200, { device_code: 'dev123', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
        }
        if (req.url === '/login/oauth/access_token') {
            const f = querystring.parse(body.toString());
            if (f.device_code !== 'dev123' || f.client_id !== CLIENT) return send(res, 400, { error: 'bad_verification_code' });
            polls++;
            return send(res, 200, polls < 2 ? { error: 'authorization_pending' } : { access_token: TOKEN, token_type: 'bearer' });
        }
        if (!entry.auth) return send(res, 401, { message: 'Bad credentials' });
        if (req.method === 'POST' && req.url === REPO + '/releases') {
            const j = JSON.parse(body.toString());
            if (!/^dump-/.test(j.tag_name)) return send(res, 422, { message: 'bad tag' });
            return send(res, 201, { id: 7, tag_name: j.tag_name });
        }
        const m = /^\/repos\/spataionut\/mgu-dumps\/releases\/7\/assets\?name=([\w.-]+)$/.exec(req.url);
        if (req.method === 'POST' && m) {
            if (body.length !== entry.contentLength) return send(res, 400, { message: 'length mismatch' });
            fs.writeFileSync(path.join(out, m[1]), body);
            return send(res, 201, { id: 1, name: m[1], size: body.length });
        }
        send(res, 404, { message: 'Not Found' });
    });
}).listen(port, '127.0.0.1', () => log({ listening: port }));
