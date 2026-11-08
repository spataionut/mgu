'use strict';
/**
 * docs.js - the car's documents (RCA, CASCO, Rovinieta, ITP): status and the period form.
 *
 *   status(period, today)   { state: 'none' | 'ok' | 'soon' | 'expired', days, text }
 *   docSheet({ kind, period, renewFrom, odometer(), open(sheet), onSave(period, isNew), onDelete(id) })
 *
 * period: the one to edit, or null for a new one. renewFrom: a new period's start date (the day
 * after the last one ended); its end comes from the length pills (1 month, 1 year, ...).
 * Dates are typed on the keyboard's date pad (digits, YYYY-MM-DD).
 */
const { withAlpha } = require('./kit/canvas');
const { pill } = require('./kit/sheet');
const { keyboardSheet } = require('./keyboard');
const { today, addDays, addMonths, daysBetween } = require('./dates');
const { kmText, fit } = require('./form');

const W = 1600, TOP = 46, X = 40;
const SOON_DAYS = 30;
const DELETE_CONFIRM_MS = 4000;

/* kind: label, what "who" is, what "number" is (null: not asked), km asked, lengths offered [label, months, days] */
const KINDS = {
    rca: { label: 'RCA', who: 'Insurer', number: 'Policy no.', km: false, lengths: [['1 month', 1], ['6 months', 6], ['12 months', 12]] },
    casco: { label: 'CASCO', who: 'Insurer', number: 'Policy no.', km: false, lengths: [['6 months', 6], ['12 months', 12]] },
    rovinieta: { label: 'Rovinieta', who: null, number: 'Serial no.', km: false, lengths: [['7 days', 0, 7], ['30 days', 0, 30], ['90 days', 0, 90], ['12 months', 12]] },
    itp: { label: 'ITP', who: 'Station', number: null, km: true, lengths: [['1 year', 12], ['2 years', 24]] },
};

function status(p, now) {
    if (!p) return { state: 'none', days: null, text: 'Not set' };
    const days = daysBetween(now || today(), p.until);
    if (days < 0) return { state: 'expired', days, text: 'Expired ' + (-days === 1 ? 'yesterday' : -days + ' days ago') };
    const text = days === 0 ? 'Last day today' : days === 1 ? '1 day left' : days + ' days left';
    return { state: days <= SOON_DAYS ? 'soon' : 'ok', days, text };
}
const OK = '#3fbf6f';
function stateColor(t, state) { return state === 'ok' ? OK : state === 'soon' ? (t.warn || '#ffb000') : state === 'expired' ? (t.crit || '#ef2b2d') : t.dim; }

/** end date for a length starting on from: the day before from + length (12 months from 01-15 ends 01-14) */
function endFor(from, len) { return addDays(len[1] ? addMonths(from, len[1]) : addDays(from, len[2]), -1); }

