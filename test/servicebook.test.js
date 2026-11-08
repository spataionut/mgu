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
/* ---------- 0.2.0: dates ---------- */
const D = require(path.join(js, 'dates'));
assert.strictEqual(D.addMonths('2026-01-31', 1), '2026-02-28');
assert.strictEqual(D.addMonths('2026-11-15', 12), '2027-11-15');
assert.strictEqual(D.daysBetween('2026-11-08', '2027-01-14'), 67);
const { checkDate } = require(path.join(js, 'keyboard'));
assert.strictEqual(checkDate('2027-02-29'), 'Not a date');
assert.strictEqual(checkDate('2028-02-29'), '');

/* ---------- date keyboard ---------- */
{
    let got = null;
    const kb = keyboardSheet({ mode: 'date', value: '2026-11-08', onDone: (v) => { got = v; return 'close'; } });
    assert.strictEqual(kb.value, '20261108');
    tap(kb, 'clear'); type(kb, '202702'); frame(kb, 'keyboard-date');
    assert.strictEqual(tap(kb, 'done'), null, 'incomplete date: stays open'); assert.ok(kb.error);
    type(kb, '30'); assert.strictEqual(tap(kb, 'done'), null); assert.strictEqual(kb.error, 'Not a date');
    tap(kb, 'back'); tap(kb, 'back'); type(kb, '28'); assert.strictEqual(tap(kb, 'done'), 'close'); assert.strictEqual(got, '2027-02-28');
}

/* ---------- documents ---------- */
const DK = require(path.join(js, 'docs'));
assert.strictEqual(DK.status(null).state, 'none');
assert.strictEqual(DK.status({ until: '2026-11-20' }, '2026-11-08').state, 'soon');
assert.strictEqual(DK.status({ until: '2027-11-20' }, '2026-11-08').state, 'ok');
assert.deepStrictEqual(DK.status({ until: '2026-11-07' }, '2026-11-08'), { state: 'expired', days: -1, text: 'Expired yesterday' });
assert.strictEqual(DK.endFor('2026-01-15', ['12 months', 12]), '2027-01-14');
assert.strictEqual(DK.endFor('2026-01-15', ['7 days', 0, 7]), '2026-01-21');
{
    const cd = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-car-'));
    const s = new LogStore(cd); s.load();
    // a 0.1.0 file (no car) loads, and gets the car section on the next write
    s.save({ date: '2026-01-01', type: 'Other' });
    const raw = JSON.parse(fs.readFileSync(path.join(cd, 'servicebook.json'), 'utf8')); delete raw.car;
    fs.writeFileSync(path.join(cd, 'servicebook.json'), JSON.stringify(raw));
    s.load(); assert.deepStrictEqual(s.car.docs.rca, []);
    let shown = null;
    const open = (sh) => { shown = sh; return true; };
    const onSave = (p, isNew) => { s.saveDoc('rca', p); saved.push(isNew); };
    const saved = [];
    const f = DK.docSheet({ kind: 'rca', open, onSave, onDelete: (id) => s.removeDoc('rca', id) });
    shown = f;
    frame(f, 'doc-new');
    assert.strictEqual(tap(f, 'save'), null); assert.ok(/until/.test(f.error));
    tap(f, 'from'); tap(shown, 'clear'); type(shown, '20260115'); tap(shown, 'done'); assert.strictEqual(shown, f);
    tap(f, 'len:12 months'); assert.strictEqual(f.e.until, '2027-01-14');
    tap(f, 'who'); type(shown, 'groupama'); tap(shown, 'done');
    tap(f, 'number'); tap(shown, 'mode'); type(shown, '123'); tap(shown, 'mode'); tap(shown, 'done');
    frame(f, 'doc-filled');
    assert.strictEqual(tap(f, 'save'), 'close');
    assert.strictEqual(s.current('rca').who, 'Groupama'); assert.strictEqual(s.current('rca').number, '123');
    // renew: starts the day after; the new one is current, the old one kept
    const rn = DK.docSheet({ kind: 'rca', renewFrom: D.addDays(s.current('rca').until, 1), open, onSave, onDelete() {} });
    tap(rn, 'len:12 months'); tap(rn, 'save');
    assert.strictEqual(s.current('rca').from, '2027-01-15'); assert.strictEqual(s.current('rca').until, '2028-01-14');
    assert.strictEqual(s.car.docs.rca.length, 2); assert.deepStrictEqual(saved, [true, true]);
    // from after until: refused
    const bad = DK.docSheet({ kind: 'casco', period: { from: '2026-05-01', until: '2026-04-01' }, open, onSave() {}, onDelete() {} });
    assert.strictEqual(tap(bad, 'save'), null); assert.ok(/after/.test(bad.error));
    assert.throws(() => s.saveDoc('casco', { from: '2026-05-01', until: '2026-04-01' }));
    // ITP asks km (odometer), no number; rovinieta: no "who"
    const itp = DK.docSheet({ kind: 'itp', odometer: () => 27083, open, onSave() {}, onDelete() {} });
    const it = frame(itp, 'doc-itp').map((q) => q.key);
    assert.ok(it.indexOf('km') >= 0 && it.indexOf('odo') >= 0 && it.indexOf('number') < 0); assert.strictEqual(itp.e.km, '27083');
    const rv = frame(DK.docSheet({ kind: 'rovinieta', open, onSave() {}, onDelete() {} }), 'doc-rovinieta').map((q) => q.key);
    assert.ok(rv.indexOf('who') < 0 && rv.indexOf('len:7 days') >= 0);
    // reload keeps it all; delete
    const again = new LogStore(cd); again.load();
    assert.strictEqual(again.car.docs.rca.length, 2);
    again.setVariant('M40i'); assert.strictEqual(new LogStore(cd).load() && JSON.parse(fs.readFileSync(path.join(cd, 'servicebook.json'))).car.variant, 'M40i');
    assert.ok(again.removeDoc('rca', again.current('rca').id)); assert.strictEqual(again.current('rca').from, '2026-01-15');
}

