'use strict';
/**
 * customcode.js - the Custom Code page: a guide to MG Flasher's Custom Code Menu (CCM).
 *
 * Reference only: the app doesn't talk to the DME. In the CCM, the cruise-control buttons move
 * through the menu and the tachometer needle shows where you are: first the submenu (the feature),
 * then the value. This page shows, for each feature the owner uses, where the needle points.
 * Taken from MG Flasher's CCM article (tachometer layout and the "Custom Code feature layout");
 * Burbles (2K), Antilag RPM (4K) and Ethanol Content Override (5K) are left out on purpose.
 *
 * Tap a feature: the dial points at its submenu. Tap a value: the dial points at that value.
 */
const { withAlpha } = require('./kit/canvas');
const { fit } = require('./form');

const W = 1600, H = 520;
/* [needle position in 1000 rpm, feature, [[needle position, value, note], ...]]
 * The map slots are this car's: slot 0 max power on 100 RON, slot 1 max power on 95 RON, slot 2 stock. */
const FEATURES = [
    [1, 'Switchable Maps', [[0, '100 RON', 'Slot 0 · max power'], [1, '95 RON', 'Slot 1 · max power'], [2, 'Stock', 'Slot 2 · stock power']]],
    [3, 'Max Cooling', [[0, 'Disable'], [1, 'Enable']]],
    [6, 'Exhaust Flap', [[0, 'Automatic'], [1, 'Closed'], [2, 'Opened']]],
    [7, 'Valet Mode', [[0, 'Disable'], [1, 'Enable']]],
];
const EXIT = 0;
const MAX = 8;

/** dial angle for k (x1000 rpm), degrees clockwise from 12 o'clock. Like the car's cluster: 0 at the
 *  bottom, the scale runs anticlockwise up the right side and over the top, 8 at the top left. */
const angleOf = (k) => 200 - k * 30;
const norm = (a) => ((a % 360) + 360) % 360;
const point = (cx, cy, r, a) => [cx + Math.sin(a * Math.PI / 180) * r, cy - Math.cos(a * Math.PI / 180) * r];

/** the state the page keeps between draws: which feature and value are picked */
function guideState() { return { feature: 0, value: null }; }

/**
 * Draw the page on cv. s = { own, bottom }, st = guideState(); changed() after a tap.
 */
