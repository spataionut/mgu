'use strict';
// Service Book milestone 1: keyboard, form and store, run from the built preview package
// (python3 kit/tools/build.py --preview-only sp_servicebook). PNG frames go to $SB_SHOTS if set.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const root = path.join(__dirname, '..');
cp.execFileSync('python3', [path.join(root, 'kit/tools/build.py'), '--preview-only', 'sp_servicebook'], { cwd: root, stdio: 'ignore' });
const js = path.join(root, 'dist/sp_servicebook/source/javascript');
const { keyboardSheet } = require(path.join(js, 'keyboard'));
const { formSheet, addDays } = require(path.join(js, 'form'));
const { LogStore, KEEP } = require(path.join(js, 'store'));
const { Recorder, play } = require(path.join(js, 'kit/record'));
const { Canvas } = require(path.join(js, 'kit/canvas'));
const themes = require(path.join(js, 'kit/themes'));
const theme = themes.theme();
const shots = process.env.SB_SHOTS;

function frame(sheet, name) {
    const r = new Recorder(1600, 520);
    const targets = sheet.draw(r, theme);
    if (shots) {
        const cv = new Canvas(1600, 520);
        play(r.words(), cv);
        fs.writeFileSync(path.join(shots, name + '.png'), cv.png());
    }
    return targets;
}
const tap = (sheet, key) => {
    const tg = frame(sheet, 'x').find((q) => q.key === key);
    assert.ok(tg, 'no target ' + key);
    for (const q of [tg]) { assert.ok(q.x >= 0 && q.x + q.w <= 1600 && q.y >= 46 && q.y + q.h <= 512, key + ' off the sheet'); }
    return tg.act();
};
const type = (kb, s) => s.split('').forEach((c) => tap(kb, c === ' ' ? 'space' : 'c:' + c));

/* ---------- keyboard ---------- */
{
    let done = null;
    const kb = keyboardSheet({ title: 'Notes', onDone: (v) => { done = v; return 'close'; } });
    const ts = frame(kb, 'keyboard-text');
    assert.strictEqual(ts.length, 11 + 11 + 11 + 4);
    // keys don't overlap
    ts.forEach((a, i) => ts.slice(i + 1).forEach((b) => assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, a.key + '/' + b.key)));
    assert.strictEqual(kb.shift, 1, 'auto capital on an empty field');
    type(kb, 'oil change');
    assert.strictEqual(kb.value, 'Oil change');
    tap(kb, 'back'); tap(kb, 'back');
    tap(kb, 'mode'); assert.strictEqual(kb.page, 'symbols');
    frame(kb, 'keyboard-symbols');
    tap(kb, 'c:€'); tap(kb, 'c:1');
    tap(kb, 'mode');
    assert.strictEqual(tap(kb, 'done'), 'close');
    assert.strictEqual(done, 'Oil chan€1');
    // caps lock: two quick taps
    const k2 = keyboardSheet({ value: 'x' });
    tap(k2, 'shift'); tap(k2, 'shift'); type(k2, 'ab'); assert.strictEqual(k2.value, 'xAB');
    // knob: move, row change, press
    const k3 = keyboardSheet({ autoCap: false });
    frame(k3, 'x');
    k3.move(2); assert.strictEqual(k3.press(), null); assert.strictEqual(k3.value, 'e');
    assert.strictEqual(k3.top(), true);
    assert.strictEqual(k3.tilt('N'), false, 'top row: up goes to the header');
    assert.strictEqual(k3.tilt('S'), true); assert.strictEqual(k3.top(), false);
    k3.press(); assert.strictEqual(k3.value, 'ed');
    frame(k3, 'keyboard-knob');
    let cancelled = false;
    const k4 = keyboardSheet({ onCancel: () => { cancelled = true; return 'close'; } });
    assert.strictEqual(k4.back(), 'close'); assert.ok(cancelled);
    // max length
    const k5 = keyboardSheet({ maxLen: 3, autoCap: false }); type(k5, 'abcd'); assert.strictEqual(k5.value, 'abc');
    // number pad
    let km = null;
    const n = keyboardSheet({ mode: 'number', value: '0', onDone: (v) => { km = v; return 'close'; } });
    const nt = frame(n, 'keyboard-number');
    assert.ok(!nt.find((q) => q.key === 'c:.'), 'no decimal point unless asked');
    type(n, '27083'); tap(n, 'done'); assert.strictEqual(km, '27083');
    // long text: the field still draws
    const k6 = keyboardSheet({ value: 'x'.repeat(190) }); frame(k6, 'keyboard-long');
}

