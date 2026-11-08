'use strict';
/**
 * importer.js - import service history and documents from a USB stick.
 *
 * The app looks for servicebook-import.json at the top of every stick mounted under /media
 * (the unit mounts sticks there, read-only for apps). Reading it changes nothing: plan() checks
 * every item and works out what is new, and only store.applyImport() writes, in one atomic write
 * (the store keeps the file as it was in backups/ first). Items already in the log are skipped,
 * so importing the same file twice adds nothing the second time.
 *
 * The file (all keys optional except the marker):
 *   {
 *     "servicebookImport": 1,
 *     "variant": "M40i",
 *     "entries": [ { "date": "2025-04-12", "km": 18500, "type": "Oil & filter",
 *                    "cost": "1200 lei", "workshop": "...", "notes": "..." } ],
 *     "docs": { "rca": [ { "from": "2026-07-03", "until": "2027-07-02", "who": "...", "number": "...", "cost": "..." } ],
 *               "casco": [...], "rovinieta": [...], "itp": [ { ..., "km": 20000 } ] }
 *   }
 * The app's own servicebook.json (schema 1) is accepted too.
 *
 * On the Mac:  node apps/sp_servicebook/importer.js <file>   checks a file the way the car will.
 */
const fs = require('fs');
const path = require('path');
const { TYPES, DOCS, clean, cleanPeriod } = require('./store');

const NAME = 'servicebook-import.json';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ERRORS = 20;

/** Directories under /media that may be sticks: the mounts listed in /proc/mounts, then /media's own folders. */
function stickDirs(root) {
    root = root || '';
    const out = [];
    const add = (d) => { if (out.indexOf(d) < 0) out.push(d); };
    try {
        fs.readFileSync(root + '/proc/mounts', 'utf8').split('\n').forEach((l) => {
            const f = l.split(' ');
            if (f[1] && f[1].indexOf('/media/') === 0) add(root + f[1].replace(/\\040/g, ' '));
        });
    } catch (e) { /* no /proc here */ }
    try { fs.readdirSync(root + '/media').forEach((n) => add(path.join(root + '/media', n))); } catch (e) { /* none */ }
    return out;
}

/**
 * Look for the import file on every stick. Returns { files: [path], tried: [{ dir, result }] }:
 * tried says, per folder, what happened (found / not there / the error), to show when nothing is found.
 */
function find(root) {
    const files = [], tried = [];
    stickDirs(root).forEach((dir) => {
        let names;
        try { names = fs.readdirSync(dir); } catch (e) { tried.push({ dir, result: e.code || e.message }); return; }
        const hit = names.find((n) => n.toLowerCase() === NAME);     // FAT may show it in another case
        if (hit) { files.push(path.join(dir, hit)); tried.push({ dir, result: 'found' }); } else tried.push({ dir, result: 'no ' + NAME + ' (' + names.length + ' items)' });
    });
    return { files, tried };
}

function read(file) {
    const st = fs.statSync(file);
    if (st.size > MAX_BYTES) throw new Error('file is too big (' + st.size + ' bytes)');
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);      // a BOM from some editors
    try { return JSON.parse(text); } catch (e) { throw new Error('not valid JSON: ' + e.message); }
}

const TYPE_BY_LOWER = {};
TYPES.forEach((t) => { TYPE_BY_LOWER[t.toLowerCase()] = t; });
/** a date that exists in the calendar, 1990..2100 */
function realDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
    const p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return p[0] >= 1990 && p[0] <= 2100 && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}
const entryKey = (e) => e.date + '|' + e.type + '|' + (e.km == null ? '' : e.km);
const periodKey = (p) => (p.from || '') + '|' + p.until;

/**
 * Check data against what the store already has. Returns
 * { ok, errors: [text], entries: [new], docs: { kind: [new] }, variant, skipped, counts }.
 * ok is false if anything is wrong: then nothing should be imported.
 */
