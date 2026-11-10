'use strict';
// MGF Read Test: the read-only guard and a full pass against a stubbed InternalTasu.
const assert = require('assert');
const path = require('path');
const cp = require('child_process');

const root = path.join(__dirname, '..');
cp.execFileSync('python3', [path.join(root, 'kit/tools/build.py'), '--preview-only', 'sp_mgfread'], { cwd: root, stdio: 'ignore' });
const js = path.join(root, 'dist/sp_mgfread/source/javascript');
const { Reader, check, READS } = require(path.join(js, 'reader'));
const { Diag } = require(path.join(js, 'kit/diag'));
const { CarState } = require(path.join(js, 'carstate'));

/* ---------- the guard ---------- */
const ok = (t, s, d) => assert.doesNotThrow(() => check(t, s, d), JSON.stringify([t, s, d]));
const no = (t, s, d) => assert.throws(() => check(t, s, d), /read-only/, JSON.stringify([t, s, d]));
ok(0x12, 0x22, [0xF1, 0x50]);
ok(0x12, 0x23, [0x44, 0x60, 0x10, 0x7F, 0x32, 0, 0, 0, 2]);
ok(0x12, 0x2E, [0x69, 0x45, 0x00, 0xAE]);                 // 0.2.0: the map to slot 0
ok(0x12, 0x2E, [0x69, 0x45, 0x02, 0xB0]);                 //        and to slot 2
no(0x12, 0x2E, [0x69, 0x45, 0x01, 0xAF]);                 // slot 1 isn't part of the test
no(0x12, 0x2E, [0x69, 0x45, 0x02, 0xB1]);                 // a wrong checksum
no(0x12, 0x2E, [0x69, 0x47, 0x01, 0xB1]);                 // Max Cooling
no(0x12, 0x2E, [0x69, 0x49, 0x02, 0xB4]);                 // the flap
no(0x12, 0x2E, [0x69, 0x4A, 0x01, 0xB4]);                 // valet
no(0x29, 0x2E, [0x69, 0x45, 0x00, 0xAE]);                 // the right bytes to another unit
no(0x12, 0x31, [0x01, 0x02, 0x05, 0x01]);                 // its identification routine
no(0x12, 0x10, [0x03]); no(0x12, 0x2F, [0x60, 0xFD, 0x00]); no(0x12, 0x3E, [0x00]);
no(0x12, 0x23, [0x44, 0x60, 0x10, 0x7F, 0x32, 0, 0, 0, 0x40]);   // a fixed address, but longer
no(0x12, 0x23, [0x44, 0x60, 0x10, 0x00, 0x00, 0, 0, 0, 2]);      // another address
no(0x12, 0x22, [0xF1, 0x90]);                             // the VIN: not needed
no(0xDF, 0x22, [0xF1, 0x50]); no(0x29, 0x22, [0xF1, 0x50]);

