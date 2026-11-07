'use strict';
// End-to-end test of SB Probe in the kit's stubbed head unit, against a fake unit tree:
// builds the preview, presses "Copy files to USB stick", and checks what lands on the fake stick.
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

const run = (cmd, args, env) => cp.execFileSync(cmd, args, { cwd: repo, env: Object.assign({}, process.env, env), encoding: 'utf8' });
run('python3', ['kit/tools/build.py', '--preview-only', 'sp_probe']);
const log = run('node', ['kit/tools/preview.js', 'dist/sp_probe', path.join(root, 'pv'), 'wait=1', 'BTN_USB', 'wait=4'], { SP_PROBE_ROOT: root });

assert.ok(/STICK: \d+ files/.test(log), 'status shows a successful copy:\n' + log);
const dir = path.join(root, 'media', 'STICK', 'sp_probe');
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
console.log('probe e2e ok: ' + listing.length + ' entries in ' + tarName);