function plan(data, store) {
    const errors = [];
    const err = (s) => { if (errors.length < MAX_ERRORS) errors.push(s); };
    const res = { ok: false, errors, entries: [], docs: {}, variant: null, skipped: 0 };
    if (!data || typeof data !== 'object') { err('the file is not a JSON object'); return res; }
    let entries, docs, variant;
    if (data.schema === 1 && Array.isArray(data.entries)) {          // the app's own file
        entries = data.entries; docs = (data.car && data.car.docs) || {}; variant = data.car && data.car.variant;
    } else if (data.servicebookImport === 1) {
        entries = data.entries || []; docs = data.docs || {}; variant = data.variant;
    } else { err('not a Service Book import file (needs "servicebookImport": 1)'); return res; }
    if (!Array.isArray(entries)) err('"entries" must be a list');
    if (!docs || typeof docs !== 'object' || Array.isArray(docs)) err('"docs" must be an object');
    if (errors.length) return res;

    const have = {};
    store.entries.forEach((e) => { have[entryKey(e)] = true; });
    entries.forEach((e, i) => {
        const where = 'entry ' + (i + 1) + (e && e.date ? ' (' + e.date + ')' : '');
        if (!e || typeof e !== 'object') { err(where + ': not an object'); return; }
        const type = TYPE_BY_LOWER[String(e.type || '').trim().toLowerCase()];
        if (!type) { err(where + ': unknown type "' + e.type + '"'); return; }
        let c;
        try { c = clean(Object.assign({}, e, { id: null, type, created: null, updated: null })); } catch (x) { err(where + ': ' + x.message); return; }
        if (!realDate(c.date)) { err(where + ': no such date ' + c.date); return; }
        if (have[entryKey(c)]) { res.skipped++; return; }
        have[entryKey(c)] = true;
        res.entries.push(c);
    });
    const kinds = DOCS.map((d) => d[0]);
    Object.keys(docs).forEach((k) => { if (kinds.indexOf(k) < 0) err('docs: unknown document "' + k + '"; use ' + kinds.join(', ')); });
    kinds.forEach((k) => {
        res.docs[k] = [];
        const list = docs[k] == null ? [] : docs[k];
        if (!Array.isArray(list)) { err('docs.' + k + ' must be a list'); return; }
        const seen = {};
        (store.car.docs[k] || []).forEach((p) => { seen[periodKey(p)] = true; });
        list.forEach((p, i) => {
            const where = k.toUpperCase() + ' ' + (i + 1);
            let c;
            try { c = cleanPeriod(Object.assign({}, p, { id: null, created: null, updated: null })); } catch (x) { err(where + ': ' + x.message); return; }
            const badDate = [c.from, c.until].filter((d) => d && !realDate(d))[0];
            if (badDate) { err(where + ': no such date ' + badDate); return; }
            if (seen[periodKey(c)]) { res.skipped++; return; }
            seen[periodKey(c)] = true;
            res.docs[k].push(c);
        });
    });
    if (variant != null && String(variant).trim() && String(variant).trim() !== store.car.variant) res.variant = String(variant).trim().slice(0, 60);
    res.counts = { entries: res.entries.length, periods: kinds.reduce((a, k) => a + res.docs[k].length, 0) };
    res.ok = !errors.length;
    res.empty = res.ok && !res.counts.entries && !res.counts.periods && res.variant == null;
    return res;
}

module.exports = { NAME, stickDirs, find, read, plan };

/* node importer.js <file>: check a file on the Mac against an empty log */
if (require.main === module) {
    const file = process.argv[2];
    if (!file) { console.error('usage: node importer.js servicebook-import.json'); process.exit(2); }
    try {
        const p = plan(read(file), { entries: [], car: { variant: '', docs: {} } });
        if (!p.ok) {
            console.error('problems:\n  ' + p.errors.join('\n  '));
            if (p.errors.some((x) => /unknown type/.test(x))) console.error('types: ' + TYPES.join(', '));
            process.exit(1);
        }
        console.log('ok: ' + p.counts.entries + ' entries, ' + p.counts.periods + ' document periods' + (p.variant ? ', variant ' + p.variant : '') +
            (p.skipped ? ', ' + p.skipped + ' duplicates in the file' : ''));
        DOCS.forEach((d) => { if (p.docs[d[0]].length) console.log('  ' + d[1] + ': ' + p.docs[d[0]].map((x) => (x.from || '?') + ' .. ' + x.until).join(', ')); });
    } catch (e) { console.error(e.message); process.exit(1); }
}
