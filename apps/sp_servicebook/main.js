'use strict';
/**
 * Service Book: the log list, Add / Edit with the app's own keyboard, the odometer (milestone 1);
 * the Car page: model, VIN, total km, RCA / CASCO / Rovinieta / ITP (0.2.0, car.js, docs.js);
 * the Custom Code page: a guide to MG Flasher's Custom Code menu, reference only (0.3.0, customcode.js);
 * USB import of history and documents from servicebook-import.json on a stick (0.4.0, importer.js);
 * the Custom Code page reads MG Flasher's settings from the DME and sets them, tapped twice, only
 * with the car stopped and the engine running, each confirmed by reading it back (0.5.0, mgf.js,
 * carstate.js). Nothing goes to the DME until that page is opened.
 *
 * The page (1600 x 520, the kit runs the screen on mgu-render): the header, the odometer and an
 * "Add entry" button, then the entries newest first; a row opens it for editing. Add / Edit and
 * the keyboard are sheets (form.js, keyboard.js), which need the GPU renderer; on the software
 * path the page says so and the list is read-only.
 *
 * Data: store.js (atomic writes, rolling backups) in ctx.dataDir. Every handler is wrapped: an
 * exception is logged and shown, never thrown out of a handler (the kit exits on an uncaught one).
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { LogStore } = require('./store');
const { cardSheet } = require('./kit/sheet');
const { formSheet, kmText } = require('./form');
const { docSheet, KINDS, status } = require('./docs');
const { drawCar, seriesOf, bodyText, vinOf } = require('./car');
const { drawGuide, guideState, FEATURES: CC } = require('./customcode');
const { MgfLink, FEATURES: MGF } = require('./mgf');
/* Valet Mode cuts power at once: set only stopped in P. The others also while driving (0.5.2). */
const parkedOnly = (i) => !!MGF[i] && MGF[i].key === 'valet';
const { CarState } = require('./carstate');
const { Diag } = require('./kit/diag');
const { today, addDays } = require('./dates');
const importer = require('./importer');
const path = require('path');

const W = 1600, H = 520;
const KOMBI = 'de.bmw.infotainment.KombiIF';
const VEHICLE = 'de.bmw.infrastructure.VehicleInformation';
const ARM_MS = 5000, REFRESH_MS = 5000, RESULT_MS = 10000;
const PAGES = ['Service log', 'Car', 'Custom Code'];
const LIST_Y = 128, ROW_H = 70, ROW_GAP = 8;

