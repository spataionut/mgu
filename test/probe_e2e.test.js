'use strict';
// End-to-end test of SB Probe's Mac fallback in the kit's stubbed head unit, against a fake unit tree:
// builds the preview, runs tools/receive-dump.py on localhost, presses "Send files to Mac",
// and checks what the receiver got.
//   node test/probe_e2e.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { makeUnit, checkDump } = require('./fake_unit');

const repo = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-e2e-'));
makeUnit(root);
// The uplink: the receiver is the "router" (127.0.0.1); .2-.6 have nobody and must not block the send.
fs.mkdirSync(path.join(root, 'proc', 'net'), { recursive: true });
fs.writeFileSync(path.join(root, 'proc/net/arp'), 'IP address HW type Flags HW address Mask Device\n127.0.0.3 0x1 0x2 aa:bb:cc:dd:ee:ff * vethuplink\n');

const port = String(20000 + (process.pid % 20000));
const dir = path.join(root, 'received');
const receiver = cp.spawn('python3', ['-I', path.join(repo, 'tools', 'receive-dump.py'), '--out', dir, '--port', port, '--once'], { stdio: ['ignore', 'ignore', 'inherit'] });

const run = (cmd, args, env) => cp.execFileSync(cmd, args, { cwd: repo, env: Object.assign({}, process.env, env), encoding: 'utf8' });
let log;
try {
    run('python3', ['kit/tools/build.py', '--preview-only', 'sp_probe']);
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'dist', 'sp_probe', 'source', 'package.json'), 'utf8'));
    assert.strictEqual(pkg.mguInternet, true, 'built package.json asks mgu-store for the uplink');
    log = run('node', ['kit/tools/preview.js', 'dist/sp_probe', path.join(root, 'pv'), 'wait=1', 'BTN_SEND', 'wait=8'],
        { SP_PROBE_ROOT: root, SP_PROBE_PORT: port });
} finally {
    receiver.kill();
}

assert.ok(/Sent \d+ files to 127\.0\.0\.1/.test(log), 'status shows a successful send:\n' + log);
const names = fs.readdirSync(dir);
const tarName = names.find((n) => /^dump-.*\.tar$/.test(n));
assert.ok(tarName, 'dump tar received: ' + names);
assert.ok(names.some((n) => /^report-.*\.txt$/.test(n)), 'report received');
assert.ok(!names.some((n) => /\.part$/.test(n)), 'no partial file left');

const x = path.join(root, 'x');
fs.mkdirSync(x);
run('tar', ['xf', path.join(dir, tarName), '-C', x]);
const entries = run('tar', ['tf', path.join(dir, tarName)]).trim().split('\n');
checkDump(assert, entries, (e) => fs.readFileSync(path.join(x, e), 'latin1'));
console.log('probe e2e ok: ' + entries.length + ' entries in ' + tarName);
