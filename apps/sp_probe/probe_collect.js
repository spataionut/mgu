'use strict';
/**
 * What SB Probe takes from the head unit, Node 8.
 *
 * Contents (in this order, up to MAX_TOTAL):
 *   0. identity: the SOME/IP catalog, OS/kernel/CPU/memory, mounts, passwd/group (no shadow),
 *      the OAP app uid map, systemd units of the app platform
 *   1. text and code: /etc/oap, the OAP platform (MainApp), every installed app's source/ and rhmiData*
 *   2. media from the same trees (images, fonts, sounds)
 * Never: any app's data/ folder, USB sticks, /proc beyond the files above, files that look like
 * keys, certificates or provisioning (by name or by a PRIVATE KEY block); those are listed in
 * skipped.txt with the reason, by name only.
 *
 * Index: fs-index.txt lists names, modes, owners and sizes of the whole filesystem (no contents),
 * without /proc, /sys, /dev, /media, /mnt and the apps' data folders.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const readFile = util.promisify(fs.readFile);
const readdir = util.promisify(fs.readdir);
const lstat = util.promisify(fs.lstat);
const tick = () => new Promise((r) => setImmediate(r));

const MAX_FILE = 48 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
const INDEX_MAX = 200000;
const MEDIA = /\.(png|jpe?g|gif|bmp|webp|svg|ico|ttf|otf|woff2?|ogg|wav|mp3|aac|m4a|mp4|bin|dat)$/i;
const SECRET_NAME = /\.(pem|key|p12|pfx|jks|keystore|der|crt|cer|csr|p8)$|private|secret|provision|shadow|credential|^\.?netrc$/i;
const SECRET_BODY = /PRIVATE KEY-----|BEGIN OPENSSH|BEGIN PGP PRIVATE/;
const GREP = [
    { term: /speller/ig, max: 40, ctx: 240 },
    { term: /editRoll/g, max: 10, ctx: 240 },
    { term: /dropDownMenu/g, max: 4, ctx: 700 },     // finds the RHMI component type table
    { term: /['"]input['"]/g, max: 15, ctx: 200 },
    { term: /CorruptAppsHandler/g, max: 10, ctx: 400 },
];

function errCode(e) { return (e && (e.code || e.message)) || String(e); }

function paths(root) {
    const oap = root + '/var/opt/public/oap';
    return { root: root, oap: oap, mainapp: root + '/usr/lib/oap-mainapp' };
}

/** Walk dir; visit(file, st) for regular files; never follows symlinks; skip(p, name) prunes. */
async function walk(dir, depth, visit, skip) {
    if (depth < 0) return;
    let names;
    try { names = await readdir(dir); } catch (e) { return; }
    names.sort();
    for (const n of names) {
        const p = path.join(dir, n);
        if (skip && skip(p, n)) continue;
        let st;
        try { st = await lstat(p); } catch (e) { continue; }
        if (st.isDirectory()) await walk(p, depth - 1, visit, skip);
        else if (st.isFile()) await visit(p, st);
    }
    await tick();
}

/** Under .../oap/oap_<uid>/ only source/ and rhmiData*: never an app's data. */
function onlyAppSources(P) {
    return (p, n) => {
        const rel = path.relative(P.oap, p).split(path.sep);
        return rel.length === 2 && !(n === 'source' || n.indexOf('rhmiData') === 0);
    };
}

/**
 * The files to take, in order. Resolves { files: [{ p, size, mtime }], skipped: [[path, why]], total }.
 * progress(n) is called now and then with the number of files seen.
 */
async function collect(root, progress) {
    const P = paths(root);
    const seen = {};
    const tiers = [[], [], []];
    const skipped = [];
    let count = 0;
    const take = (tier) => async (p, st) => {
        if (seen[p]) return;
        seen[p] = true;
        if (++count % 500 === 0 && progress) progress(count);
        if (SECRET_NAME.test(path.basename(p))) { skipped.push([p, 'looks like key material']); return; }
        if (st.size > MAX_FILE) { skipped.push([p, 'larger than ' + (MAX_FILE >> 20) + ' MB']); return; }
        tiers[tier === 1 && MEDIA.test(p) ? 2 : tier].push({ p: p, size: st.size, mtime: st.mtime.getTime() / 1000 });
    };
    const one = async (p, tier) => {
        let st;
        try { st = await lstat(p); } catch (e) { return; }
        if (st.isFile()) await take(tier)(p, st);
    };

    // 0: identity
    await one(root + '/etc/oap/someip/someip-interfaces.json', 0);
    for (const f of ['/etc/os-release', '/etc/hostname', '/etc/passwd', '/etc/group', '/proc/version', '/proc/cpuinfo',
        '/proc/meminfo', '/proc/mounts', '/proc/cmdline']) await one(root + f, 0);
    await one(P.oap + '/oap_12201/security/uids.txt', 0);
    await walk(root + '/etc', 0, async (p, st) => { if (/version|release|build/i.test(path.basename(p))) await take(0)(p, st); });
    const unit = /oap|mgu|someip|hmi|mainapp/i;
    for (const d of ['/lib/systemd/system', '/etc/systemd/system', '/usr/lib/systemd/system']) {
        await walk(root + d, 1, async (p, st) => { if (unit.test(path.basename(p))) await take(0)(p, st); });
    }
    // 1 and 2: text and code first, media last
    await walk(root + '/etc/oap', 10, take(1));
    await walk(P.mainapp, 16, take(1));
    await walk(P.oap, 14, take(1), onlyAppSources(P));

    const files = [];
    let total = 0;
    for (const t of tiers) {
        for (const f of t) {
            if (total + f.size > MAX_TOTAL) { skipped.push([f.p, 'over the ' + (MAX_TOTAL >> 20) + ' MB total']); continue; }
            total += f.size;
            files.push(f);
        }
    }
    return { files: files, skipped: skipped, total: total, tiers: tiers.map((t) => t.length) };
}

