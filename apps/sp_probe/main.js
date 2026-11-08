'use strict';
/**
 * SB Probe: a one-off helper for Service Book (and later apps) development, for a car without SSH.
 *
 * - Shows the odometer (KombiIF.statusRangeTankStatus.mileageKilometre).
 * - "Upload to GitHub": device sign-in on the phone, then a release in the private
 *   spataionut/mgu-dumps with report.txt and dump.tar.gz.001, .002, ... (gzip members of one tar;
 *   `cat dump.tar.gz.* | tar xz` puts them back together). probe_github.js.
 * - "Send files to Mac" (fallback): finds tools/receive-dump.py on the uplink's subnet and uploads
 *   report-<time>.txt and dump-<time>.tar to it.
 *
 * What goes in the dump: probe_collect.js (platform, every app's source, /etc/oap, identity files,
 * a filesystem index; never apps' data folders or key material).
 *
 * Why push and not USB or a server (seen on the car, 0.1.0): USB sticks are read-only for apps
 * (EROFS), and the unit's firewall drops every incoming connection an app could listen for.
 * mgu-uplink lets apps with "mguInternet" connect out through the uplink, so the probe connects out.
 *
 * Node 8: no optional chaining, no optional catch binding, no fs.promises.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const zlib = require('zlib');
const mgu = require('./kit/mgu');
const { TarWriter } = require('./probe_tar');
const github = require('./probe_github');
const C = require('./probe_collect');

const errCode = C.errCode;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Test-only overrides: a fake unit tree, receiver port, part size and GitHub. Unset on the car.
const ROOT = process.env.SP_PROBE_ROOT || '';
const PORT = Number(process.env.SP_PROBE_PORT) || 8737;
const PART_RAW = Math.max(0.01, Number(process.env.SP_PROBE_PART_MB) || 16) * 1024 * 1024;
const HELLO = 'sp-probe-receiver 1';
const HELLO_MS = 1500;
const SCAN_PARALLEL = 32;
const MAX_HOSTS = 1022;          // up to a /22; bigger subnets are only tried at the router and ARP neighbours
const IDLE_MS = 60 * 1000;
// GitHub upload: the client id of the owner's own GitHub App (public, not a secret), installed only
// on the private repo below.
const GH_CLIENT_ID = process.env.SP_PROBE_GH_CLIENT || 'Iv23liqYfRZ1xiIC5PIm';   // GitHub App sp-probe-upload
const GH_REPO = 'spataionut/mgu-dumps';
const GH_BASE = process.env.SP_PROBE_GH_BASE || '';

const state = { odo: null, odoRaw: null, odoError: null, busy: false };

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

function canWrite(dir) {
    const p = path.join(dir, '.sp_probe_write_test');
    try {
        fs.writeFileSync(p, 'x');
        fs.unlinkSync(p);
        return 'yes';
    } catch (e) {
        return 'no (' + errCode(e) + ')';
    }
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

async function report(ctx, plan) {
    const lines = ['SB Probe report ' + new Date().toISOString(), ''];
    C.runtimeFacts().forEach((l) => lines.push(l));
    lines.push('dataDir: ' + ctx.dataDir);
    lines.push('app dir: ' + __dirname);
    lines.push('addresses: ' + addresses().join(', '));
    lines.push('uplink lease: ' + JSON.stringify(readLease(ctx)));
    lines.push('odometer: ' + (state.odo !== null ? state.odo + ' km' : 'none') + (state.odoError ? ' (error: ' + state.odoError + ')' : ''));
    lines.push('odometer raw struct: ' + JSON.stringify(state.odoRaw));
    lines.push('', '== mounts under /media');
    usbMounts().forEach((m) => lines.push(m.dir + ' ' + m.type + ' ' + m.opts));
    lines.push('', '== write tests');
    const oap = ROOT + '/var/opt/public/oap';
    const dirs = [ctx.dataDir, path.dirname(ctx.dataDir || '/'), oap, '/var/opt/public', '/tmp', '/var/tmp', '/dev/shm', os.homedir()]
        .concat(usbMounts().map((m) => m.dir));
    for (const d of dirs) lines.push(d + ': ' + canWrite(d));
    lines.push('', '== dump plan');
    lines.push(plan.files.length + ' files, ' + Math.round(plan.total / 1048576) + ' MB; by tier (identity, text/code, media): ' + plan.tiers.join(', '));
    lines.push(plan.skipped.length + ' skipped before reading (see sp_probe/skipped.txt in the dump)');
    await C.grepReport(ROOT, lines);
    return lines.join('\n') + '\n';
}

/** Collects everything for a dump: { plan, extras, text }. */
async function prepare(ctx) {
    ctx.ui.text('T_STATUS', 'Finding files...');
    const plan = await C.collect(ROOT, (n) => ctx.ui.text('T_DETAIL', 'Seen ' + n + ' files'));
    ctx.ui.text('T_STATUS', 'Indexing the filesystem...');
    const index = await C.buildIndex(ROOT, (n) => ctx.ui.text('T_DETAIL', 'Indexed ' + n + ' entries'));
    ctx.ui.text('T_STATUS', 'Writing the report...');
    const text = await report(ctx, plan);
    ctx.ui.text('T_DETAIL', plan.files.length + ' files, ' + Math.round(plan.total / 1048576) + ' MB before compression');
    return {
        plan: plan,
        text: text,
        extras: [
            { name: 'sp_probe/report.txt', buf: Buffer.from(text, 'utf8') },
            { name: 'sp_probe/fs-index.txt', buf: index },
        ],
    };
}

