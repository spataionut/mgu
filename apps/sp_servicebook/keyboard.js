'use strict';
/**
 * keyboard.js - a QWERTY keyboard the app draws itself, as a kit sheet (kit/runtime/sheet.js),
 * because OAP has no text input or speller component (docs/research.md).
 *
 *   const kb = keyboardSheet({ title, value, mode: 'text' | 'number', decimal, maxLen, placeholder,
 *                              onDone(value), onCancel() });
 *   ctx.sheet(kb);
 *
 * Touch: every key is a tap target (the kit sends a tap on release). The iDrive controller: the knob
 * moves along the keys, push up/down moves a row, press types the key, push left cancels.
 * onDone / onCancel return what the sheet returns: 'close' closes it; anything else keeps it
 * (e.g. they opened another sheet with ctx.sheet).
 *
 * Text mode: letters (shift: once; tap twice quickly: caps lock), a 123 page of digits and
 * symbols, space, backspace, Cancel, Done. Number mode: a number pad (digits, '.' with decimal).
 * Only characters the kit's fonts have (ASCII and €) can be typed.
 *
 * Node 8. Drawing area: the kit's sheet page, 1600 x 520, the header above y 46.
 */
const { withAlpha } = require('./kit/canvas');

const W = 1600, TOP = 46, BOTTOM = 512;
const MARGIN = 40, GAP = 10;
const FIELD = { x: MARGIN, y: TOP + 14, w: W - 2 * MARGIN, h: 84 };
const KEYS_Y = FIELD.y + FIELD.h + 18;
const SHIFT_LOCK_MS = 450;
const FLASH_MS = 180;

/* key: { id, label, w (units), kind: 'char' | 'back' | 'shift' | 'mode' | 'space' | 'cancel' | 'done', ch } */
const ch = (c, w) => ({ id: 'c:' + c, label: c, w: w || 1, kind: 'char', ch: c });
const BACK = { id: 'back', label: 'Del', w: 1.5, kind: 'back' };
const LAYOUTS = {
    letters: [
        'qwertyuiop'.split('').map((c) => ch(c)).concat([BACK]),
        'asdfghjkl'.split('').map((c) => ch(c)).concat([ch('-'), ch('\'')]),
        [{ id: 'shift', label: 'Shift', w: 1.5, kind: 'shift' }].concat('zxcvbnm'.split('').map((c) => ch(c)), [ch(','), ch('.'), ch('?')]),
        [{ id: 'mode', label: '123', w: 1.5, kind: 'mode', to: 'symbols' }, { id: 'space', label: 'space', w: 6, kind: 'space', ch: ' ' },
            { id: 'cancel', label: 'Cancel', w: 2, kind: 'cancel' }, { id: 'done', label: '✓ Done', w: 2, kind: 'done' }],
    ],
    symbols: [
        '1234567890'.split('').map((c) => ch(c)).concat([BACK]),
        '@#€&*()/:;+'.split('').map((c) => ch(c)),
        [{ id: 'mode', label: 'ABC', w: 1.5, kind: 'mode', to: 'letters' }].concat('%="!_<>[]'.split('').map((c) => ch(c)), [ch(','), ch('.')]),
        [{ id: 'mode2', label: 'ABC', w: 1.5, kind: 'mode', to: 'letters' }, { id: 'space', label: 'space', w: 6, kind: 'space', ch: ' ' },
            { id: 'cancel', label: 'Cancel', w: 2, kind: 'cancel' }, { id: 'done', label: '✓ Done', w: 2, kind: 'done' }],
    ],
    number: [
        [ch('1', 2), ch('2', 2), ch('3', 2), Object.assign({}, BACK, { w: 2 })],
        [ch('4', 2), ch('5', 2), ch('6', 2), { id: 'cancel', label: 'Cancel', w: 2, kind: 'cancel' }],
        [ch('7', 2), ch('8', 2), ch('9', 2), { id: 'clear', label: 'Clear', w: 2, kind: 'clear' }],
        [ch('.', 2), ch('0', 2), { id: 'pad', label: '', w: 2, kind: 'none' }, { id: 'done', label: '✓ Done', w: 2, kind: 'done' }],
    ],
};

