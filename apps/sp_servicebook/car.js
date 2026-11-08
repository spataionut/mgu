'use strict';
/**
 * car.js - the Car page: model, VIN, total km, and a tile per document (RCA, CASCO, Rovinieta, ITP).
 *
 * Where the values come from:
 *   series, body  de.bmw.infrastructure.VehicleInformation.VehicleType (instance 1, notifier only: 's'),
 *                 { typeVehicle: 'G01', typeBody: 'SPORTS_ACTIVITY_VEHICLE', ... } (enum names, as the
 *                 unit's other enums arrive; a number is shown as #n)
 *   model name    the series' name below + what the owner typed (e.g. "M40i"); the car has no model name
 *   VIN           the app's VIN environment variable (set by the OAP platform; the SDK's getVin() reads it)
 *   km            KombiIF.statusRangeTankStatus.mileageKilometre, as on the log page
 * The VIN is shown on the screen only; it's not written to the log file or the app's log.
 */
const { withAlpha } = require('./kit/canvas');
const { DOCS } = require('./store');
const { status, stateColor } = require('./docs');
const { kmText, fit } = require('./form');

const W = 1600, H = 520;
const SERIES = {
    F40: '1 Series', F44: '2 Series Gran Coupe', G42: '2 Series Coupe', G20: '3 Series', G21: '3 Series Touring', G80: 'M3',
    G22: '4 Series Coupe', G23: '4 Series Convertible', G26: '4 Series Gran Coupe', G82: 'M4', G30: '5 Series', G31: '5 Series Touring',
    G32: '6 Series GT', G11: '7 Series', G12: '7 Series', G14: '8 Series Convertible', G15: '8 Series Coupe', G16: '8 Series Gran Coupe',
    F39: 'X2', F48: 'X1', G01: 'X3', G08: 'iX3', F97: 'X3 M', G02: 'X4', F98: 'X4 M', G05: 'X5', F95: 'X5 M', G06: 'X6', F96: 'X6 M',
    G07: 'X7', G29: 'Z4', I20: 'iX',
};
const NUMERIC = { 81: 'G01' };       // typeVehicle as a number: the one this car should send (catalog enum)

/** the series code from VehicleType.typeVehicle (an enum name or number) */
function seriesOf(v) {
    if (v == null) return null;
    if (typeof v === 'number') return NUMERIC[v] || '#' + v;
    const s = String(v);
    return /^(KEINE_ANGABE|SIGNAL_.*)$/.test(s) ? null : s;
}
/** SPORTS_ACTIVITY_VEHICLE -> Sports Activity Vehicle */
function bodyText(v) {
    if (v == null || typeof v === 'number' || /^SIGNAL_/.test(String(v))) return '';
    return String(v).replace(/_MINUS_/g, '-').replace(/^_+/, '').split('_').filter(Boolean)
        .map((w) => (/^\d+$|^X$/.test(w) ? w.toLowerCase() : w[0] + w.slice(1).toLowerCase())).join(' ');
}
function modelName(series, variant) {
    const base = series && SERIES[series] ? 'BMW ' + SERIES[series] : 'BMW';
    return variant ? base + ' ' + variant : base;
}
function vinOf(env) {
    const v = String((env || process.env).VIN || '').trim().toUpperCase();
    return /^[A-HJ-NPR-Z0-9]{17}$/.test(v) ? v : v ? v.slice(0, 20) : '';
}

/**
 * Draw the page on cv. s = { series, body, variant, vin, odo, odoState, docs: { kind: period|null }, own, today }
 * act = { variant(), doc(kind) }: what a tap does (only where cv.own).
 */
function drawCar(cv, t, s, act) {
    // identity
    cv.text('MODEL', 40, 70, 18, t.dim, { font: 'bold', spacing: 1.5 });
    const name = modelName(s.series, s.variant);
    cv.text(fit(cv, name, 40, 760, 'bold'), 40, 118, 40, t.text, { font: 'bold', literal: true });
    const sub = [s.series || 'series not reported yet', s.body].filter(Boolean).join('  ·  ');
    cv.text(sub, 40, 156, 24, t.dim, { literal: true });
    if (s.own) {
        const lw = cv.textWidth(name, 40, { font: 'bold', literal: true });
        const ex = Math.min(40 + lw + 24, 820);
        cv.roundRect(ex, 86, s.variant ? 110 : 200, 44, 22, withAlpha('#ffffff', 0.08));
        cv.strokeRoundRect(ex, 86, s.variant ? 110 : 200, 44, 22, 1.5, withAlpha('#ffffff', 0.22));
        cv.text(s.variant ? 'Edit' : 'Add variant', ex + (s.variant ? 55 : 100), 116, 22, t.text, { align: 'center', font: 'bold' });
        cv.target(40, 76, ex + (s.variant ? 110 : 200) - 40, 90, act.variant, 'variant', 12);
    }
    cv.text('VIN', 1000, 70, 18, t.dim, { font: 'bold', spacing: 1.5 });
    cv.text(s.vin || 'not available', 1000, 108, 32, s.vin ? t.text : t.dim, { font: 'bold', literal: true, spacing: 1 });
    cv.text('TOTAL KM', 1000, 140, 18, t.dim, { font: 'bold', spacing: 1.5 });
    cv.text(s.odo != null ? kmText(s.odo) + ' km' : s.odoState === 'waiting' ? 'waiting for the car' : s.odoState, 1000, 176, 32,
        s.odo != null ? t.text : t.dim, { font: 'bold', literal: true });
    // documents
    const y = 206, gap = 16, w = (W - 80 - 3 * gap) / 4, h = (s.bottom || H - 8) - y;
    DOCS.forEach((d, i) => {
        const kind = d[0], p = s.docs[kind], st = status(p, s.today), col = stateColor(t, st.state), x = 40 + i * (w + gap);
        cv.roundRect(x, y, w, h, 16, withAlpha('#ffffff', 0.05));
        cv.roundRect(x, y, w, 8, 4, col);
        cv.text(d[1], x + 24, y + 54, 30, t.text, { font: 'bold', literal: true });
        cv.text(st.text, x + 24, y + 112, st.state === 'none' ? 30 : 34, col, { font: 'bold', literal: true });
        if (p) {
            cv.text('until ' + p.until, x + 24, y + 156, 24, t.text, { literal: true });
            const who = [p.who, p.number].filter(Boolean).join('  ·  ');
            if (who) cv.text(fit(cv, who, 22, w - 48), x + 24, y + 192, 22, t.dim, { literal: true });
        }
        if (s.own) {
            cv.text(p ? 'Tap to renew or edit' : 'Tap to add', x + 24, y + h - 24, 20, t.dim, { font: 'bold' });
            cv.target(x, y, w, h, () => act.doc(kind), 'doc:' + kind, 16);
        }
    });
}

module.exports = { drawCar, seriesOf, bodyText, modelName, vinOf, SERIES };
