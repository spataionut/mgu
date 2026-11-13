'use strict';
// Service Book 0.5.0: mgf.js (MG Flasher's Custom Code over InternalTasu) against a stubbed DME,
// and the Custom Code page with live state. PNG frames go to $SB_SHOTS if set.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = path.join(__dirname, '..');
cp.execFileSync('python3', [path.join(root, 'kit/tools/build.py'), '--preview-only', 'sp_servicebook'], { cwd: root, stdio: 'ignore' });
const js = path.join(root, 'dist/sp_servicebook/source/javascript');
const { MgfLink, FEATURES, check } = require(path.join(js, 'mgf'));
const CC = require(path.join(js, 'customcode'));
const { Recorder, play } = require(path.join(js, 'kit/record'));
const { Canvas } = require(path.join(js, 'kit/canvas'));
const theme = require(path.join(js, 'kit/themes')).theme();
const shots = process.env.SB_SHOTS;
const hx = (b) => b.map((x) => (x < 16 ? '0' : '') + x.toString(16)).join('');

/* ---------- the guard ---------- */
const ok = (s, d) => assert.doesNotThrow(() => check(0x12, s, d), hx([s].concat(d)));
const no = (s, d, t) => assert.throws(() => check(t || 0x12, s, d), /mgf:/, hx([s].concat(d)));
ok(0x2E, [0x69, 0x45, 0x01, 0xAF]); ok(0x2E, [0x69, 0x47, 0x01, 0xB1]); ok(0x2E, [0x69, 0x49, 0x02, 0xB4]); ok(0x2E, [0x69, 0x4A, 0x00, 0xB3]);
ok(0x23, [0x44, 0x60, 0x10, 0x7F, 0x32, 0, 0, 0, 2]); ok(0x23, [0x44, 0x60, 0x10, 0x7F, 0x14, 0, 0, 0, 2]);
no(0x2E, [0x69, 0x45, 0x03, 0xB1]);           // map has slots 0-2
no(0x2E, [0x69, 0x47, 0x02, 0xB2]);           // cooling is 0/1
no(0x2E, [0x69, 0x46, 0x01, 0xB0]);           // burbles: not ours
no(0x2E, [0x69, 0x45, 0x01, 0xB0]);           // bad checksum
no(0x23, [0x44, 0x60, 0x10, 0x7F, 0x32, 0, 0, 1, 0]); no(0x31, [0x01, 0x02, 0x05, 0x01]); no(0x10, [0x03]); no(0x22, [0xF1, 0x90]);
no(0x2E, [0x69, 0x45, 0x01, 0xAF], 0x29);

/* ---------- a stubbed DME with MG Flasher's code ---------- */
function fakeDme(opts) {
    opts = opts || {};
    const ram = { map: 2, cooling: 0, flap: 2, valet: 0, last: opts.last || [0x49, 0x69] };
    const sent = [];
    const diag = {
        error: opts.error || null,
        async init() {},
        async physical(t, sid, data, ms, accept) {
            const u = [sid].concat(data);
            sent.push(u);
            await new Promise((r) => setTimeout(r, 1));
            let reply = null;
            if (sid === 0x2E) {
                const f = FEATURES.find((x) => x.id === data[1]);
                if (!opts.ignore) { ram[f.key] = data[2]; ram.last = [f.id, 0x69]; }
                reply = [0x7F, 0x2E, 0x69];
            } else if (sid === 0x23) {
                const a = (data[1] << 24 | data[2] << 16 | data[3] << 8 | data[4]) >>> 0;
                if (opts.silent) reply = null;
                else if (a === 0x60107F14) reply = [0x63].concat(ram.last);
                else {
                    const f = FEATURES.find((x) => x.addr === a);
                    const v = opts.garbage && f.key === 'flap' ? 0x37 : ram[f.key];
                    reply = [0x63, v].concat(f.len === 2 ? [0] : []);
                }
            }
            if (reply && accept && !accept(reply)) return null;
            return reply;
        },
    };
    return { diag, ram, sent };
}
const log = { info() {}, warn() {}, error() {} };
const open = () => ({ ok: true });