/** Key rects for a layout: rows share one unit width (the widest row fills the line), narrower rows are centred. */
function layoutKeys(rows, opts) {
    const o = opts || {};
    const left = o.x !== undefined ? o.x : MARGIN, width = o.w !== undefined ? o.w : W - 2 * MARGIN;
    const top = o.y !== undefined ? o.y : KEYS_Y, bottom = o.bottom !== undefined ? o.bottom : BOTTOM;
    const rowH = (bottom - top - (rows.length - 1) * GAP) / rows.length;
    const units = Math.max.apply(null, rows.map((r) => r.reduce((a, k) => a + k.w, 0)));
    const most = Math.max.apply(null, rows.map((r) => r.length));
    const unit = (width - (most - 1) * GAP) / units;
    const keys = [];
    rows.forEach((row, ri) => {
        const rowW = row.reduce((a, k) => a + k.w * unit, 0) + (row.length - 1) * GAP;
        let x = left + (width - rowW) / 2;
        row.forEach((k) => {
            const w = k.w * unit;
            keys.push(Object.assign({}, k, { x, y: top + ri * (rowH + GAP), w, h: rowH, row: ri }));
            x += w + GAP;
        });
    });
    return keys;
}

function keyboardSheet(opts) {
    const o = Object.assign({ mode: 'text', value: '', maxLen: 200, placeholder: '', decimal: false, autoCap: true }, opts || {});
    const numeric = o.mode === 'number';
    const kb = {
        title: o.title || 'Type',
        value: String(o.value == null ? '' : o.value),
        page: numeric ? 'number' : 'letters',
        shift: 0,                       // 0 off, 1 next letter, 2 caps lock
        shiftAt: 0,
        focus: 0,                       // knob focus: index into keys()
        controller: false,              // the knob was used: show the focus
        flash: null, flashAt: 0,        // the key last pressed, lit briefly
        onClose: null,
        keys() {
            if (numeric) {
                // number pad: half the width, centred
                return layoutKeys(LAYOUTS.number, { x: (W - 900) / 2, w: 900 })
                    .filter((k) => k.kind !== 'none' && !(k.ch === '.' && !o.decimal));
            }
            return layoutKeys(LAYOUTS[this.page]);
        },
        caps() { return !numeric && this.page === 'letters' && this.shift > 0; },
        label(k) { return k.kind === 'char' && this.caps() ? k.label.toUpperCase() : k.label; },
        /** Type one key (a tap or the knob's press). Returns what the sheet returns. */
        hit(k) {
            this.flash = k.id; this.flashAt = Date.now();
            switch (k.kind) {
            case 'char': case 'space': return this.typeChar(k.kind === 'space' ? ' ' : this.label(k));
            case 'back': this.value = this.value.slice(0, -1); return null;
            case 'clear': this.value = ''; return null;
            case 'shift': {
                const now = Date.now();
                if (this.shift === 1 && now - this.shiftAt < SHIFT_LOCK_MS) this.shift = 2;
                else this.shift = this.shift ? 0 : 1;
                this.shiftAt = now;
                return null;
            }
            case 'mode':
                this.page = k.to; this.focus = Math.min(this.focus, this.keys().length - 1);
                return null;
            case 'cancel': return o.onCancel ? o.onCancel() : 'close';
            case 'done': return o.onDone ? o.onDone(numeric ? this.value.replace(/\.$/, '') : this.value.replace(/\s+$/, '')) : 'close';
            default: return null;
            }
        },
        typeChar(c) {
            if (this.value.length >= o.maxLen) return null;
            if (numeric) {
                if (!/[0-9.]/.test(c)) return null;
                if (c === '.' && (!o.decimal || this.value.indexOf('.') >= 0)) return null;
                if (c === '.' && !this.value) c = '0.';
                if (this.value === '0' && c !== '.') this.value = '';
            }
            this.value += c;
            if (this.shift === 1 && /[a-zA-Z]/.test(c)) this.shift = 0;
            return null;
        },
        /** Text as typed: the field shows its end when it is longer than the box. */
        draw(r, t) {
            r.clear(t.bg);
            const S = t.sel || t.accent;
            // the field
            r.roundRect(FIELD.x, FIELD.y, FIELD.w, FIELD.h, 14, withAlpha('#ffffff', 0.07));
            r.strokeRoundRect(FIELD.x, FIELD.y, FIELD.w, FIELD.h, 14, 2, withAlpha(S, 0.8));
            const size = 36, tx = FIELD.x + 26, ty = FIELD.y + FIELD.h / 2 + 13, room = FIELD.w - 52 - 160;
            let shown = this.value;
            if (shown && r.textWidth(shown, size, { literal: true }) > room) {
                while (shown.length > 1 && r.textWidth('…' + shown, size, { literal: true }) > room) shown = shown.slice(1);
                shown = '…' + shown;
            }
            if (shown) r.text(shown, tx, ty, size, t.text, { literal: true });
            else if (o.placeholder) r.text(o.placeholder, tx, ty, size, t.dim, { literal: true });
            const cx = tx + (shown ? r.textWidth(shown, size, { literal: true }) : 0) + 3;
            if (Math.floor(Date.now() / 530) % 2 === 0) r.fillRect(cx, FIELD.y + 18, 3, FIELD.h - 36, S);
            r.text(this.value.length + ' / ' + o.maxLen, FIELD.x + FIELD.w - 24, ty - 2, 20, t.dim, { align: 'right' });
            // the keys
            const keys = this.keys();
            this.focus = Math.max(0, Math.min(this.focus, keys.length - 1));
            const flashing = this.flash && Date.now() - this.flashAt < FLASH_MS ? this.flash : null;
            const targets = [];
            keys.forEach((k, i) => {
                const lit = flashing === k.id, special = k.kind !== 'char' && k.kind !== 'space';
                const on = (k.kind === 'shift' && this.shift > 0) || k.kind === 'done';
                const bg = lit ? withAlpha(S, 0.95) : on ? withAlpha(S, k.kind === 'done' ? 0.75 : 0.45)
                    : withAlpha('#ffffff', special ? 0.12 : 0.08);
                r.roundRect(k.x, k.y, k.w, k.h, 12, bg);
                if (this.controller && i === this.focus) r.strokeRoundRect(k.x - 3, k.y - 3, k.w + 6, k.h + 6, 14, 3, S);
                const fg = lit || on ? '#ffffff' : t.text, mx = k.x + k.w / 2, my = k.y + k.h / 2;
                // the fonts have no arrows (they're baked as empty boxes): backspace and shift are drawn
                if (k.kind === 'back') {
                    r.polyline([[mx - 30, my], [mx - 14, my - 18], [mx + 30, my - 18], [mx + 30, my + 18], [mx - 14, my + 18], [mx - 30, my]], 3, fg);
                    r.line(mx - 1, my - 8, mx + 15, my + 8, 3, fg); r.line(mx - 1, my + 8, mx + 15, my - 8, 3, fg);
                } else if (k.kind === 'shift') {
                    r.polyline([[mx, my - 22], [mx + 20, my], [mx + 9, my], [mx + 9, my + 14], [mx - 9, my + 14], [mx - 9, my], [mx - 20, my], [mx, my - 22]], 3, fg);
                    if (this.shift === 2) r.fillRect(mx - 9, my + 20, 18, 4, fg);       // caps lock
                } else {
                    const big = k.kind === 'char';
                    r.text(this.label(k), mx, my + (big ? 13 : 9), big ? 36 : 26, fg, { align: 'center', font: big ? 'label' : 'bold', literal: true });
                }
                targets.push({ x: k.x, y: k.y, w: k.w, h: k.h, key: k.id, act: () => this.hit(k) });
            });
            return targets;
        },
        move(d) {
            this.controller = true;
            const n = this.keys().length;
            this.focus = ((this.focus + d) % n + n) % n;
        },
        /** Push up / down: the key above / below that is nearest in x. */
        tilt(dir) {
            if (dir !== 'N' && dir !== 'S') return false;
            this.controller = true;
            const keys = this.keys(), cur = keys[this.focus] || keys[0];
            const row = cur.row + (dir === 'N' ? -1 : 1);
            const inRow = keys.map((k, i) => ({ k, i })).filter((e) => e.k.row === row);
            if (!inRow.length) return dir === 'S';          // top row, pushed up: the header (display.js)
            const mid = cur.x + cur.w / 2;
            inRow.sort((a, b) => Math.abs(a.k.x + a.k.w / 2 - mid) - Math.abs(b.k.x + b.k.w / 2 - mid));
            this.focus = inRow[0].i;
            return true;
        },
        press() { this.controller = true; const k = this.keys()[this.focus]; return k ? this.hit(k) : null; },
        back() { return o.onCancel ? o.onCancel() : 'close'; },
        top() { const k = this.keys()[this.focus]; return !k || k.row === 0; },
    };
    if (!numeric && o.autoCap && !kb.value) kb.shift = 1;
    return kb;
}

module.exports = { keyboardSheet, layoutKeys, LAYOUTS };