/* ---------- store ---------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-store-'));
{
    const s = new LogStore(dir); s.load();
    assert.deepStrictEqual(s.entries, []);
    const a = s.save({ date: '2026-03-01', km: 20000, type: 'Oil & filter', notes: 'Castrol 0W-30' });
    s.save({ date: '2026-11-08', km: 27083, type: 'Brakes', notes: 'front pads' });
    s.save(Object.assign({}, a, { cost: '180 €' }));
    const again = new LogStore(dir); again.load();
    assert.deepStrictEqual(again.entries.map((e) => e.type), ['Brakes', 'Oil & filter'], 'newest first');
    assert.strictEqual(again.entries[1].cost, '180 €');
    assert.ok(!fs.readdirSync(dir).some((f) => f.indexOf('.tmp') >= 0), 'no temp files left');
    // backups: one per write after the first, at most KEEP
    for (let i = 0; i < KEEP + 5; i++) again.save({ date: '2026-01-01', km: i, type: 'Other' });
    assert.strictEqual(fs.readdirSync(path.join(dir, 'backups')).length, KEEP);
    assert.throws(() => again.save({ date: 'yesterday', type: 'Other' }));
    assert.strictEqual(again.entries.length, KEEP + 7);
    // a damaged main file: kept aside, newest backup restored
    fs.writeFileSync(path.join(dir, 'servicebook.json'), '{"schema":1,"entries":[');
    const fixed = new LogStore(dir); fixed.load();
    assert.ok(/damaged/.test(fixed.warning), fixed.warning);
    assert.strictEqual(fixed.entries.length, KEEP + 6);
    assert.ok(fs.readdirSync(dir).some((f) => /\.corrupt-/.test(f)));
    // main file missing (stopped mid-write): from the backup
    fs.unlinkSync(path.join(dir, 'servicebook.json'));
    const back = new LogStore(dir); back.load();
    assert.ok(back.entries.length > 0 && /backup/.test(back.warning));
    assert.ok(fixed.remove(fixed.entries[0].id));
}

/* ---------- form ---------- */
{
    const sd = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-form-'));
    const s = new LogStore(sd); s.load();
    let shown = null;
    const open = (sh) => { shown = sh; return true; };
    const f = formSheet({ odometer: () => 27083, open, onSave: (e) => s.save(e), onDelete: (id) => s.remove(id) });
    shown = f;
    frame(f, 'form-add');
    assert.strictEqual(f.e.km, '27083', 'km from the odometer');
    assert.strictEqual(tap(f, 'save'), null, 'no type: not saved');
    assert.ok(/type/.test(f.error));
    tap(f, 'type:Brakes');
    tap(f, 'notes'); assert.notStrictEqual(shown, f, 'keyboard opened');
    const kb = shown; type(kb, 'front pads'); assert.strictEqual(tap(kb, 'done'), null); assert.strictEqual(shown, f, 'back on the form');
    assert.strictEqual(f.e.notes, 'Front pads');
    tap(f, 'km'); const nk = shown; tap(nk, 'clear'); type(nk, '27100'); tap(nk, 'done');
    assert.strictEqual(f.e.km, '27100');
    tap(f, 'date-');
    frame(f, 'form-filled');
    assert.strictEqual(tap(f, 'save'), 'close');
    assert.strictEqual(s.entries.length, 1);
    assert.strictEqual(s.entries[0].km, 27100);
    assert.strictEqual(s.entries[0].date, addDays(require(path.join(js, 'form')).today(), -1));
    // edit + two-tap delete
    const ed = formSheet({ entry: s.entries[0], odometer: () => 27200, open, onSave: (e) => s.save(e), onDelete: (id) => s.remove(id) });
    assert.strictEqual(ed.e.km, '27100', 'editing keeps the stored km');
    frame(ed, 'form-edit');
    assert.strictEqual(tap(ed, 'delete'), null); assert.strictEqual(s.entries.length, 1);
    assert.strictEqual(tap(ed, 'delete'), 'close'); assert.strictEqual(s.entries.length, 0);
    // knob through the form
    const kf = formSheet({ odometer: () => null, open, onSave: () => {}, onDelete: () => {} });
    frame(kf, 'x'); kf.move(1); kf.press(); assert.strictEqual(kf.e.type, 'Brakes');
    assert.strictEqual(kf.e.km, '', 'no odometer: empty km');
    // a failing disk: the form stays open with the error
    const bad = formSheet({ entry: { type: 'Other' }, open, onSave: () => { throw new Error('EROFS'); } });
    assert.strictEqual(tap(bad, 'save'), null); assert.ok(/EROFS/.test(bad.error));
    frame(bad, 'form-error');
}
console.log('servicebook: ok');
