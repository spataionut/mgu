'use strict';
// End-to-end test of SB Probe's "Upload to GitHub" against test/fake_github.js:
// device sign-in (one pending poll), a release, report.txt and the dump as gzip parts,
// one part failing once and going up again on the retry.
//   node test/probe_github.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { makeUnit, checkDump } = require('./fake_unit');

const repo = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-gh-'));
makeUnit(root, { bigApp: true, lease: { interface: 'wlan0', ip: '192.168.43.20', prefix: 24, router: '192.168.43.1', dns: ['192.168.43.1'] } });

const port = String(20000 + ((process.pid + 7) % 20000));
const out = path.join(root, 'assets');
fs.mkdirSync(out);
const fake = cp.spawn('node', [path.join(__dirname, 'fake_github.js'), port, out], { stdio: ['ignore', 'inherit', 'inherit'] });

const run = (cmd, args, env) => cp.execFileSync(cmd, args, { cwd: repo, env: Object.assign({}, process.env, env), encoding: 'utf8' });
let log;
try {
    run('python3', ['kit/tools/build.py', '--preview-only', 'sp_probe']);
    log = run('node', ['kit/tools/preview.js', 'dist/sp_probe', path.join(root, 'pv'), 'wait=1', 'BTN_GH', 'wait=12'], {
        SP_PROBE_ROOT: root, SP_PROBE_GH_CLIENT: 'test-client', SP_PROBE_GH_BASE: 'http://127.0.0.1:' + port,
        SP_PROBE_PART_MB: '0.05',
    });
} finally {
    fake.kill();
}

const reqs = fs.readFileSync(path.join(out, 'requests.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.url);
assert.ok(/enter ABCD-1234/.test(log), 'code shown on screen:\n' + log);
const m = /Uploaded \d+ files in (\d+) parts/.exec(log);
assert.ok(m, 'status shows the upload:\n' + log);
const nParts = Number(m[1]);
assert.ok(nParts >= 2, 'the dump went up in several parts: ' + nParts);
assert.strictEqual(reqs.filter((r) => r.url === '/login/oauth/access_token').length, 2, 'polled until approved');
assert.ok(reqs.filter((r) => /releases/.test(r.url)).every((r) => r.auth), 'API calls carry the token');
assert.strictEqual(reqs.filter((r) => /name=dump\.tar\.gz\.002$/.test(r.url)).length, 2, 'part 2 retried once after a 502');
assert.ok(reqs.some((r) => r.method === 'GET' && /\/releases\/7\/assets/.test(r.url)), 'retry looked for a broken asset first');

const parts = fs.readdirSync(out).filter((n) => /^dump\.tar\.gz\.\d{3}$/.test(n)).sort();
assert.strictEqual(parts.length, nParts, 'every part arrived');
const x = path.join(root, 'x');
fs.mkdirSync(x);
const whole = path.join(root, 'whole.tar.gz');
fs.writeFileSync(whole, Buffer.concat(parts.map((p) => fs.readFileSync(path.join(out, p)))));
run('tar', ['xzf', whole, '-C', x]);
const entries = run('tar', ['tzf', whole]).trim().split('\n');
checkDump(assert, entries, (e) => fs.readFileSync(path.join(x, e), 'latin1'));
assert.ok(fs.readFileSync(path.join(out, 'report.txt'), 'utf8').indexOf('SB Probe report') === 0, 'report.txt asset');
assert.ok(!/ghu_faketoken/.test(fs.readFileSync(whole, 'latin1') + fs.readFileSync(path.join(out, 'report.txt'), 'utf8')), 'no token in the upload');
console.log('probe github ok: ' + entries.length + ' entries in ' + nParts + ' parts, ' + reqs.length + ' requests');