// ---------- Mac fallback: find tools/receive-dump.py on the uplink's subnet ----------

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
    const d = await prepare(ctx);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await upload(r.found, 'report-' + stamp + '.txt', (write) => write(Buffer.from(d.text, 'utf8')));
    ctx.ui.text('T_STATUS', 'Sending files to ' + r.found + '...');
    let sent = null;
    await upload(r.found, 'dump-' + stamp + '.tar', (write) => C.writeTar(new TarWriter(write), d.extras, d.plan, ROOT,
        (i, n) => ctx.ui.text('T_DETAIL', 'Sent ' + i + ' of ' + n + ' files')).then((x) => { sent = x; }));
    ctx.ui.text('T_DETAIL', 'Done. You can uninstall SB Probe now.');
    return 'Sent ' + sent.files + ' files to ' + r.found + ', ' + sent.skipped.length + ' skipped';
}

// ---------- GitHub upload ----------

function gzip(buf) {
    return new Promise((ok, no) => zlib.gzip(buf, { level: 6 }, (e, r) => (e ? no(e) : ok(r))));
}

/**
 * Collects the tar stream into parts of about PART_RAW bytes; each part is gzipped on the thread
 * pool and handed to send(n, gz). The parts are gzip members of one tar stream.
 */
class Parts {
    constructor(send) { this.send = send; this.chunks = []; this.size = 0; this.n = 0; this.raw = 0; this.gz = 0; }
    write(b) {
        this.chunks.push(b);
        this.size += b.length;
        return this.size >= PART_RAW ? this.flush() : Promise.resolve();
    }
    async flush() {
        if (!this.size) return;
        const raw = Buffer.concat(this.chunks, this.size);
        this.chunks = [];
        this.size = 0;
        const gz = await gzip(raw);
        this.n++;
        this.raw += raw.length;
        this.gz += gz.length;
        await this.send(this.n, gz);
    }
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
        const d = await prepare(ctx);
        const tag = 'dump-' + new Date().toISOString().replace(/[:.]/g, '-');
        const release = await github.createRelease(gh, token, tag,
            'Uploaded by SB Probe from the head unit. Put back together with: cat dump.tar.gz.* | tar xzf -');
        await github.uploadAsset(gh, token, release, 'report.txt', 'text/plain', Buffer.from(d.text, 'utf8'));
        let done = 0;
        const parts = new Parts(async (n, gz) => {
            const name = 'dump.tar.gz.' + ('00' + n).slice(-3);
            for (let attempt = 1; ; attempt++) {
                ctx.ui.text('T_STATUS', 'Uploading part ' + n + (attempt > 1 ? ' (try ' + attempt + ')' : '') + ', ' + Math.round(done / 1048576) + ' MB sent...');
                try {
                    await github.uploadAsset(gh, token, release, name, 'application/gzip', gz);
                    break;
                } catch (e) {
                    if (attempt >= 4) throw e;
                    ctx.log.warn('part ' + n + ' try ' + attempt + ': ' + errCode(e));
                    await github.deleteAsset(gh, token, release, name).catch(() => null);
                    await sleep(attempt * 3000);
                }
            }
            done += gz.length;
        });
        const r = await C.writeTar(new TarWriter((b) => parts.write(b)), d.extras, d.plan, ROOT,
            (i, n) => ctx.ui.text('T_DETAIL', 'Packed ' + i + ' of ' + n + ' files'));
        await parts.flush();
        ctx.ui.text('T_DETAIL', 'Done. ' + r.skipped.length + ' skipped. You can uninstall SB Probe now.');
        return 'Uploaded ' + r.files + ' files in ' + parts.n + ' parts (' + Math.round(parts.gz / 1048576) + ' MB) to release ' + tag;
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
