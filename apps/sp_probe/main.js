'use strict';
/**
 * SB Probe: a one-off helper for Service Book development, for a car without SSH.
 *
 * - Shows the odometer (KombiIF.statusRangeTankStatus.mileageKilometre).
 * - "Upload to GitHub": device sign-in on the phone, then a release in the private
 *   spataionut/mgu-dumps with report.txt and dump.tar (probe_github.js).
 * - "Send files to Mac" (fallback): finds tools/receive-dump.py on the uplink's subnet (the phone hotspot the
 *   car joined through mgu-uplink) and uploads report-<time>.txt and dump-<time>.tar to it.
 *
 * Why push and not USB or a server (seen on the car, 0.1.0): USB sticks are read-only for apps
 * (EROFS), and the unit's firewall drops every incoming connection an app could listen for.
 * mgu-uplink lets apps with "mguInternet" connect out through the uplink, so the probe connects out.
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
const github = require('./probe_github');

const readFile = util.promisify(fs.readFile);
const readdir = util.promisify(fs.readdir);
const lstat = util.promisify(fs.lstat);
const tick = () => new Promise((r) => setImmediate(r));

// Test-only overrides: a fake unit tree and receiver port on a PC (test/probe_e2e.test.js). Unset on the car.
const ROOT = process.env.SP_PROBE_ROOT || '';
const PORT = Number(process.env.SP_PROBE_PORT) || 8737;
const HELLO = 'sp-probe-receiver 1';
const HELLO_MS = 1500;
const SCAN_PARALLEL = 32;
const MAX_HOSTS = 1022;          // up to a /22; bigger subnets are only tried at the router and ARP neighbours
const IDLE_MS = 60 * 1000;
// GitHub upload: the client id of the owner's own GitHub App (public, not a secret), installed only
// on the private repo below. Test-only overrides point it at a fake GitHub.
const GH_CLIENT_ID = process.env.SP_PROBE_GH_CLIENT || 'Iv23liqYfRZ1xiIC5PIm';   // GitHub App sp-probe-upload
const GH_REPO = 'spataionut/mgu-dumps';
const GH_BASE = process.env.SP_PROBE_GH_BASE || '';
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

const state = { odo: null, odoRaw: null, odoError: null, busy: false };

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
    lines.push('uplink lease: ' + JSON.stringify(readLease(ctx)));
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

/** mgu-uplink's lease: {interface, ip, prefix, router, dns[]}, present only while online. */
function readLease(ctx) {
    const tries = [];
    if (ctx && ctx.dataDir) tries.push(path.join(ctx.dataDir, 'uplink.json'));
    tries.push(ROOT + '/run/mgu-uplink/lease.json');
    for (const p of tries) {
        try {
            const l = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (l && l.ip && l.prefix) return l;
        } catch (e) { /* next */ }
    }
    return null;
}

function ipToInt(s) {
    const p = String(s || '').split('.').map(Number);
    if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255) || Math.floor(x) !== x)) return null;
    return p[0] * 16777216 + p[1] * 65536 + p[2] * 256 + p[3];
}