function drawGuide(cv, t, s, st, changed) {
    const S = t.sel || t.accent;
    const bottom = s.bottom || H - 8;
    const f = FEATURES[st.feature] || FEATURES[0];
    const v = st.value != null ? f[2][st.value] : null;
    const at = v ? v[0] : f[0];

    // the dial: the scale from 0 (200 degrees) to 8 (-40 = 320 degrees), red from 7 to 8
    const cx = 225, cy = 290, R = 180;
    cv.circle(cx, cy, R + 14, withAlpha('#ffffff', 0.04));
    cv.arc(cx, cy, R - 6, R, 0, angleOf(0), withAlpha('#ffffff', 0.35));
    cv.arc(cx, cy, R - 6, R, norm(angleOf(MAX)), 360, withAlpha('#ffffff', 0.35));
    cv.arc(cx, cy, R - 8, R + 2, norm(angleOf(MAX)), norm(angleOf(7)), '#ef2b2d');
    const used = {};
    FEATURES.forEach((q) => { used[q[0]] = true; });
    for (let k = 0; k <= MAX; k++) {
        const a = angleOf(k);
        const p0 = point(cx, cy, R - (used[k] || k === EXIT ? 30 : 22), a), p1 = point(cx, cy, R, a);
        cv.line(p0[0], p0[1], p1[0], p1[1], used[k] ? 6 : 3, used[k] ? t.text : withAlpha(t.text, 0.4));
        const n = point(cx, cy, R - 66, a);
        cv.text(String(k), n[0], n[1] + 13, 36, used[k] || k === EXIT ? t.text : withAlpha(t.text, 0.35), { align: 'center', font: 'bold', literal: true });
        if (k < MAX) for (let m = 1; m < 4; m++) {
            const am = angleOf(k + m / 4), q0 = point(cx, cy, R - 12, am), q1 = point(cx, cy, R, am);
            cv.line(q0[0], q0[1], q1[0], q1[1], 2, withAlpha(t.text, 0.3));
        }
    }
    // the pointer, on the rim as in the cluster
    const p0 = point(cx, cy, R - 44, angleOf(at)), p1 = point(cx, cy, R + 10, angleOf(at));
    cv.line(p0[0], p0[1], p1[0], p1[1], 9, S);
    // the readout in the middle
    cv.text(at + 'K', cx - 20, cy - 14, 44, S, { align: 'center', font: 'bold', literal: true });
    cv.text(fit(cv, f[1], 20, 170), cx - 20, cy + 18, 20, t.text, { align: 'center', literal: true });
    cv.text(fit(cv, v ? v[1] : 'menu', 22, 170, 'bold'), cx - 20, cy + 46, 22, v ? t.text : t.dim, { align: 'center', font: 'bold', literal: true });
    cv.text('1/min x1000 · 0 = Exit', cx - 20, cy + 76, 16, t.dim, { align: 'center', literal: true });

    // the features
    const x0 = 470, gap = 16, cw = (W - 40 - x0 - (FEATURES.length - 1) * gap) / FEATURES.length;
    const y0 = 62, hintY = bottom - 14, ch = hintY - 28 - y0;
    FEATURES.forEach((q, i) => {
        const x = x0 + i * (cw + gap), sel = i === st.feature;
        const rowH = q[2].some((val) => val[2]) ? 72 : 50;      // a value with a note gets a second line
        cv.roundRect(x, y0, cw, ch, 16, withAlpha('#ffffff', sel ? 0.1 : 0.05));
        if (sel) cv.strokeRoundRect(x, y0, cw, ch, 16, 2, withAlpha(S, 0.8));
        cv.text(q[0] + 'K', x + 22, y0 + 50, 40, sel ? S : t.text, { font: 'bold', literal: true });
        cv.text('MENU', x + 22 + cv.textWidth(q[0] + 'K', 40, { font: 'bold', literal: true }) + 12, y0 + 48, 16, t.dim, { font: 'bold', spacing: 1.5 });
        cv.text(fit(cv, q[1], 26, cw - 40, 'bold'), x + 22, y0 + 88, 26, t.text, { font: 'bold', literal: true });
        if (s.own) cv.target(x, y0, cw, 104, () => { st.feature = i; st.value = null; changed(); return null; }, 'cc:' + i, 16);
        q[2].forEach((val, j) => {
            const y = y0 + 108 + j * rowH, on = sel && st.value === j;
            if (on) cv.roundRect(x + 10, y, cw - 20, rowH - 6, 10, withAlpha(S, 0.85));
            cv.text(val[0] + 'K', x + 26, y + 32, 24, on ? '#ffffff' : sel ? S : t.dim, { font: 'bold', literal: true });
            cv.text(fit(cv, val[1], 24, cw - 110), x + 90, y + 32, 24, on ? '#ffffff' : t.text, { literal: true });
            if (val[2]) cv.text(fit(cv, val[2], 18, cw - 110), x + 90, y + 56, 18, on ? withAlpha('#ffffff', 0.85) : t.dim, { literal: true });
            if (s.own) cv.target(x + 10, y, cw - 20, rowH - 6, () => { st.feature = i; st.value = j; changed(); return null; }, 'cc:' + i + ':' + j, 10);
        });
    });
    cv.text('Cruise-control buttons move through the menu; the needle shows the submenu, then the value. Info only: the app doesn\'t change the car.',
        x0, hintY, 18, t.dim, { literal: true });
}

module.exports = { drawGuide, guideState, FEATURES, angleOf };
