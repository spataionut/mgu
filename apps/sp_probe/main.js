'use strict';
/**
 * SB Probe: a one-off helper for Service Book development, for a car without SSH.
 *
 * - Shows the odometer (KombiIF.statusRangeTankStatus.mileageKilometre, unverified).
 * - "Copy files to USB stick": writes sp_probe/<time>.tar and report.txt to every stick under /media.
 * - "Serve files over Wi-Fi": http://<head unit>:8737/ for 10 minutes (report and dump.tar).
 *
 * The dump holds the SOME/IP catalog, one BMW app bundle and RHMI layout files. It never reads
 * apps' data folders. The report says what this app's user may read and write, and where BMW's
 * javascript on the unit mentions a speller or the RHMI component table.
 *
 * Node 8: no optional chaining, no optional catch binding, no fs.promises.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const util = require('util');
const mgu = require('./kit/mgu');
const { TarWriter } = require('./probe_tar');

const readFile = util.promisify(fs.readFile);
const readdir = util.promisify(fs.readdir);
const lstat = util.promisify(fs.lstat);
const fsOpen = util.promisify(fs.open);
const fsWrite = util.promisify(fs.write);
const fsFsync = util.promisify(fs.fsync);
const fsClose = util.promisify(fs.close);
const fsRename = util.promisify(fs.rename);
const tick = () => new Promise((r) => setImmediate(r));

// Test-only: a fake unit tree on a PC (test/probe_e2e.test.js). Unset on the car.
const ROOT = process.env.SP_PROBE_ROOT || '';
const PORT = 8737;
const SERVE_MS = 10 * 60 * 1000;
const MAX_FILE = 64 * 1024 * 1024;
const OAP = ROOT + '/var/opt/public/oap';
const MAINAPP = ROOT + '/usr/lib/oap-mainapp';
const FIXED = [
    ROOT + '/etc/oap/someip/someip-interfaces.json',
    OAP + '/oap_12204/source/javascript/app.js',
    OAP + '/oap_12204/source/package.json',
];
const RHMI_NAMES = { 'application.xml': 1, 'uiDescription.json': 1, 'application.json': 1 };
const GREP = [
    { term: /speller/ig, max: 40, ctx: 240 },
    { term: /editRoll/g, max: 10, ctx: 240 },
    { term: /dropDownMenu/g, max: 4, ctx: 700 },     // finds the RHMI component type table
    { term: /['"]input['"]/g, max: 15, ctx: 200 },
];

const state = { odo: null, odoRaw: null, odoError: null, busy: false, server: null, serverTimer: null };

function errCode(e) { return (e && (e.code || e.message)) || String(e); }

/** Walk dir, calling visit(file) for regular files; never follows symlinks. */
async function walk(dir, depth, visit, skip) {
    if (depth < 0) return;
    let names;
    try { names = await readdir(dir); } catch (e) { return; }
    for (const n of names) {
        const p = path.join(dir, n);
        if (skip && skip(p, n)) continue;
        let st;
        try { st = await lstat(p); } catch (e) { continue; }
        if (st.isDirectory()) await walk(p, depth - 1, visit, skip);
        else if (st.isFile()) await visit(p, st);
    }
}

/** Under /var/opt/public/oap/oap_<uid>/ only source/ and rhmiData*: never an app's data. */
function skipAppData(p, n) {
    const rel = path.relative(OAP, p).split(path.sep);
    return rel.length === 2 && !(n === 'source' || n.indexOf('rhmiData') === 0);
}

async function collectFiles() {
    const files = FIXED.slice();
    const pick = (p) => { if (RHMI_NAMES[path.basename(p)] && p.indexOf('rhmiData') >= 0) files.push(p); };
    await walk(MAINAPP, 8, pick);
    await walk(OAP, 8, pick, skipAppData);
    return files.filter((p, i) => files.indexOf(p) === i);
}

async function jsFiles() {
    const out = [];
    const pickJs = (p, st) => { if (/\.js$/.test(p) && st.size < MAX_FILE) out.push(p); };
    await walk(MAINAPP, 6, pickJs);
    let apps = [];
    try { apps = await readdir(OAP); } catch (e) { /* none */ }
    for (const a of apps) await walk(path.join(OAP, a, 'source', 'javascript'), 0, pickJs);
    return out.slice(0, 400);
}

async function grepReport(lines) {
    const files = await jsFiles();
    lines.push('', '== javascript search (' + files.length + ' files)');
    for (const f of files) {
        let s;
        try { s = (await readFile(f)).toString('latin1'); } catch (e) { lines.push('unreadable ' + f + ': ' + errCode(e)); continue; }
        for (const g of GREP) {
            g.term.lastIndex = 0;
            let m, n = 0;
            while ((m = g.term.exec(s)) && n < g.max) {
                n++;
                const a = Math.max(0, m.index - g.ctx / 2), b = Math.min(s.length, m.index + g.ctx / 2);
                lines.push('[' + g.term.source + '] ' + f + ' @' + m.index + ': ' + s.slice(a, b).replace(/\s+/g, ' '));
            }
        }
        await tick();
    }
}

