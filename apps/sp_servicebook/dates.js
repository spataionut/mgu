'use strict';
/** dates.js - calendar dates as 'YYYY-MM-DD' strings (local day for today(), plain calendar maths otherwise). */
const pad = (n) => (n < 10 ? '0' : '') + n;
const parts = (s) => s.split('-').map(Number);
const fmt = (d) => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());

function today(now) { const d = now || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function addDays(s, n) { const p = parts(s); return fmt(new Date(Date.UTC(p[0], p[1] - 1, p[2] + n))); }
/** n months later; a day the month doesn't have becomes its last day (01-31 + 1 month = 02-28) */
function addMonths(s, n) {
    const p = parts(s), first = new Date(Date.UTC(p[0], p[1] - 1 + n, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return fmt(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(p[2], last))));
}
/** b - a in days */
function daysBetween(a, b) { const x = parts(a), y = parts(b); return Math.round((Date.UTC(y[0], y[1] - 1, y[2]) - Date.UTC(x[0], x[1] - 1, x[2])) / 864e5); }

module.exports = { today, addDays, addMonths, daysBetween, pad };
