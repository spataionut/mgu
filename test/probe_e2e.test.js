'use strict';
// End-to-end test of SB Probe in the kit's stubbed head unit, against a fake unit tree:
// builds the preview, runs tools/receive-dump.py on localhost, presses "Send files to Mac",
// and checks what the receiver got.
//   node test/probe_e2e.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const repo = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-e2e-'));
const put = (p, body) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), body); };

put('etc/oap/someip/someip-interfaces.json', '{"interfaces":[]}');
put('var/opt/public/oap/oap_12204/source/javascript/app.js', 'x; types = {dropDownMenu: 1, editRoll: 2}; openSpeller(); y');
put('var/opt/public/oap/oap_12204/source/package.json', '{"name":"bmw_app"}');
put('var/opt/public/oap/oap_12204/source/rhmiData/uiDescriptions/ID7/application.xml', '<application/>');
put('var/opt/public/oap/oap_12204/rhmiData/application.json', '{}');
put('var/opt/public/oap/oap_12204/data/secret/rhmiData/application.json', 'PERSONAL');
put('var/opt/public/oap/oap_12204/data/notes.js', 'speller in app data');
put('usr/lib/oap-mainapp/rhmiData/uiDescriptions/ID7/uiDescription.json', '{"containers":{}}');
put('usr/lib/oap-mainapp/javascript/main.js', 'mainapp SpellerInput here');
fs.mkdirSync(path.join(root, 'media', 'STICK'), { recursive: true });
put('proc/mounts', '/dev/sda1 /media/STICK vfat rw,relatime 0 0\nproc /proc proc rw 0 0\n');
// The uplink: the receiver is the "router" (127.0.0.1); .2-.6 have nobody and must not block the send.
put('run/mgu-uplink/lease.json', JSON.stringify({ interface: 'vethuplink', ip: '127.0.0.5', prefix: 29, router: '127.0.0.1', dns: [] }));
put('proc/net/arp', 'IP address HW type Flags HW address Mask Device\n127.0.0.3 0x1 0x2 aa:bb:cc:dd:ee:ff * vethuplink\n');

const port = String(20000 + (process.pid % 20000));
const dir = path.join(root, 'received');
const receiver = cp.spawn('python3', ['-I', path.join(repo, 'tools', 'receive-dump.py'), '--out', dir, '--port', port, '--once'], { stdio: ['ignore', 'pipe', 'inherit'] });
let rxLog = '';
receiver.stdout.on('data', (d) => { rxLog += d; });

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

assert.ok(/Sent \d+ files to 127\.0\.0\.1/.test(log), 'status shows a successful send:\n' + log + '\nreceiver:\n' + rxLog);
const names = fs.readdirSync(dir);
const tarName = names.find((n) => /^dump-.*\.tar$/.test(n));
assert.ok(tarName, 'dump tar on stick: ' + names);
assert.ok(names.some((n) => /^report-.*\.txt$/.test(n)), 'report on stick');
assert.ok(!names.some((n) => /\.part$/.test(n)), 'no partial file left');

const listing = run('tar', ['tf', path.join(dir, tarName)]).trim().split('\n').sort();
assert.deepStrictEqual(listing, [
    'etc/oap/someip/someip-interfaces.json',
    'sp_probe/report.txt',
    'usr/lib/oap-mainapp/rhmiData/uiDescriptions/ID7/uiDescription.json',
    'var/opt/public/oap/oap_12204/rhmiData/application.json',
    'var/opt/public/oap/oap_12204/source/javascript/app.js',
    'var/opt/public/oap/oap_12204/source/package.json',
    'var/opt/public/oap/oap_12204/source/rhmiData/uiDescriptions/ID7/application.xml',
]);
const report = fs.readFileSync(path.join(dir, names.find((n) => /^report-/.test(n))), 'utf8');
assert.ok(/\[speller\] .*oap-mainapp\/javascript\/main\.js/.test(report), 'speller found in MainApp js');
assert.ok(/\[speller\] .*oap_12204\/source\/javascript\/app\.js/.test(report), 'speller found in BMW app js');
assert.ok(/\[editRoll\]/.test(report) && /\[dropDownMenu\]/.test(report), 'component table terms found');
assert.ok(!/PERSONAL|speller in app data|\/data\//.test(report), 'nothing from app data folders');
assert.ok(/media\/STICK: yes/.test(report), 'stick write test recorded');
assert.ok(/uplink lease: \{"interface":"vethuplink"/.test(report), 'uplink lease recorded');
console.log('probe e2e ok: ' + listing.length + ' entries in ' + tarName);