async function canWrite(dir) {
    const p = path.join(dir, '.sp_probe_write_test');
    try {
        fs.writeFileSync(p, 'x');
        fs.unlinkSync(p);
        return 'yes';
    } catch (e) {
        return 'no (' + errCode(e) + ')';
    }
}

function usbMounts() {
    try {
        return fs.readFileSync(ROOT + '/proc/mounts', 'utf8').split('\n')
            .map((l) => l.split(' '))
            .filter((f) => f[1] && f[1].indexOf('/media/') === 0)
            .map((f) => ({ dir: ROOT + f[1].replace(/\\040/g, ' '), type: f[2], opts: f[3] }));
    } catch (e) {
        return [];
    }
}

function addresses() {
    const out = [];
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach((k) => (ifs[k] || []).forEach((a) => {
        if (a.family === 'IPv4' && !a.internal) out.push(k + ' ' + a.address);
    }));
    return out;
}

async function report(ctx, files) {
    const lines = ['SB Probe report ' + new Date().toISOString(), ''];
    const id = () => { try { return process.getuid() + '/' + process.getgid() + ' groups ' + process.getgroups().join(','); } catch (e) { return errCode(e); } };
    lines.push('uid/gid: ' + id());
    lines.push('dataDir: ' + ctx.dataDir);
    lines.push('app dir: ' + __dirname);
    lines.push('node: ' + process.version);
    lines.push('addresses: ' + addresses().join(', '));
    lines.push('odometer: ' + (state.odo !== null ? state.odo + ' km' : 'none') + (state.odoError ? ' (error: ' + state.odoError + ')' : ''));
    lines.push('odometer raw struct: ' + JSON.stringify(state.odoRaw));
    lines.push('', '== mounts under /media');
    usbMounts().forEach((m) => lines.push(m.dir + ' ' + m.type + ' ' + m.opts));
    lines.push('', '== write tests');
    const dirs = [ctx.dataDir, path.dirname(ctx.dataDir || '/'), OAP, '/var/opt/public', '/tmp', '/var/tmp', os.homedir()]
        .concat(usbMounts().map((m) => m.dir));
    for (const d of dirs) lines.push(d + ': ' + await canWrite(d));
    lines.push('', '== files (' + files.length + ')');
    for (const f of files) {
        try { lines.push('ok   ' + fs.statSync(f).size + ' ' + f); } catch (e) { lines.push('FAIL ' + errCode(e) + ' ' + f); }
    }
    await grepReport(lines);
    return lines.join('\n') + '\n';
}

/** Writes the report and every readable file into the tar; returns { files, skipped }. */
async function writeTar(tar, reportText, files) {
    let skipped = 0;
    await tar.add('sp_probe/report.txt', Buffer.from(reportText, 'utf8'));
    for (const f of files) {
        let data, st;
        try {
            st = fs.statSync(f);
            if (st.size > MAX_FILE) { skipped++; continue; }
            data = await readFile(f);
        } catch (e) { skipped++; continue; }
        if (!(await tar.add(f.slice(ROOT.length), data, st.mtime.getTime() / 1000))) skipped++;
        await tick();
    }
    await tar.finish();
    return { files: tar.files, skipped };
}

async function copyToUsb(ctx) {
    const mounts = usbMounts();
    if (!mounts.length) return 'No USB stick found under /media';
    ctx.ui.text('T_STATUS', 'Collecting files...');
    const files = await collectFiles();
    const text = await report(ctx, files);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const results = [];
    for (const m of mounts) {
        const dir = path.join(m.dir, 'sp_probe');
        try {
            try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
            fs.writeFileSync(path.join(dir, 'report-' + stamp + '.txt'), text);
            ctx.ui.text('T_STATUS', 'Writing to ' + m.dir + '...');
            const tmp = path.join(dir, 'dump-' + stamp + '.tar.part');
            const fd = await fsOpen(tmp, 'w');
            let r;
            try {
                r = await writeTar(new TarWriter((b) => fsWrite(fd, b, 0, b.length)), text, files);
                await fsFsync(fd);
            } finally {
                await fsClose(fd);
            }
            await fsRename(tmp, path.join(dir, 'dump-' + stamp + '.tar'));
            results.push(m.dir + ': ' + r.files + ' files' + (r.skipped ? ', ' + r.skipped + ' unreadable' : ''));
        } catch (e) {
            results.push(m.dir + ': failed (' + errCode(e) + ')');
            ctx.log.warn('usb ' + m.dir + ': ' + (e && e.stack || e));
        }
    }
    return results.join('; ');
}

