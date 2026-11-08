'use strict';
/**
 * Service Book: the log list, Add / Edit with the app's own keyboard, the odometer (milestone 1);
 * the Car page: model, VIN, total km, RCA / CASCO / Rovinieta / ITP (0.2.0, car.js, docs.js).
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
const { today, addDays } = require('./dates');

const W = 1600, H = 520;
const KOMBI = 'de.bmw.infotainment.KombiIF';
const VEHICLE = 'de.bmw.infrastructure.VehicleInformation';
const PAGES = ['Service log', 'Car'];
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

        /* ---------- series and body: notifier only, so they come when the car sends them ---------- */
        ctx.signals.watch(VEHICLE, '1', {
            VehicleType: safe('vehicle type', (v) => {
                const s2 = seriesOf(v && v.typeVehicle), b = bodyText(v && v.typeBody);
                if (s2 !== series || b !== body) { series = s2; body = b; changed(); }
            }),
        }, log).then((sub) => { if (sub && sub.error) log.warn('vehicle type: ' + sub.error); })
            .catch((e) => log.error('vehicle type', e));

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
        ui.onVisible((name, on) => { if (name === 'MAIN' && on) redraw(); });
        setInterval(changed, 60000);         // the documents' days left move on at midnight
        render().catch((e) => log.warn('first render: ' + e));
    },
});