/** Names, modes, owners and sizes of the filesystem, without contents. Resolves a Buffer. */
async function buildIndex(root, progress) {
    const P = paths(root);
    const base = root || '/';
    const prune = {};
    ['/proc', '/sys', '/dev', '/media', '/mnt', '/run/user'].forEach((d) => { prune[path.join(base, d)] = true; });
    const lines = ['# mode uid:gid size path [-> link]   (no /proc /sys /dev /media /mnt, no apps\' data folders)'];
    let n = 0, cut = false;
    async function go(dir, depth) {
        if (depth < 0 || cut) return;
        let names;
        try { names = await readdir(dir); } catch (e) { lines.push('! ' + errCode(e) + ' ' + dir.slice(root.length)); return; }
        names.sort();
        for (const name of names) {
            const p = path.join(dir, name);
            if (prune[p]) continue;
            const rel = path.relative(P.oap, p).split(path.sep);
            if (rel.length === 2 && rel[0] !== '..' && name === 'data') { lines.push('# skipped app data ' + p.slice(root.length)); continue; }
            let st;
            try { st = await lstat(p); } catch (e) { continue; }
            if (++n > INDEX_MAX) { cut = true; lines.push('# cut at ' + INDEX_MAX + ' entries'); return; }
            let link = '';
            if (st.isSymbolicLink()) { try { link = ' -> ' + fs.readlinkSync(p); } catch (e) { link = ' -> ?'; } }
            lines.push((st.mode & 0o177777).toString(8) + ' ' + st.uid + ':' + st.gid + ' ' + st.size + ' ' + p.slice(root.length) + link);
            if (n % 2000 === 0) { if (progress) progress(n); await tick(); }
            if (st.isDirectory()) await go(p, depth - 1);
        }
    }
    await go(base, 24);
    return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

function runtimeFacts() {
    const out = [];
    const safe = (label, fn) => { try { out.push(label + ': ' + fn()); } catch (e) { out.push(label + ': ' + errCode(e)); } };
    safe('uid/gid', () => process.getuid() + '/' + process.getgid() + ' groups ' + process.getgroups().join(','));
    safe('node versions', () => JSON.stringify(process.versions));
    safe('node config', () => JSON.stringify(process.config));
    safe('os', () => [os.type(), os.release(), os.arch(), os.cpus().length + ' cpus', Math.round(os.totalmem() / 1048576) + ' MB'].join(', '));
    safe('env names', () => Object.keys(process.env).sort().join(' '));
    safe('cwd', () => process.cwd());
    safe('execArgv', () => JSON.stringify(process.execArgv));
    return out;
}

async function jsFiles(root) {
    const P = paths(root);
    const out = [];
    const pickJs = (p, st) => { if (/\.js$/.test(p) && st.size < MAX_FILE) out.push(p); };
    await walk(P.mainapp, 8, pickJs);
    let apps = [];
    try { apps = await readdir(P.oap); } catch (e) { /* none */ }
    for (const a of apps) await walk(path.join(P.oap, a, 'source', 'javascript'), 0, pickJs);
    return out.slice(0, 600);
}

/** Where the platform's javascript mentions the things milestone 1 needs. */
async function grepReport(root, lines) {
    const files = await jsFiles(root);
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
                lines.push('[' + g.term.source + '] ' + f.slice(root.length) + ' @' + m.index + ': ' + s.slice(a, b).replace(/\s+/g, ' '));
            }
        }
        await tick();
    }
}

/**
 * Writes extras ([{ name, buf }]) first, then each file, then sp_probe/skipped.txt.
 * Resolves { files, skipped } (skipped: [[path, why]] including plan.skipped).
 */
async function writeTar(tar, extras, plan, root, progress) {
    const skipped = plan.skipped.slice();
    for (const x of extras) await tar.add(x.name, x.buf);
    let i = 0;
    for (const f of plan.files) {
        let data;
        try { data = await readFile(f.p); } catch (e) { skipped.push([f.p, 'unreadable: ' + errCode(e)]); continue; }
        if (data.length <= 4 * 1024 * 1024 && SECRET_BODY.test(data.toString('latin1'))) {
            skipped.push([f.p, 'contains a private key block']);
            continue;
        }
        if (!(await tar.add(f.p.slice(root.length), data, f.mtime))) skipped.push([f.p, 'path too long for tar']);
        data = null;
        if (++i % 100 === 0 && progress) progress(i, plan.files.length);
        await tick();
    }
    const list = skipped.map((s) => s[1] + '\t' + s[0].slice(root.length)).join('\n') + '\n';
    await tar.add('sp_probe/skipped.txt', Buffer.from(list, 'utf8'));
    await tar.finish();
    return { files: tar.files, skipped: skipped };
}

module.exports = { collect, buildIndex, runtimeFacts, grepReport, writeTar, errCode, MEDIA, SECRET_NAME };