function stopServer(ctx) {
    if (state.serverTimer) clearTimeout(state.serverTimer);
    state.serverTimer = null;
    if (state.server) {
        try { state.server.close(); } catch (e) { /* already closed */ }
        state.server = null;
        ctx.ui.text('T_DETAIL', 'Wi-Fi server stopped');
    }
}

/** Only clients on private networks (the car's hotspot), never a public address. */
function privateClient(addr) {
    const a = String(addr || '').replace(/^::ffff:/, '');
    return /^(10\.|192\.168\.|169\.254\.|127\.)/.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
}

function handle(ctx, req, res) {
    res.on('error', () => {});
    req.on('error', () => {});
    if (!privateClient(req.socket && req.socket.remoteAddress)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('forbidden\n');
        return;
    }
    const fail = (e) => {
        ctx.log.warn('http: ' + (e && e.stack || e));
        try { res.destroy(); } catch (x) { /* gone */ }
    };
    Promise.resolve().then(async () => {
        if (req.url === '/' || req.url === '/report.txt') {
            const text = await report(ctx, await collectFiles());
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(text);
        } else if (req.url === '/dump.tar') {
            ctx.ui.text('T_STATUS', 'Sending dump.tar over Wi-Fi...');
            const files = await collectFiles();
            const text = await report(ctx, files);
            res.writeHead(200, { 'Content-Type': 'application/x-tar' });
            let gone = false;
            res.on('close', () => { gone = true; res.emit('drain'); });
            const write = (b) => new Promise((resolve, reject) => {
                if (gone) return reject(new Error('client gone'));
                if (res.write(b)) resolve();
                else res.once('drain', () => (gone ? reject(new Error('client gone')) : resolve()));
            });
            const r = await writeTar(new TarWriter(write), text, files);
            res.end();
            ctx.ui.text('T_STATUS', 'Sent ' + r.files + ' files over Wi-Fi');
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('try / or /dump.tar\n');
        }
    }).catch(fail);
}

function startServer(ctx) {
    if (state.server) return 'Already serving on port ' + PORT;
    const server = http.createServer((req, res) => handle(ctx, req, res));
    server.on('error', (e) => {
        ctx.ui.text('T_DETAIL', 'Wi-Fi server failed: ' + errCode(e));
        ctx.log.warn('server: ' + errCode(e));
        state.server = null;
    });
    server.on('clientError', (e, socket) => { try { socket.destroy(); } catch (x) { /* gone */ } });
    server.listen(PORT, '0.0.0.0', () => {
        ctx.ui.text('T_DETAIL', 'http://<address>:' + PORT + '/dump.tar  ' + addresses().join(', '));
    });
    state.server = server;
    state.serverTimer = setTimeout(() => stopServer(ctx), SERVE_MS);
    return 'Wi-Fi server on port ' + PORT + ' for 10 minutes';
}

/** Run one button action at a time; never let an error escape. */
function guarded(ctx, label, fn) {
    return () => {
        if (state.busy) { ctx.ui.text('T_STATUS', 'Busy, please wait'); return Promise.resolve(); }
        state.busy = true;
        ctx.ui.text('T_STATUS', label + '...');
        return Promise.resolve().then(() => fn(ctx))
            .then((msg) => ctx.ui.text('T_STATUS', msg || 'Done'))
            .catch((e) => {
                ctx.log.error(label, e);
                ctx.ui.text('T_STATUS', label + ' failed: ' + errCode(e));
            })
            .then(() => { state.busy = false; });
    };
}

function watchOdometer(ctx) {
    ctx.signals.watch('de.bmw.infotainment.KombiIF', '1', {
        statusRangeTankStatus: (v) => {
            state.odoRaw = v;
            const km = v && v.mileageKilometre;
            state.odo = typeof km === 'number' ? km : null;
            ctx.ui.text('T_ODO', state.odo !== null ? 'Odometer: ' + state.odo + ' km' : 'Odometer: no mileageKilometre in signal');
        },
    }, ctx.log).then((sub) => {
        if (sub.error) {
            state.odoError = sub.error;
            ctx.ui.text('T_ODO', 'Odometer: unavailable (' + sub.error.slice(0, 60) + ')');
        }
    }).catch((e) => {
        state.odoError = errCode(e);
        ctx.ui.text('T_ODO', 'Odometer: error ' + errCode(e));
    });
}

mgu.run({
    async start(ctx) {
        try {
            ctx.ui.onClick('BTN_USB', guarded(ctx, 'Copying to USB', copyToUsb));
            ctx.ui.onClick('BTN_NET', guarded(ctx, 'Starting Wi-Fi server', startServer));
            watchOdometer(ctx);
            ctx.ui.text('T_STATUS', 'Ready. Plug in a FAT32 stick, then tap Copy.');
        } catch (e) {
            ctx.log.error('start', e);
        }
    },
});
