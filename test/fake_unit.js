'use strict';
// A fake head-unit tree for the SB Probe tests, with the things the dump must take, and the
// things it must leave out (app data, USB sticks, key material).
const fs = require('fs');
const path = require('path');

const OAP = 'var/opt/public/oap';

function makeUnit(root, extra) {
    const put = (p, body) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), body); };
    // taken
    put('etc/oap/someip/someip-interfaces.json', '{"interfaces":[]}');
    put('etc/oap/permissions/app.json', '{"perm":1}');
    put('etc/os-release', 'NAME=test\n');
    put('etc/sw-version.txt', 'MGU_22w99\n');
    put('etc/passwd', 'root:x:0:0::/root:/bin/sh\n');
    put('proc/version', 'Linux test\n');
    put('proc/cpuinfo', 'processor: 0\n');
    put('proc/mounts', '/dev/sda1 /media/STICK vfat ro,relatime 0 0\nproc /proc proc rw 0 0\n');
    put('lib/systemd/system/oapcontroller.service', '[Service]\n');
    put('usr/lib/oap-mainapp/javascript/main.js', 'mainapp SpellerInput here; class CorruptAppsHandler {}');
    put('usr/lib/oap-mainapp/rhmiData/uiDescriptions/ID7/uiDescription.json', '{"containers":{}}');
    put('usr/lib/oap-mainapp/images/bg.png', 'PNGDATA');
    put(OAP + '/oap_12204/source/javascript/app.js', 'x; types = {dropDownMenu: 1, editRoll: 2}; openSpeller(); ' + (extra && extra.bigApp ? 'y'.repeat(300000) : 'y'));
    put(OAP + '/oap_12204/source/package.json', '{"name":"bmw_app"}');
    put(OAP + '/oap_12204/source/rhmiData/uiDescriptions/ID7/application.xml', '<application/>');
    put(OAP + '/oap_12204/rhmiData/application.json', '{}');
    put(OAP + '/oap_12201/security/uids.txt', 'bmw_app 12204\n');
    // indexed by name only
    put('usr/bin/node', 'ELF');
    put('lib/systemd/system/sshd.service', '[Service]\n');
    // never taken
    put('etc/oap/certs/client.key', 'KEYDATA');
    put('etc/oap/config/inner.conf', '-----BEGIN RSA PRIVATE KEY-----\nabc\n');
    put(OAP + '/oap_12204/data/notes.js', 'PERSONAL speller in app data');
    put(OAP + '/oap_12204/data/secret/rhmiData/application.json', 'PERSONAL');
    put(OAP + '/oap_12201/security/app.p12', 'KEYDATA');
    put('media/STICK/holiday.jpg', 'PERSONAL');
    put('run/mgu-uplink/lease.json', JSON.stringify(extra && extra.lease || { interface: 'vethuplink', ip: '127.0.0.5', prefix: 29, router: '127.0.0.1', dns: [] }));
}

// Every file the dump must hold (without sp_probe/*), and the order rule: media last.
const EXPECTED = [
    'etc/oap/someip/someip-interfaces.json',
    'etc/oap/permissions/app.json',
    'etc/os-release',
    'etc/sw-version.txt',
    'etc/passwd',
    'proc/version',
    'proc/cpuinfo',
    'proc/mounts',
    'lib/systemd/system/oapcontroller.service',
    'usr/lib/oap-mainapp/javascript/main.js',
    'usr/lib/oap-mainapp/rhmiData/uiDescriptions/ID7/uiDescription.json',
    'usr/lib/oap-mainapp/images/bg.png',
    OAP + '/oap_12204/source/javascript/app.js',
    OAP + '/oap_12204/source/package.json',
    OAP + '/oap_12204/source/rhmiData/uiDescriptions/ID7/application.xml',
    OAP + '/oap_12204/rhmiData/application.json',
    OAP + '/oap_12201/security/uids.txt',
];

/** Checks a dump's entry list, its report, index and skipped list. */
function checkDump(assert, entries, read) {
    const files = entries.filter((e) => e.indexOf('sp_probe/') !== 0);
    assert.deepStrictEqual(files.slice().sort(), EXPECTED.slice().sort(), 'dump holds exactly the expected files');
    assert.strictEqual(entries[0], 'sp_probe/report.txt', 'report first');
    assert.strictEqual(entries[1], 'sp_probe/fs-index.txt', 'index second');
    assert.strictEqual(entries[entries.length - 1], 'sp_probe/skipped.txt', 'skipped list last');
    assert.strictEqual(files[files.length - 1], 'usr/lib/oap-mainapp/images/bg.png', 'media after text and code');
    assert.strictEqual(files[0], 'etc/oap/someip/someip-interfaces.json', 'catalog first');

    const report = read('sp_probe/report.txt');
    assert.ok(/\[speller\] .*oap-mainapp\/javascript\/main\.js/.test(report), 'speller found in MainApp js');
    assert.ok(/\[CorruptAppsHandler\]/.test(report), 'CorruptAppsHandler found');
    assert.ok(/node versions: \{/.test(report), 'runtime facts');
    assert.ok(/uplink lease: \{/.test(report), 'uplink lease recorded');
    assert.ok(/media\/STICK: no/.test(report) || /media\/STICK: yes/.test(report), 'stick write test recorded');

    const index = read('sp_probe/fs-index.txt');
    assert.ok(/ \/usr\/bin\/node$/m.test(index), 'index lists files not in the dump');
    assert.ok(/ \/lib\/systemd\/system\/sshd\.service$/m.test(index), 'index lists other units');
    assert.ok(/# skipped app data \/var\/opt\/public\/oap\/oap_12204\/data/.test(index), 'index notes app data skipped');
    assert.ok(!/holiday|notes\.js|\/proc\//.test(index), 'index leaves out sticks, app data and /proc');

    const skipped = read('sp_probe/skipped.txt');
    assert.ok(/looks like key material\t\/etc\/oap\/certs\/client\.key/.test(skipped), 'key file skipped by name');
    assert.ok(/contains a private key block\t\/etc\/oap\/config\/inner\.conf/.test(skipped), 'key block skipped by content');

    const all = entries.map(read).join('\n');
    assert.ok(!/PERSONAL|KEYDATA|BEGIN RSA PRIVATE/.test(all), 'no app data, stick files or keys anywhere in the dump');
}

module.exports = { makeUnit, checkDump, EXPECTED };
