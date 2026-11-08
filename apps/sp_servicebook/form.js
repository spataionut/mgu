'use strict';
/**
 * form.js - the Add / Edit entry sheet (kit sheet, 1600 x 520, header above y 46).
 *
 *   formSheet({ entry, odometer(), open(sheet), onSave(entry), onDelete(id) })
 *
 * Type: a pill per type. Date: - / + a day, Today. km: number keyboard, or the odometer.
 * Notes, cost, workshop: the app's keyboard (keyboard.js). open(sheet) shows another sheet in its
 * place (ctx.sheet); the keyboard comes back here with open(form).
 * onSave / onDelete may throw (disk); the form then shows the error and stays open.
 */
const { withAlpha } = require('./kit/canvas');
const { pill } = require('./kit/sheet');
const { keyboardSheet } = require('./keyboard');
const { TYPES } = require('./store');

const W = 1600, TOP = 46;
const X = 40, FW = W - 2 * X;
const DELETE_CONFIRM_MS = 4000;

const pad = (n) => (n < 10 ? '0' : '') + n;
function today() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function addDays(s, n) {
    const p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
const kmText = (km) => (km == null || km === '' ? '' : String(km).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));

function fit(r, s, size, w, font) {
    s = String(s);
    const o = { literal: true, font };
    if (r.textWidth(s, size, o) <= w) return s;
    while (s.length > 1 && r.textWidth(s + '...', size, o) > w) s = s.slice(0, -1);
    return s + '...';
}

