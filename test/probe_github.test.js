'use strict';
// End-to-end test of SB Probe's "Upload to GitHub" against test/fake_github.js:
// device sign-in (one pending poll), a release, report.txt and dump.tar as assets.
//   node test/probe_github.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const repo = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-gh-'));
const put = (p, body) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), body); };

put('etc/oap/someip/someip-interfaces.json', '{"interfaces":[]}');
put('var/opt/public/oap/oap_12204/source/javascript/app.js', 'x; openSpeller(); ' + 'y'.repeat(300000));
put('var/opt/public/oap/oap_12204/source/package.json', '{"name":"bmw_app"}');
put('var/opt/public/oap/oap_12204/data/notes.js', 'PERSONAL');
put('run/mgu-uplink/lease.json', JSON.stringify({ interface: 'wlan0', ip: '192.168.43.20', prefix: 24, router: '192.168.43.1', dns: ['192.168.43.1'] }));

const port = String(20000 + ((process.pid + 7) % 20000));
const out = path.join(root, 'assets');
fs.mkdirSync(out);
const fake = cp.spawn('node', [path.join(__dirname, 'fake_github.js'), port, out], { stdio: ['ignore', 'inherit', 'inherit'] });

const run = (cmd, args, env) => cp.execFileSync(cmd, args, { cwd: repo, env: Object.assign({}, process.env, env), encoding: 'utf8' });
let log;
try {
    run('python3', ['kit/tools/build.py', '--preview-only', 'sp_probe']);
    log = run('node', ['kit/tools/preview.js', 'dist/sp_probe', path.join(root, 'pv'), 'wait=1', 'BTN_GH', 'wait=8'], {
        SP_PROBE_ROOT: root, SP_PROBE_GH_CLIENT: 'test-client', SP_PROBE_GH_BASE: 'http://127.0.0.1:' + port,
    });
} finally {
    fake.kill();
}

const fakeLog = fs.readFileSync(path.join(out, 'requests.log'), 'utf8');
const reqs = fakeLog.trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.url);
assert.ok(/enter ABCD-1234/.test(log), 'code shown on screen:\n' + log);
assert.ok(/Uploaded \d+ files to GitHub, release dump-/.test(log), 'status shows the upload:\n' + log + '\n' + fakeLog);
assert.strictEqual(reqs.filter((r) => r.url === '/login/oauth/access_token').length, 2, 'polled until approved');
assert.ok(reqs.filter((r) => /releases/.test(r.url)).every((r) => r.auth), 'API calls carry the token');

const listing = run('tar', ['tf', path.join(out, 'dump.tar')]).trim().split('\n').sort();
assert.deepStrictEqual(listing, [
    'etc/oap/someip/someip-interfaces.json',
    'sp_probe/report.txt',
    'var/opt/public/oap/oap_12204/source/javascript/app.js',
    'var/opt/public/oap/oap_12204/source/package.json',
]);
const report = fs.readFileSync(path.join(out, 'report.txt'), 'utf8');
assert.ok(/\[speller\]/.test(report), 'speller search in report');
assert.ok(!/PERSONAL|ghu_faketoken/.test(report + fs.readFileSync(path.join(out, 'dump.tar'), 'latin1')), 'no app data and no token in the upload');

console.log('probe github ok: ' + listing.length + ' entries, ' + reqs.length + ' requests');