function docSheet(opts) {
    const K = KINDS[opts.kind];
    if (!K) throw new Error('unknown document ' + opts.kind);
    const src = opts.period || {};
    const isNew = !src.id;
    const odo = () => { try { return opts.odometer ? opts.odometer() : null; } catch (e) { return null; } };
    const from = src.from || opts.renewFrom || today();
    const f = {
        title: K.label + (isNew ? ': new period' : ': edit'),
        e: {
            id: src.id || null, from, until: src.until || '',
            who: src.who || '', number: src.number || '', cost: src.cost || '',
            km: src.km != null ? String(src.km) : (isNew && K.km && odo() != null ? String(odo()) : ''),
        },
        focus: 0, controller: false, error: '', armDelete: 0, targets: [],
        onClose: opts.onClose || null,
        keyboard(field, label, mode, maxLen) {
            opts.open(keyboardSheet({
                title: K.label + ': ' + label, value: f.e[field], mode, maxLen, autoCap: mode === 'text',
                onDone: (v) => { f.e[field] = v; f.error = ''; return opts.open(f) ? null : 'close'; },
                onCancel: () => (opts.open(f) ? null : 'close'),
            }));
            return null;
        },
        save() {
            if (!f.e.until) { f.error = 'Set "valid until" first'; return null; }
            if (f.e.from && f.e.from > f.e.until) { f.error = '"Valid from" is after "valid until"'; return null; }
            try { opts.onSave(Object.assign({}, f.e, { km: f.e.km === '' ? null : Number(f.e.km) }), isNew); } catch (e) { f.error = 'Not saved: ' + (e && e.message || e); return null; }
            return 'close';
        },
        del() {
            if (Date.now() - f.armDelete > DELETE_CONFIRM_MS) { f.armDelete = Date.now(); return null; }
            try { opts.onDelete(f.e.id); } catch (e) { f.error = 'Not deleted: ' + (e && e.message || e); return null; }
            return 'close';
        },
        draw(r, t) {
            r.clear(t.bg);
            const S = t.sel || t.accent, T = [], bh = 60;
            const add = (x, y, w, h, key, act) => { T.push({ x, y, w, h, key, act }); return T.length - 1; };
            const ring = (i, x, y, w, h, rad) => { if (f.controller && i === f.focus) r.strokeRoundRect(x - 4, y - 4, w + 8, h + 8, rad + 4, 3, S); };
            const label = (s, x, y) => r.text(s, x, y, 18, t.dim, { font: 'bold', spacing: 1.5 });
            const box = (x, y, w, text, hint, key, act) => {
                const k = add(x, y, w, bh, key, act);
                r.roundRect(x, y, w, bh, 12, withAlpha('#ffffff', 0.07));
                r.strokeRoundRect(x, y, w, bh, 12, 1.5, withAlpha('#ffffff', 0.25));
                r.text(text ? fit(r, text, 30, w - 40) : hint, x + 20, y + bh / 2 + 11, 30, text ? t.text : t.dim, { literal: true });
                ring(k, x, y, w, bh, 12);
            };
            const btn = (x, y, w, text, key, act, on, color) => {
                const k = add(x, y, w, bh, key, act);
                pill(r, t, x, y, w, bh, text, !!on, color ? { color } : undefined);
                ring(k, x, y, w, bh, bh / 2);
            };
            // the heading: the document and how it stands with these dates
            const st = f.e.until ? status({ until: f.e.until }) : null;
            r.text(K.label, X, TOP + 50, 38, t.text, { font: 'bold', literal: true });
            r.text(isNew ? 'New period' : 'Edit period', X + r.textWidth(K.label, 38, { font: 'bold', literal: true }) + 24, TOP + 50, 24, t.dim);
            if (st) r.text(st.text, W - X, TOP + 48, 26, stateColor(t, st.state), { align: 'right', font: 'bold', literal: true });
            // dates
            let y = TOP + 92;
            label('VALID FROM', X, y); label('VALID UNTIL', X + 560, y);
            y += 12;
            box(X, y, 330, f.e.from, 'not set', 'from', () => f.keyboard('from', 'valid from', 'date'));
            btn(X + 345, y, 170, 'Today', 'from0', () => { f.e.from = today(); return null; });
            box(X + 560, y, 330, f.e.until, 'tap to type', 'until', () => f.keyboard('until', 'valid until', 'date'));
            const lx = X + 905, lw = (W - X - lx - (K.lengths.length - 1) * 10) / K.lengths.length;
            K.lengths.forEach((len, i) => {
                const end = f.e.from ? endFor(f.e.from, len) : null;
                btn(lx + i * (lw + 10), y, lw, len[0], 'len:' + len[0], () => {
                    if (!f.e.from) { f.error = 'Set "valid from" first'; return null; }
                    f.e.until = end; f.error = ''; return null;
                }, end && end === f.e.until);
            });
            // who / number / km / cost
            y += bh + 40;
            const fields = [];
            if (K.who) fields.push(['who', K.who, 'text', 60, 3]);
            if (K.number) fields.push(['number', K.number, 'text', 40, 3]);
            if (K.km) fields.push(['km', 'Km', 'number', 7, 2]);
            fields.push(['cost', 'Cost', 'text', 20, 2]);
            const units = fields.reduce((a, q) => a + q[4], 0) + (K.km ? 2 : 0);
            const uw = (W - 2 * X - (fields.length - (K.km ? 0 : 1)) * 20) / units;
            let x = X;
            fields.forEach((q) => {
                const w = q[4] * uw;
                label(q[1].toUpperCase(), x, y - 12);
                box(x, y, w, q[0] === 'km' ? kmText(f.e.km) : f.e[q[0]], q[0] === 'cost' ? 'cost' : 'tap to type', q[0],
                    () => f.keyboard(q[0], q[1], q[2], q[3]));
                x += w + 20;
                if (q[0] === 'km') {
                    const o = odo();
                    btn(x, y, 2 * uw, o != null ? 'Odometer' : 'No odometer', 'odo', () => { if (odo() != null) f.e.km = String(odo()); return null; });
                    x += 2 * uw + 20;
                }
            });
            // actions
            y += bh + 40;
            if (!isNew) {
                const armed = Date.now() - f.armDelete < DELETE_CONFIRM_MS;
                const k = add(X, y, 260, bh, 'delete', () => f.del());
                pill(r, t, X, y, 260, bh, armed ? 'Tap to confirm' : 'Delete', armed, { color: '#ef2b2d' });
                ring(k, X, y, 260, bh, bh / 2);
            }
            if (f.error) r.text(fit(r, f.error, 24, 640), X + (isNew ? 0 : 290), y + bh / 2 + 9, 24, t.warn || '#ffb000', { literal: true });
            btn(W - X - 460, y, 210, 'Cancel', 'cancel', () => 'close');
            btn(W - X - 230, y, 230, 'Save', 'save', () => f.save(), true);
            f.focus = Math.max(0, Math.min(f.focus, T.length - 1));
            f.targets = T;
            return T;
        },
        move(d) { f.controller = true; const n = f.targets.length || 1; f.focus = ((f.focus + d) % n + n) % n; },
        press() { f.controller = true; const tg = f.targets[f.focus]; return tg ? tg.act() : null; },
        back() { return 'close'; },
        top() { return f.focus < 2; },
    };
    return f;
}

module.exports = { KINDS, status, stateColor, docSheet, endFor, SOON_DAYS };