function formSheet(opts) {
    const src = opts.entry || {};
    const odo = () => { try { return opts.odometer ? opts.odometer() : null; } catch (e) { return null; } };
    const f = {
        title: src.id ? 'Edit entry' : 'Add entry',
        e: {
            id: src.id || null,
            type: src.type || null,
            date: src.date || today(),
            km: src.id ? (src.km == null ? '' : String(src.km)) : (odo() != null ? String(odo()) : ''),
            notes: src.notes || '', cost: src.cost || '', workshop: src.workshop || '',
        },
        focus: 0, controller: false, error: '', armDelete: 0,
        onClose: opts.onClose || null,
        targets: [],
        keyboard(field, label, mode, maxLen) {
            const kb = keyboardSheet({
                title: label, value: f.e[field], mode, maxLen,
                placeholder: mode === 'number' ? 'km' : '',
                onDone: (v) => { f.e[field] = v; f.error = ''; return opts.open(f) ? null : 'close'; },
                onCancel: () => (opts.open(f) ? null : 'close'),
            });
            opts.open(kb);
            return null;
        },
        save() {
            if (!f.e.type) { f.error = 'Pick a type first'; return null; }
            try { opts.onSave(Object.assign({}, f.e, { km: f.e.km === '' ? null : Number(f.e.km) })); } catch (e) { f.error = 'Not saved: ' + (e && e.message || e); return null; }
            return 'close';
        },
        del() {
            if (Date.now() - f.armDelete > DELETE_CONFIRM_MS) { f.armDelete = Date.now(); return null; }
            try { opts.onDelete(f.e.id); } catch (e) { f.error = 'Not deleted: ' + (e && e.message || e); return null; }
            return 'close';
        },
        draw(r, t) {
            r.clear(t.bg);
            const S = t.sel || t.accent, T = [];
            const add = (x, y, w, h, key, act) => { T.push({ x, y, w, h, key, act }); return T.length - 1; };
            const ring = (i, x, y, w, h, rad) => { if (f.controller && i === f.focus) r.strokeRoundRect(x - 4, y - 4, w + 8, h + 8, rad + 4, 3, S); };
            const label = (s, x, y) => r.text(s, x, y, 18, t.dim, { font: 'bold', spacing: 1.5 });
            // type pills: 2 rows of 5
            label('TYPE', X, TOP + 26);
            const pw = (FW - 4 * 12) / 5, ph = 48;
            TYPES.forEach((ty, i) => {
                const x = X + (i % 5) * (pw + 12), y = TOP + 38 + Math.floor(i / 5) * (ph + 10);
                const k = add(x, y, pw, ph, 'type:' + ty, () => { f.e.type = ty; f.error = ''; return null; });
                pill(r, t, x, y, pw, ph, ty, f.e.type === ty);
                ring(k, x, y, pw, ph, ph / 2);
            });
            // date and km
            let y = TOP + 38 + 2 * (ph + 10) + 22;
            label('DATE', X, y); label('KM', X + 760, y);
            y += 12;
            const bh = 60;
            const box = (x, w, text, ph2, key, act) => {
                const k = add(x, y, w, bh, key, act);
                r.roundRect(x, y, w, bh, 12, withAlpha('#ffffff', 0.07));
                r.strokeRoundRect(x, y, w, bh, 12, 1.5, withAlpha('#ffffff', 0.25));
                r.text(text ? fit(r, text, 30, w - 40) : ph2, x + 20, y + bh / 2 + 11, 30, text ? t.text : t.dim, { literal: true });
                ring(k, x, y, w, bh, 12);
            };
            const btn = (x, w, text, key, act, on) => {
                const k = add(x, y, w, bh, key, act);
                pill(r, t, x, y, w, bh, text, !!on);
                ring(k, x, y, w, bh, bh / 2);
            };
            btn(X, 80, '-', 'date-', () => { f.e.date = addDays(f.e.date, -1); return null; });
            r.text(f.e.date, X + 80 + 150, y + bh / 2 + 12, 34, t.text, { align: 'center', font: 'bold', literal: true });
            btn(X + 390, 80, '+', 'date+', () => { if (f.e.date < today()) f.e.date = addDays(f.e.date, 1); return null; });
            btn(X + 490, 170, 'Today', 'date0', () => { f.e.date = today(); return null; });
            box(X + 760, 380, kmText(f.e.km), 'tap to type', 'km', () => f.keyboard('km', 'Kilometres', 'number', 7));
            const o = odo();
            btn(X + 1160, FW - 1160, o != null ? 'Odometer ' + kmText(o) : 'No odometer yet', 'odo', () => { if (odo() != null) f.e.km = String(odo()); return null; });
            // notes, cost, workshop
            y += bh + 34;
            label('NOTES', X, y - 10); label('COST', X + 900, y - 10); label('WORKSHOP', X + 1180, y - 10);
            box(X, 880, f.e.notes, 'tap to type', 'notes', () => f.keyboard('notes', 'Notes', 'text', 200));
            box(X + 900, 260, f.e.cost, 'cost', 'cost', () => f.keyboard('cost', 'Cost', 'text', 20));
            box(X + 1180, FW - 1180, f.e.workshop, 'workshop', 'workshop', () => f.keyboard('workshop', 'Workshop', 'text', 60));
            // actions
            y += bh + 26;
            if (f.e.id) {
                const armed = Date.now() - f.armDelete < DELETE_CONFIRM_MS;
                const k = add(X, y, 260, bh, 'delete', () => f.del());
                pill(r, t, X, y, 260, bh, armed ? 'Tap to confirm' : 'Delete', armed, { color: '#ef2b2d' });
                ring(k, X, y, 260, bh, bh / 2);
            }
            if (f.error) r.text(fit(r, f.error, 24, 640), X + (f.e.id ? 290 : 0), y + bh / 2 + 9, 24, t.warn || '#ffb000', { literal: true });
            btn(W - X - 460, 210, 'Cancel', 'cancel', () => 'close');
            btn(W - X - 230, 230, 'Save', 'save', () => f.save(), true);
            f.focus = Math.max(0, Math.min(f.focus, T.length - 1));
            f.targets = T;
            return T;
        },
        move(d) { f.controller = true; const n = f.targets.length || 1; f.focus = ((f.focus + d) % n + n) % n; },
        press() { f.controller = true; const tg = f.targets[f.focus]; return tg ? tg.act() : null; },
        back() { return 'close'; },
        top() { return f.focus < 5; },
    };
    return f;
}

module.exports = { formSheet, today, addDays, kmText };