function intToIp(n) {
    return [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join('.');
}

function arpNeighbours() {
    try {
        return fs.readFileSync(ROOT + '/proc/net/arp', 'utf8').split('\n').slice(1)
            .map((l) => l.trim().split(/\s+/))
            .filter((f) => f.length >= 4 && f[2] !== '0x0')
            .map((f) => f[0]);
    } catch (e) {
        return [];
    }
}

/** Addresses to try on the lease's subnet: the router first, then ARP neighbours, then every host. */
function candidates(lease, neighbours) {
    const me = ipToInt(lease.ip);
    const prefix = Number(lease.prefix);
    if (me === null || !(prefix >= 8 && prefix <= 30)) return [];
    const size = Math.pow(2, 32 - prefix);
    const net = Math.floor(me / size) * size;
    const out = [];
    const seen = {};
    const add = (ip) => {
        const n = ipToInt(ip);
        if (n === null || n === me || n <= net || n >= net + size - 1 || seen[n]) return;
        seen[n] = true;
        out.push(intToIp(n));
    };
    add(lease.router);
    neighbours.forEach(add);
    if (size - 2 <= MAX_HOSTS) for (let n = net + 1; n < net + size - 1; n++) add(intToIp(n));
    return out;
}

/** GET /sp-probe-hello; resolves { ok } or { err: code }. */
function hello(host) {
    return new Promise((resolve) => {
        let done = false;
        const fin = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
        const req = http.get({ host: host, port: PORT, path: '/sp-probe-hello', timeout: HELLO_MS }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { body += d; if (body.length > 200) req.abort(); });
            res.on('end', () => fin(res.statusCode === 200 && body.trim() === HELLO ? { ok: true } : { err: 'not the receiver' }));
            res.on('error', () => fin({ err: 'reset' }));
        });
        req.on('timeout', () => { req.abort(); fin({ err: 'timeout' }); });
        req.on('error', (e) => fin({ err: errCode(e) }));
        const timer = setTimeout(() => { try { req.abort(); } catch (e) { /* gone */ } fin({ err: 'timeout' }); }, HELLO_MS + 500);
    });
}

async function findReceiver(ctx, hosts) {
    let next = 0, tried = 0, found = null;
    const errs = {};
    async function worker() {
        while (!found && next < hosts.length) {
            const h = hosts[next++];
            const r = await hello(h);
            tried++;
            if (r.ok) { if (!found) found = h; } else errs[r.err] = (errs[r.err] || 0) + 1;
            if (tried % 16 === 0 && !found) ctx.ui.text('T_DETAIL', 'Tried ' + tried + ' of ' + hosts.length + ' addresses');
        }
    }
    const workers = [];
    for (let k = 0; k < SCAN_PARALLEL; k++) workers.push(worker());
    await Promise.all(workers);
    return { found: found, errs: errs };
}

/** PUT /upload/<name>; produce(write) writes the body. Resolves with the receiver's answer. */
function upload(host, name, produce) {
    return new Promise((resolve, reject) => {
        let failed = null;
        const fail = (e) => { if (!failed) { failed = e; reject(e); req.emit('drain'); } };
        const req = http.request({
            host: host, port: PORT, method: 'PUT', path: '/upload/' + name,
            headers: { 'Content-Type': 'application/octet-stream' },
        });
        req.on('response', (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { body += d; });
            res.on('end', () => (res.statusCode === 200 ? resolve(body.trim())
                : fail(new Error('receiver said ' + res.statusCode + ' ' + body.trim().slice(0, 80)))));
            res.on('error', fail);
        });
        req.on('error', fail);
        req.on('abort', () => fail(new Error('aborted')));
        req.setTimeout(IDLE_MS, () => { fail(new Error('timeout')); req.abort(); });
        const write = (b) => new Promise((ok, no) => {
            if (failed) return no(failed);
            if (req.write(b)) ok();
            else req.once('drain', () => (failed ? no(failed) : ok()));
        });
        produce(write).then(() => req.end(), (e) => { fail(e); req.abort(); });
    });
}