/* ---------- a pass against a stubbed transport ---------- */
const sent = [];
function fakeSignals(replies) {
    let onResp = null;
    return {
        proxy: async () => ({}),
        on: async (p, name, fn) => { if (name === 'sendTasuResponse') onResp = fn; },
        onAvailable: async (p, fn) => fn(true),
        call: async (p, m, req) => {
            assert.strictEqual(m, 'sendTasuRequest');
            const uds = [req.serviceID].concat(Array.from(req.udsData));
            sent.push(uds);
            const key = uds.map((b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
            const r = replies[key];
            if (r) setTimeout(() => onResp({ errorCode: 'NO_ERROR', udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, req.targetAddress, 0, 0].concat(r)) }), 5);
            return { TasuErrorEnum: 'NO_ERROR' };
        },
    };
}
const log = { info() {}, warn() {}, error() {} };
(async () => {
    const diag = new Diag(fakeSignals({
        '22f150': [0x62, 0xF1, 0x50, 0x00, 0x00, 0x0F, 0x26, 0xE8],
        '234460107f3200000002': [0x63, 0x01, 0x00],
        '234460107f9800000001': [0x7F, 0x23, 0x31],
        '234460107f6f00000001': [0x63, 0x02],
        '234460107fc700000001': [0x63, 0x00],
        '234460107f6400000001': [0x63, 0x01],
        // 7F14 gets no answer: shown as such
    }), log);
    await diag.init();
    const steps = [];
    const out = await new Reader(diag, log).readAll((k) => steps.push(k));
    assert.deepStrictEqual(steps, ['ident'].concat(READS.map((r) => r.key)));
    assert.ok(out.ident.ok && /SGBD index/.test(out.ident.text), out.ident.text);
    assert.strictEqual(out.map.text, 'slot 1 · 95 RON');
    assert.ok(!out.cooling.ok && /NRC 31/.test(out.cooling.text));
    assert.strictEqual(out.flap.text, 'opened');
    assert.strictEqual(out.valet.text, 'off');
    assert.strictEqual(out.ack.text, '1');
    assert.ok(!out.last.ok && out.last.text === 'no answer');
    // nothing but reads left the head unit
    assert.ok(sent.every((u) => u[0] === 0x22 || u[0] === 0x23), 'only reads sent');
    assert.strictEqual(sent.length, 1 + READS.length);

    /* ---------- the map write ---------- */
    sent.length = 0;
    const state = { map: [0x63, 0x02, 0x00], last: [0x63, 0x49, 0x69] };
    const replies2 = {};
    const diag2 = new Diag(fakeSignals(new Proxy(replies2, {
        get: (o, k) => {
            if (k === '2e694500ae') { state.map = [0x63, 0x00, 0x00]; state.last = [0x63, 0x45, 0x69]; return [0x7F, 0x2E, 0x69]; }
            if (k === '234460107f3200000002') return state.map;
            if (k === '234460107f1400000002') return state.last;
            return undefined;
        },
    })), log);
    await diag2.init();
    const rd = new Reader(diag2, log);
    let r = await rd.setMap(0, () => ({ ok: false, why: 'the car is moving' }));
    assert.ok(!r.sent && /moving/.test(r.steps[0]) && sent.length === 0, 'gate closed: nothing sent');
    r = await rd.setMap(1, () => ({ ok: true }));
    assert.ok(!r.sent && sent.length === 0, 'slot 1 refused');
    r = await rd.setMap(0, () => ({ ok: true }));
    assert.ok(r.sent && r.confirmed, JSON.stringify(r.steps));
    assert.deepStrictEqual(sent[0], [0x2E, 0x69, 0x45, 0x00, 0xAE]);
    assert.ok(/expected/.test(r.steps[0]) && /taken/.test(r.steps[1]) && /slot 0/.test(r.steps[2]), r.steps.join(' | '));
    // the DME takes nothing: last id stays the flap, map stays 2 -> sent, not confirmed
    state.map = [0x63, 0x02, 0x00]; state.last = [0x63, 0x49, 0x69];
    replies2.dummy = 1;
    const diag3 = new Diag(fakeSignals({ '2e694502b0': [0x7F, 0x2E, 0x69], '234460107f1400000002': [0x63, 0x49, 0x69], '234460107f3200000002': [0x63, 0x00, 0x00] }), log);
    await diag3.init();
    r = await new Reader(diag3, log).setMap(2, () => ({ ok: true }));
    assert.ok(r.sent && !r.confirmed, 'not confirmed when the DME did not take it');

    /* ---------- the car gate ---------- */
    let now = 1000;
    const cs = new CarState(() => now);
    assert.ok(!cs.gate().ok && /speed/.test(cs.gate().why), 'no signals: closed');
    cs.speed(0); cs.rpm(750 * 4);
    assert.ok(cs.gate().ok, cs.gate().why);
    cs.stage('D'); assert.ok(!cs.gate().ok && /D/.test(cs.gate().why), 'D: closed');
    cs.selection('P'); assert.ok(cs.gate().ok, 'P: open');
    cs.speed(5 * 64); assert.ok(!cs.gate().ok && /moving/.test(cs.gate().why), 'moving: closed');
    cs.speed(0); cs.rpm(0); assert.ok(!cs.gate().ok && /engine/.test(cs.gate().why), 'engine off: closed');
    cs.rpm(3000); now += 4000; assert.ok(!cs.gate().ok, 'stale signals: closed');
    cs.speed(65535); assert.ok(!cs.gate().ok, 'no value: closed');

    console.log('mgfread: map write ok (gate, slot 1 refused, confirmation, not-confirmed case, car gate)');
    console.log('mgfread: ok (' + (1 + READS.length) + ' reads, guard refuses writes, routines, sessions and other addresses)');
})().catch((e) => { console.error(e); process.exit(1); });