function fit(cv, s, size, w, font) {
    s = String(s == null ? '' : s);
    const o = { literal: true, font };
    if (cv.textWidth(s, size, o) <= w) return s;
    while (s.length > 1 && cv.textWidth(s + '...', size, o) > w) s = s.slice(0, -1);
    return s + '...';
}

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        let version = 0, odo = null, odoState = 'waiting', msg = '', msgAt = 0, page = 0;
        let series = null, body = '';
        const vin = vinOf(process.env);
        const guide = guideState();
        const scroll = { y: 0, max: 0 };
        const changed = () => { version++; };
        const show = (s) => { msg = s; msgAt = Date.now(); changed(); };
        const safe = (name, fn) => function () {
            try { return fn.apply(null, arguments); } catch (e) { log.error(name, e); show(name + ': ' + (e && e.message || e)); return null; }
        };

        const store = new LogStore(ctx.dataDir, log);
        try { store.load(); if (store.warning) show(store.warning); } catch (e) { log.error('load', e); show('Could not read the log: ' + e.message); }

        /* ---------- the odometer ---------- */
        ctx.signals.watch(KOMBI, '1', {
            statusRangeTankStatus: safe('odometer', (v) => {
                const km = v && v.mileageKilometre;
                if (typeof km === 'number' && km >= 0) { odo = km; odoState = 'ok'; } else odoState = 'no mileage';
                changed();
            }),
        }, log).then((sub) => { if (sub && sub.error) { odoState = 'unavailable'; log.warn('odometer: ' + sub.error); changed(); } })
            .catch((e) => { odoState = 'error'; log.error('odometer', e); changed(); });

        /* ---------- series and body: notifier only, so they come when the car sends them;
         * the selector for the Custom Code gate on the same proxy (0.5.0) ---------- */
        const carState = new CarState();
        const carH = carState.handlers();
        ctx.signals.watch(VEHICLE, '1', Object.assign({
            VehicleType: safe('vehicle type', (v) => {
                const s2 = seriesOf(v && v.typeVehicle), b = bodyText(v && v.typeBody);
                if (s2 !== series || b !== body) { series = s2; body = b; changed(); }
            }),
        }, carH[VEHICLE]), log, { pollMs: 1000 }).then((sub) => { if (sub && sub.error) log.warn('vehicle type: ' + sub.error); carState.status.VehicleInformation = sub; })
            .catch((e) => log.error('vehicle type', e));
        // speed and engine speed for the gate: a stopped car doesn't send its speed again, so the
        // getters are polled every second (seen with MGF Test 0.2.0 / 0.2.1)
        Object.keys(carH).filter((i) => i !== VEHICLE).forEach((iface) => {
            ctx.signals.watch(iface, '1', carH[iface], log, { pollMs: 1000 })
                .then((sub) => { if (sub && sub.error) log.warn(iface + ': ' + sub.error); carState.status[iface.split('.').pop()] = sub; })
                .catch((e) => log.error(iface, e));
        });

        /* ---------- MG Flasher's Custom Code settings (0.5.0) ---------- */
        const mgf = new MgfLink(() => new Diag(ctx.signals, log), log, changed);
        let armed = null, visible = true;
        const valueName = (i, j) => CC[i][1] + ' ' + CC[i][2][j][1];
        const onValue = safe('custom code', (i, j) => {
            if (mgf.link !== 'ok' || mgf.busy) return;
            if (mgf.values[i] === j) { armed = null; return; }            // already set
            const g = carState.gate(parkedOnly(i));
            if (!g.ok) { armed = null; mgf.result = { i, v: j, ok: false, text: 'not now: ' + g.why, at: Date.now() }; return; }
            if (!armed || armed.i !== i || armed.j !== j || Date.now() > armed.until) {
                armed = { i, j, until: Date.now() + ARM_MS };
                setTimeout(changed, ARM_MS + 100);
                return;
            }
            armed = null;
            mgf.set(i, j, () => carState.gate(parkedOnly(i))).catch((e) => log.error('mgf set', e));
        });
        function mgfStatus(t) {
            const r = mgf.result && Date.now() - mgf.result.at < RESULT_MS ? mgf.result : null;
            if (mgf.link === 'off' || mgf.link === 'starting') return ['Reading MG Flasher\'s settings from the DME...', t.dim];
            if (mgf.link === 'none') return ['Can\'t reach MG Flasher\'s settings (' + mgf.note + '). Info only.', t.warn || '#ffb000'];
            if (mgf.link === 'unknown') return ['MG Flasher\'s settings don\'t read as expected (' + mgf.note + '). Info only: nothing is sent.', t.warn || '#ffb000'];
            if (r && r.ok === null) return ['Setting ' + valueName(r.i, r.v) + '...', t.text];
            if (r) return [(r.ok ? valueName(r.i, r.v) + ': confirmed by the DME.' : valueName(r.i, r.v) + ': ' + r.text), r.ok ? '#3fbf6f' : '#ef2b2d'];
            if (armed && Date.now() <= armed.until) return ['Tap ' + valueName(armed.i, armed.j) + ' again within 5 s to set it.', t.text];
            const g = carState.gate(false), gp = carState.gate(true);
            if (!g.ok) return ['Live from the DME (green dot = now). Setting needs the engine running: ' + g.why + '.', t.dim];
            return gp.ok ? ['Live from the DME (green dot = now). Tap a value twice to set it.', t.dim]
                : ['Live from the DME (green dot = now). Tap a value twice to set it. Valet only stopped in P.', t.dim];
        }
        setInterval(() => {
            try {
                if (page !== 2 || !visible) return;
                if (mgf.link === 'off') { mgf.start().catch((e) => log.error('mgf start', e)); return; }
                if (!mgf.busy && !(armed && Date.now() <= armed.until) && Date.now() - mgf.readAt >= REFRESH_MS) mgf.refresh().catch((e) => log.error('mgf refresh', e));
                changed();                    // the status line follows the car's state
            } catch (e) { log.error('mgf tick', e); }
        }, 1000);

        /* ---------- add / edit ---------- */
        const open = (sh) => { try { return !!ctx.sheet(sh); } catch (e) { log.error('sheet', e); return false; } };
        const edit = safe('edit', (entry) => {
            const f = formSheet({
                entry, odometer: () => odo, open,
                onSave: (e) => { const s = store.save(e); show('Saved: ' + s.type + ', ' + s.date); },
                onDelete: (id) => { store.remove(id); show('Deleted'); },
                onClose: changed,
            });
            if (!open(f)) show('Typing needs the GPU renderer (mgu-render)');
        });
        ui.onClick('BTN_ADD', safe('add', () => edit(null)));

        /* ---------- import from a USB stick ---------- */
        const startImport = safe('import', () => {
            const f = importer.find();
            let sh;
            if (!f.files.length) {
                sh = cardSheet({
                    title: 'Import', heading: 'No import file found', color: '#ffb000',
                    subtitle: 'Put ' + importer.NAME + ' at the top of the stick, plug it in, then Try again',
                    note: f.tried.length ? f.tried.map((x) => path.basename(x.dir) + ': ' + x.result).join('   ·   ') : 'No USB stick found under /media',
                    actions: [{ label: 'Try again', primary: true, run: () => { startImport(); return null; } }],
                });
            } else {
                const file = f.files[0];
                let p = null, error = '';
                try { p = importer.plan(importer.read(file), store); } catch (e) { error = e.code ? e.code + ': ' + e.message : e.message; }
                if (error || !p.ok) {
                    log.warn('import: ' + (error || p.errors.join('; ')));
                    sh = cardSheet({
                        title: 'Import', heading: 'Import file has problems', color: '#ef2b2d',
                        subtitle: error ? 'Could not read ' + importer.NAME + '. Nothing was imported.'
                            : (p.errors.length === 1 ? '1 problem' : p.errors.length + ' problems, the first below') + '. Nothing was imported.',
                        note: error || p.errors[0],
                    });
                } else if (p.empty) {
                    sh = cardSheet({ title: 'Import', heading: 'Nothing new to import', subtitle: 'All ' + p.skipped + ' items are already in the log', color: '#3fbf6f' });
                } else {
                    sh = cardSheet({
                        title: 'Import', heading: 'Import from USB', subtitle: path.basename(path.dirname(file)) + ' / ' + path.basename(file),
                        rows: [['New entries', String(p.counts.entries)], ['Document periods', String(p.counts.periods)], ['Already in the log', String(p.skipped)], ['Model variant', p.variant || '--']],
                        note: 'Only adds; nothing is replaced. The log is backed up first.',
                        actions: [{
                            label: 'Import', primary: true, run: () => {
                                try {
                                    const c = store.applyImport(p);
                                    show('Imported ' + c.entries + (c.entries === 1 ? ' entry' : ' entries') + ' and ' + c.periods + ' document period' + (c.periods === 1 ? '' : 's'));
                                } catch (e) { log.error('import', e); show('Import failed: ' + (e && e.message || e)); }
                                return 'close';
                            },
                        }],
                    });
                }
            }
            sh.onClose = changed;
            if (!open(sh)) show('Import needs the GPU renderer (mgu-render)');
        });
        ctx.hideButton('BTN_ADD');

        /* ---------- the Car page ---------- */
        const { keyboardSheet } = require('./keyboard');
        const editVariant = safe('variant', () => {
            const kb = keyboardSheet({
                title: 'Model variant (e.g. M40i)', value: store.car.variant, maxLen: 30, autoCap: false,
                onDone: (v) => { store.setVariant(v); show(v ? 'Model: ' + v : 'Variant cleared'); return 'close'; },
                onCancel: () => 'close',
            });
            kb.onClose = changed;
            if (!open(kb)) show('Typing needs the GPU renderer (mgu-render)');
        });
        const docForm = (kind, period, renewFrom) => {
            const K = KINDS[kind];
            return docSheet({
                kind, period, renewFrom, odometer: () => odo, open, onClose: changed,
                onSave: (p, isNew) => {
                    const saved = store.saveDoc(kind, p);
                    // a new ITP is an inspection: it goes in the log too
                    if (isNew && kind === 'itp') store.save({ date: saved.from || today(), km: saved.km, type: 'Inspection', workshop: saved.who, cost: saved.cost, notes: 'ITP, valid until ' + saved.until });
                    show(K.label + ' saved: valid until ' + saved.until);
                },
                onDelete: (id) => { store.removeDoc(kind, id); show(K.label + ' period deleted'); },
            });
        };
        const openDoc = safe('document', (kind) => {
            const K = KINDS[kind], cur = store.current(kind);
            let sh;
            if (!cur) sh = docForm(kind, null, null);
            else {
                const st = status(cur);
                const earlier = store.car.docs[kind].length - 1;
                sh = cardSheet({
                    title: K.label, heading: K.label, subtitle: st.text, color: st.state === 'ok' ? '#3fbf6f' : st.state === 'soon' ? null : '#ef2b2d',
                    rows: [['Valid from', cur.from || '--'], ['Valid until', cur.until], [K.who || K.number || 'Cost', (K.who ? cur.who : K.number ? cur.number : cur.cost) || '--'],
                        K.km ? ['Km', cur.km != null ? kmText(cur.km) : '--'] : ['Cost', cur.cost || '--']],
                    note: earlier ? earlier + ' earlier period' + (earlier > 1 ? 's' : '') + ' kept' : '',
                    actions: [
                        { label: 'Edit', run: () => { open(docForm(kind, cur, null)); return null; } },
                        { label: 'Renew', primary: true, run: () => { open(docForm(kind, null, addDays(cur.until, 1))); return null; } },
                    ],
                });
                sh.onClose = changed;
            }
            if (!open(sh)) show('Typing needs the GPU renderer (mgu-render)');
        });
        const setPage = (i) => { if (i !== page && i >= 0 && i < PAGES.length) { page = i; changed(); } };
        ctx.onTab(safe('tab', (i) => setPage(i)));
        ui.onClick('BTN_PAGE', safe('page', () => setPage((page + 1) % PAGES.length)));
        ctx.hideButton('BTN_PAGE');

        ctx.onScroll(safe('scroll', (dy) => {
            if (page !== 0) return false;
            const y = Math.max(0, Math.min(scroll.max, scroll.y + dy)), moved = y !== scroll.y;
            scroll.y = y;
            if (moved) changed();
            return moved;
        }));
        ctx.onLayout(changed);

        /* ---------- the page ---------- */
        let drawn = -1;
        async function render() {
            if (msg && Date.now() - msgAt > 8000 && !store.warning) { msg = ''; changed(); }
            if (drawn === version) return;
            drawn = version;
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 1) {
                const docs = {};
                Object.keys(KINDS).forEach((k) => { docs[k] = store.current(k); });
                drawCar(cv, t, { series, body, variant: store.car.variant, vin, odo, odoState, docs, own: cv.own, today: today(), bottom: H - 8 - (msg ? 40 : 0) },
                    { variant: editVariant, doc: openDoc });
            } else if (page === 2) {
                const live = mgf.link === 'ok' ? mgf : null, st = mgfStatus(t);
                drawGuide(cv, t, {
                    own: cv.own, bottom: H - 8 - (msg ? 40 : 0), live, armed: armed && Date.now() <= armed.until ? armed : null,
                    onValue: live && cv.own ? onValue : null, status: st[0], statusColor: st[1],
                }, guide, changed);
            } else drawLog(cv, t);
            if (msg) cv.text(fit(cv, msg, 24, W - 80), 40, H - 18, 24, store.warning ? (t.warn || '#ffb000') : t.dim, { literal: true });
            G.frame(cv, t, PAGES, page, []);
            await ui.image('MAIN_GFX', cv);
        }

        function drawLog(cv, t) {
            const S = t.sel || t.accent;
            // odometer and Add
            cv.text('ODOMETER', 40, 70, 18, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(odo != null ? kmText(odo) + ' km' : odoState === 'waiting' ? 'waiting for the car' : odoState, 40, 110, 36,
                odo != null ? t.text : t.dim, { font: 'bold', literal: true });
            const n = store.entries.length;
            cv.text(n + (n === 1 ? ' entry' : ' entries'), 520, 110, 26, t.dim, { literal: true });
            if (cv.own) {
                const bx = W - 40 - 300, by = 62;
                cv.roundRect(bx, by, 300, 56, 28, withAlpha(S, 0.9));
                cv.text('+  Add entry', bx + 150, by + 37, 26, '#ffffff', { align: 'center', font: 'bold' });
                cv.target(bx, by, 300, 56, safe('add', () => edit(null)), 'add', 28);
                const ix = bx - 20 - 240;
                cv.roundRect(ix, by, 240, 56, 28, withAlpha('#ffffff', 0.08));
                cv.strokeRoundRect(ix, by, 240, 56, 28, 1.5, withAlpha('#ffffff', 0.25));
                cv.text('USB import', ix + 120, by + 37, 24, t.text, { align: 'center', font: 'bold' });
                cv.target(ix, by, 240, 56, startImport, 'import', 28);
            } else {
                cv.text('Adding entries needs the GPU renderer (mgu-render)', W - 40, 110, 22, t.dim, { align: 'right' });
            }
            // the list
            const bottom = H - 8 - (msg ? 40 : 0), vis = bottom - LIST_Y;
            const total = n * (ROW_H + ROW_GAP) - ROW_GAP;
            scroll.max = cv.own ? Math.max(0, total - vis) : 0;
            scroll.y = Math.max(0, Math.min(scroll.y, scroll.max));
            if (!n) {
                cv.text(cv.own ? 'No entries yet. Tap Add entry.' : 'No entries yet.', W / 2, LIST_Y + 150, 30, t.dim, { align: 'center' });
            } else {
                cv.clip(0, LIST_Y, W, vis);
                store.entries.forEach((e, i) => {
                    const y = LIST_Y + i * (ROW_H + ROW_GAP) - scroll.y;
                    if (y + ROW_H < LIST_Y || y > bottom) return;
                    const x = 40, w = W - 80 - (scroll.max ? 20 : 0), cy = y + ROW_H / 2 + 10;
                    cv.roundRect(x, y, w, ROW_H, 14, withAlpha('#ffffff', 0.05));
                    cv.text(e.date, x + 24, cy, 28, t.text, { font: 'bold', literal: true });
                    cv.text(e.km != null ? kmText(e.km) + ' km' : '-- km', x + 380, cy, 28, t.text, { align: 'right', literal: true });
                    cv.text(fit(cv, e.type, 28, 300, 'bold'), x + 420, cy, 28, S, { font: 'bold', literal: true });
                    const extra = [e.notes, e.workshop, e.cost].filter(Boolean).join('  ·  ');
                    cv.text(fit(cv, extra, 26, w - 700), x + 680, cy, 26, t.dim, { literal: true });
                    if (cv.own) {
                        const top = Math.max(y, LIST_Y), h = Math.min(y + ROW_H, bottom) - top;
                        if (h >= 20) cv.target(x, top, w, h, safe('open', () => edit(e)), 'row:' + e.id, 14);
                    }
                });
                cv.noclip();
                if (scroll.max) {
                    const bh = Math.max(40, vis * vis / (vis + scroll.max));
                    const bar = { x: W - 46, y: LIST_Y + (vis - bh) * scroll.y / scroll.max, w: 6, h: bh };
                    cv.roundRect(bar.x, bar.y, bar.w, bar.h, 3, withAlpha(t.text, 0.3));
                    cv.scroll = { y: LIST_Y, bar };
                }
            }
        }

        ctx.loop('MAIN', 2, render);
        const redraw = () => { changed(); setTimeout(changed, 600); };
        ui.onVisible((name, on) => { if (name === 'MAIN') { visible = !!on; if (on) redraw(); } });
        setInterval(changed, 60000);         // the documents' days left move on at midnight
        render().catch((e) => log.warn('first render: ' + e));
    },
});