async function sendToMac(ctx) {
    const lease = readLease(ctx);
    if (!lease) return 'No uplink. Join the phone hotspot in Store, Settings, Wi-Fi, then try again';
    ctx.ui.text('T_DETAIL', 'Uplink ' + (lease.interface || '?') + ' ' + lease.ip + '/' + lease.prefix + ', router ' + lease.router);
    const hosts = candidates(lease, arpNeighbours());
    if (!hosts.length) return 'No addresses to try on ' + lease.ip + '/' + lease.prefix;
    ctx.ui.text('T_STATUS', 'Looking for the Mac on ' + hosts.length + ' addresses...');
    const r = await findReceiver(ctx, hosts);
    if (!r.found) {
        const why = Object.keys(r.errs).map((k) => k + ' x' + r.errs[k]).join(', ');
        ctx.ui.text('T_DETAIL', 'Uplink ' + lease.ip + '/' + lease.prefix + ': ' + why);
        return 'No receiver found on port ' + PORT + '. Is receive-dump.py running on a Mac on the same hotspot?';
    }
    ctx.ui.text('T_STATUS', 'Found ' + r.found + ', collecting files...');
    const files = await collectFiles();
    const text = await report(ctx, files);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await upload(r.found, 'report-' + stamp + '.txt', (write) => write(Buffer.from(text, 'utf8')));
    ctx.ui.text('T_STATUS', 'Sending files to ' + r.found + '...');
    let sent = null;
    await upload(r.found, 'dump-' + stamp + '.tar', (write) => writeTar(new TarWriter(write), text, files).then((x) => { sent = x; }));
    ctx.ui.text('T_DETAIL', 'Done. You can uninstall SB Probe now.');
    return 'Sent ' + sent.files + ' files to ' + r.found + (sent.skipped ? ', ' + sent.skipped + ' unreadable' : '');
}

async function uploadToGitHub(ctx) {
    if (!GH_CLIENT_ID) return 'GitHub upload is not set up in this build';
    const lease = readLease(ctx);
    if (!lease) return 'No uplink. Join the phone hotspot in Store, Settings, Wi-Fi, then try again';
    const gh = {
        web: GH_BASE || 'https://github.com',
        api: GH_BASE || 'https://api.github.com',
        uploads: GH_BASE || 'https://uploads.github.com',
        clientId: GH_CLIENT_ID,
        repo: GH_REPO,
        lookup: GH_BASE ? undefined : github.makeLookup(lease),
    };
    ctx.ui.text('T_STATUS', 'Asking GitHub for a sign-in code...');
    let token = await github.deviceLogin(gh, (uri, code, expires) => {
        ctx.ui.text('T_STATUS', 'On your phone open ' + String(uri).replace(/^https?:\/\//, '') + ' and enter ' + code);
        ctx.ui.text('T_DETAIL', 'Code valid ' + Math.round(expires / 60) + ' min. Waiting for you to approve...');
    });
    try {
        ctx.ui.text('T_STATUS', 'Signed in. Collecting files...');
        ctx.ui.text('T_DETAIL', ' ');
        const files = await collectFiles();
        const text = await report(ctx, files);
        let size = 0;
        await writeTar(new TarWriter((b) => { size += b.length; return Promise.resolve(); }), text, files);
        const tag = 'dump-' + new Date().toISOString().replace(/[:.]/g, '-');
        const release = await github.createRelease(gh, token, tag, 'Uploaded by SB Probe from the head unit.');
        await github.uploadAsset(gh, token, release, 'report.txt', 'text/plain', Buffer.from(text, 'utf8'));
        ctx.ui.text('T_STATUS', 'Uploading ' + Math.round(size / 1048576) + ' MB to GitHub...');
        let sent = null;
        await github.uploadAsset(gh, token, release, 'dump.tar', 'application/x-tar', {
            length: size,
            produce: (write) => writeTar(new TarWriter(write), text, files).then((x) => { sent = x; }),
        });
        ctx.ui.text('T_DETAIL', 'Done. You can uninstall SB Probe now.');
        return 'Uploaded ' + sent.files + ' files to GitHub, release ' + tag;
    } finally {
        token = null;
    }
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
            ctx.ui.onClick('BTN_GH', guarded(ctx, 'Uploading to GitHub', uploadToGitHub));
            ctx.ui.onClick('BTN_SEND', guarded(ctx, 'Sending', sendToMac));
            watchOdometer(ctx);
            const lease = readLease(ctx);
            ctx.ui.text('T_STATUS', lease ? 'Ready. Tap Upload to GitHub.'
                : 'No uplink yet: join the phone hotspot in Store, Settings, Wi-Fi.');
        } catch (e) {
            ctx.log.error('start', e);
        }
    },
});