(async () => {
    // reads, then sets each feature; confirmed by read-back
    const d = fakeDme();
    let n = 0;
    const m = new MgfLink(() => d.diag, log, () => n++);
    assert.strictEqual(m.link, 'off');
    assert.ok(!(await m.set(0, 0, open)).ok, 'nothing before start');
    assert.strictEqual(d.sent.length, 0);
    await m.start();
    assert.strictEqual(m.link, 'ok', m.note);
    assert.deepStrictEqual(m.values, [2, 0, 2, 0]);
    let r = await m.set(0, 0, () => ({ ok: false, why: 'the car is moving' }));
    assert.ok(!r.ok && /moving/.test(r.text));
    assert.ok(!d.sent.some((u) => u[0] === 0x2E), 'gate closed: no write');
    for (const [i, v] of [[0, 0], [1, 1], [2, 1], [3, 1], [3, 0], [0, 1]]) {
        r = await m.set(i, v, open);
        assert.ok(r.ok, i + '=' + v + ': ' + r.text);
        assert.strictEqual(m.values[i], v);
    }
    assert.deepStrictEqual(d.sent.filter((u) => u[0] === 0x2E).slice(0, 1)[0], [0x2E, 0x69, 0x45, 0x00, 0xAE]);
    assert.ok(n > 0, 'redraws asked');

    // the DME doesn't take it: not confirmed
    const d2 = fakeDme({ ignore: true });
    const m2 = new MgfLink(() => d2.diag, log);
    await m2.start();
    r = await m2.set(0, 0, open);
    assert.ok(!r.ok && /not taken/.test(r.text), r.text);

    // a reading that isn't MG Flasher's (an update moved the addresses): info only, no write
    const d3 = fakeDme({ garbage: true });
    const m3 = new MgfLink(() => d3.diag, log);
    await m3.start();
    assert.strictEqual(m3.link, 'unknown');
    assert.ok(/flap reads 37/.test(m3.note), m3.note);
    r = await m3.set(0, 0, open);
    assert.ok(!r.ok && !d3.sent.some((u) => u[0] === 0x2E));

    // the DME just woke: no command since it started, last reads 00 00 (car, 2026-11-13). Usable, and a write confirms.
    const d6 = fakeDme({ last: [0, 0] });
    const m6 = new MgfLink(() => d6.diag, log);
    await m6.start();
    assert.strictEqual(m6.link, 'ok', m6.note);
    r = await m6.set(2, 1, open);
    assert.ok(r.ok, r.text);
    // ...but 00 00 with no write taken is still not a confirmation
    const d7 = fakeDme({ last: [0, 0], ignore: true });
    const m7 = new MgfLink(() => d7.diag, log);
    await m7.start();
    r = await m7.set(0, 0, open);
    assert.ok(!r.ok && /not taken: last 00 00/.test(r.text), r.text);
    // other last bytes stay unknown
    for (const b of [[0x49, 0x00], [0x00, 0x01], [0x37, 0x37]]) {
        const m8 = new MgfLink(() => fakeDme({ last: b }).diag, log);
        await m8.start();
        assert.strictEqual(m8.link, 'unknown', String(b));
    }

    // no answers at all; no diagnostic link
    const m4 = new MgfLink(() => fakeDme({ silent: true }).diag, log);
    await m4.start();
    assert.strictEqual(m4.link, 'none');
    const m5 = new MgfLink(() => fakeDme({ error: 'no proxy' }).diag, log);
    await m5.start();
    assert.ok(m5.link === 'none' && /no diagnostic link/.test(m5.note));

    /* ---------- the write gate (carstate.js): driving allowed, Valet only stopped in P (0.5.2) ---------- */
    const { CarState, FRESH_MS } = require(path.join(js, 'carstate'));
    let now = 1000;
    const cs = new CarState(() => now);
    assert.ok(!cs.gate(false).ok && /engine speed/.test(cs.gate(false).why), 'no rpm: no write');
    cs.rpm(200 * 4);                                   // 200 rpm: off
    assert.ok(!cs.gate(false).ok && /not running/.test(cs.gate(false).why));
    cs.rpm(800 * 4); cs.speed(90 / 0.015625); cs.stage('D');
    assert.ok(cs.gate(false).ok, 'driving at 90 km/h in D: map, cooling, flap may be set');
    assert.ok(!cs.gate(true).ok && /moving/.test(cs.gate(true).why), 'valet: not while moving');
    cs.speed(0);
    assert.ok(!cs.gate(true).ok && /selector in D/.test(cs.gate(true).why), 'valet: not in D');
    cs.stage('P');
    assert.ok(cs.gate(true).ok, 'valet: stopped in P');
    now += FRESH_MS + 1;
    assert.ok(!cs.gate(false).ok, 'stale rpm: no write');

    /* ---------- the page with live state ---------- */
    const st = CC.guideState();
    const taps = [];
    const draw = (s, name) => {
        const rec = new Recorder(1600, 520);
        rec.own = true;
        if (rec.clear) rec.clear(theme.bg);
        CC.drawGuide(rec, theme, Object.assign({ own: true }, s), st, () => {});
        require(path.join(js, 'kit/gauges')).frame(rec, theme, ['Service log', 'Car', 'Custom Code'], 2, []);
        if (shots) { const cv = new Canvas(1600, 520); play(rec.words(), cv); fs.writeFileSync(path.join(shots, name + '.png'), cv.png()); }
        rec.targets.forEach((q) => assert.ok(q.x >= 0 && q.x + q.w <= 1600 && q.y >= 46 && q.y + q.h <= 512, q.key + ' off the page'));
        return rec;
    };
    const live = { values: [2, 0, 2, 0] };
    let rec = draw({ live, onValue: (i, j) => taps.push([i, j]), status: 'Live from the DME (green dot = now). Tap a value twice to set it.' }, 'cc-live');
    rec.targets.find((q) => q.key === 'cc:0:0').run();
    assert.deepStrictEqual(taps, [[0, 0]]);
    assert.deepStrictEqual([st.feature, st.value], [0, 0]);
    draw({ live, armed: { i: 0, j: 0 }, onValue: () => {}, status: 'Tap Switchable Maps 100 RON again within 5 s to set it.', statusColor: '#ffffff' }, 'cc-armed');
    draw({ live: { values: [0, 0, 2, 0] }, onValue: () => {}, status: 'Switchable Maps 100 RON: confirmed by the DME.', statusColor: '#3fbf6f' }, 'cc-confirmed');
    draw({ status: 'MG Flasher\'s settings don\'t read as expected (flap reads 37). Info only: nothing is sent.', statusColor: '#ffb000' }, 'cc-unknown');
    console.log('servicebook mgf: ok (guard, start, set x6 confirmed, not taken, fresh DME 00 00, unknown build, no answer, page)');
})().catch((e) => { console.error(e); process.exit(1); });