/* ---------- the Car page ---------- */
{
    const C = require(path.join(js, 'car'));
    assert.strictEqual(C.seriesOf('G01'), 'G01'); assert.strictEqual(C.seriesOf(81), 'G01'); assert.strictEqual(C.seriesOf('KEINE_ANGABE'), null);
    assert.strictEqual(C.bodyText('SPORTS_ACTIVITY_VEHICLE'), 'Sports Activity Vehicle');
    assert.strictEqual(C.modelName('G01', 'M40i'), 'BMW X3 M40i');
    assert.strictEqual(C.vinOf({ VIN: 'wbatestvin0000000' }), 'WBATESTVIN0000000'); assert.strictEqual(C.vinOf({}), '');
    const docs = {
        rca: { from: '2026-01-15', until: '2027-01-14', who: 'Groupama', number: 'RO123' },
        casco: { from: '2025-11-20', until: '2026-11-19', who: 'Allianz-Tiriac' },
        rovinieta: { until: '2026-11-01', number: '' },
        itp: null,
    };
    const draw = (own, name) => {
        const r = new Recorder(1600, 520);
        r.clear(theme.bg);
        const hits = [];
        C.drawCar(r, theme, { series: 'G01', body: 'Sports Activity Vehicle', variant: 'M40i', vin: 'WBA00000000TEST00', odo: 27083, odoState: 'ok', docs, own, today: '2026-11-08' },
            { variant: () => hits.push('variant'), doc: (k) => hits.push(k) });
        if (shots) { const cv = new Canvas(1600, 520); play(r.words(), cv); fs.writeFileSync(path.join(shots, name + '.png'), cv.png()); }
        return { r, hits };
    };
    const d = draw(true, 'car-page');
    const keys = d.r.targets.map((q) => q.key);
    ['variant', 'doc:rca', 'doc:casco', 'doc:rovinieta', 'doc:itp'].forEach((k) => assert.ok(keys.indexOf(k) >= 0, k));
    d.r.targets.forEach((q) => q.run()); assert.deepStrictEqual(d.hits, ['variant', 'rca', 'casco', 'rovinieta', 'itp']);
    assert.strictEqual(draw(false, 'car-page-readonly').r.targets.length, 0, 'software path: no taps');
}
/* ---------- the Custom Code guide ---------- */
{
    const CC = require(path.join(js, 'customcode'));
    assert.deepStrictEqual(CC.FEATURES.map((f) => f[0] + ':' + f[1]), ['1:Switchable Maps', '3:Max Cooling', '6:Exhaust Flap', '7:Valet Mode']);
    assert.deepStrictEqual(CC.FEATURES[0][2].map((v) => v[0] + ':' + v[1]), ['0:100 RON', '1:95 RON', '2:Stock']);
    assert.deepStrictEqual(CC.FEATURES[2][2], [[0, 'Automatic'], [1, 'Closed'], [2, 'Opened']]);
    assert.strictEqual(CC.angleOf(0), 200); assert.strictEqual(CC.angleOf(8), -40);
    const st = CC.guideState();
    let n = 0;
    const draw = (own, name) => {
        const r = new Recorder(1600, 520);
        r.clear(theme.bg);
        CC.drawGuide(r, theme, { own }, st, () => n++);
        const G = require(path.join(js, 'kit/gauges'));
        G.frame(r, theme, ['Service log', 'Car', 'Custom Code'], 2, []);
        if (shots) { const cv = new Canvas(1600, 520); play(r.words(), cv); fs.writeFileSync(path.join(shots, name + '.png'), cv.png()); }
        return r;
    };
    const r = draw(true, 'guide');
    r.targets.forEach((q) => assert.ok(q.x >= 0 && q.x + q.w <= 1600 && q.y >= 46 && q.y + q.h <= 512, q.key + ' off the page'));
    r.targets.find((q) => q.key === 'cc:2:2').run();
    assert.deepStrictEqual([st.feature, st.value, n], [2, 2, 1]);
    draw(true, 'guide-flap-opened');
    r.targets.find((q) => q.key === 'cc:0:1').run();
    draw(true, 'guide-map-95');
    r.targets.find((q) => q.key === 'cc:3').run();
    assert.deepStrictEqual([st.feature, st.value], [3, null]);
    assert.strictEqual(draw(false, 'guide-readonly').targets.length, 0);
}
console.log('servicebook: ok');
