'use strict';
// Round-trip test for apps/sp_probe/probe_tar.js against the system tar.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { TarWriter, splitName } = require('../apps/sp_probe/probe_tar');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-tar-'));
const out = path.join(dir, 'a.tar');
const chunks = [];
const t = new TarWriter((b) => { chunks.push(Buffer.from(b)); return Promise.resolve(); });
const long = 'var/opt/public/oap/oap_12204/source/rhmiData/uiDescriptions/ID7/' + 'x'.repeat(60) + '/uiDescription.json';
const big = Buffer.alloc(70000, 7);
(async () => {
    assert.strictEqual(await t.add('/etc/oap/someip/someip-interfaces.json', Buffer.from('{"a":1}')), true);
    assert.strictEqual(await t.add(long, Buffer.from('long')), true);
    assert.strictEqual(await t.add('empty.txt', Buffer.alloc(0)), true);
    assert.strictEqual(await t.add('big.bin', big), true);
    assert.strictEqual(await t.add('y'.repeat(300), Buffer.from('no')), false);
    await t.finish();
    const buf = Buffer.concat(chunks);
    assert.strictEqual(buf.length, t.bytes);
    assert.strictEqual(buf.length % 512, 0);
    fs.writeFileSync(out, buf);
    cp.execFileSync('tar', ['xf', out, '-C', dir]);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'etc/oap/someip/someip-interfaces.json'), 'utf8'), '{"a":1}');
    assert.strictEqual(fs.readFileSync(path.join(dir, long), 'utf8'), 'long');
    assert.strictEqual(fs.statSync(path.join(dir, 'empty.txt')).size, 0);
    assert.ok(fs.readFileSync(path.join(dir, 'big.bin')).equals(big));
    assert.strictEqual(splitName('a'.repeat(101)), null);
    console.log('probe_tar ok (' + t.files + ' files, ' + buf.length + ' bytes)');
})().catch((e) => { console.error(e); process.exit(1); });
