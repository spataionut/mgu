'use strict';
/**
 * store.js - the service log on disk, written so that a crash or power loss mid-write can't lose it.
 *
 *   <dataDir>/servicebook.json            { schema: 1, entries: [ ... ] }
 *   <dataDir>/backups/servicebook-<t>.json the file as it was before each of the last KEEP writes
 *
 * A write goes to a temp file, is fsynced, then renamed over the real one (rename is atomic on one
 * filesystem), then the folder is fsynced. A main file that can't be parsed on load is kept as
 * servicebook.json.corrupt-<t> and the newest backup that parses is used instead (warning set).
 *
 * Entry: { id, date: 'YYYY-MM-DD', km: number|null, type, notes, cost, workshop, created, updated }
 * Car (0.2.0; absent in 0.1.0 files): { variant, docs: { rca: [period], casco, rovinieta, itp } }
 * Period: { id, from, until ('YYYY-MM-DD' or ''), who (insurer / ITP station), number, cost, km, created, updated },
 * newest first; the first one is the current one.
 * Node 8: no fs.promises, no recursive mkdir.
 */
const fs = require('fs');
const path = require('path');

const FILE = 'servicebook.json';
const KEEP = 20;
const TYPES = ['Oil & filter', 'Brakes', 'Spark plugs', 'Tyres', 'Air/cabin filter', 'Fluids', 'Battery', 'Coding/Mods', 'Inspection', 'Other'];

const DOCS = [['rca', 'RCA'], ['casco', 'CASCO'], ['rovinieta', 'Rovinieta'], ['itp', 'ITP']];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const stamp = (d) => (d || new Date()).toISOString().replace(/[-:.]/g, '');      // 20261108T120000123Z: sorts by time
function mkdir(p) { try { fs.mkdirSync(p); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
function fsyncDir(dir) {
    let fd = null;
    try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch (e) { /* not on every filesystem */ } finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* */ } }
}
function writeAtomic(file, text) {
    const tmp = file + '.tmp-' + process.pid;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    fsyncDir(path.dirname(file));
}

/** Check one entry; returns a clean copy or throws. */
function clean(e) {
    if (!e || typeof e !== 'object') throw new Error('entry is not an object');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.date))) throw new Error('bad date: ' + e.date);
    const km = e.km === '' || e.km == null ? null : Number(e.km);
    if (km !== null && (!isFinite(km) || km < 0 || km > 2e6)) throw new Error('bad km: ' + e.km);
    const str = (v, n) => String(v == null ? '' : v).slice(0, n);
    return {
        id: str(e.id, 40) || newId(),
        date: String(e.date), km: km === null ? null : Math.round(km),
        type: TYPES.indexOf(e.type) >= 0 ? e.type : 'Other',
        notes: str(e.notes, 500), cost: str(e.cost, 40), workshop: str(e.workshop, 80),
        created: e.created || new Date().toISOString(), updated: e.updated || e.created || new Date().toISOString(),
    };
}
let seq = 0;
function newId() { return Date.now().toString(36) + '-' + (++seq).toString(36); }
const order = (a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : (b.km || 0) - (a.km || 0) || (a.created < b.created ? 1 : -1));

function cleanPeriod(p) {
    if (!p || typeof p !== 'object') throw new Error('period is not an object');
    if (p.from && !DATE.test(p.from)) throw new Error('bad date: ' + p.from);
    if (!DATE.test(String(p.until))) throw new Error('bad date: ' + p.until);
    if (p.from && p.from > p.until) throw new Error('valid from is after valid until');
    const km = p.km === '' || p.km == null ? null : Number(p.km);
    if (km !== null && (!isFinite(km) || km < 0 || km > 2e6)) throw new Error('bad km: ' + p.km);
    const str = (v, n) => String(v == null ? '' : v).slice(0, n);
    return {
        id: str(p.id, 40) || newId(), from: p.from || '', until: p.until,
        who: str(p.who, 80), number: str(p.number, 60), cost: str(p.cost, 40), km: km === null ? null : Math.round(km),
        created: p.created || new Date().toISOString(), updated: p.updated || p.created || new Date().toISOString(),
    };
}
const byUntil = (a, b) => (a.until !== b.until ? (a.until < b.until ? 1 : -1) : (a.created < b.created ? 1 : -1));
function cleanCar(c) {
    c = c && typeof c === 'object' ? c : {};
    const docs = {};
    DOCS.forEach((d) => { docs[d[0]] = (c.docs && Array.isArray(c.docs[d[0]]) ? c.docs[d[0]] : []).map(cleanPeriod).sort(byUntil); });
    return { variant: String(c.variant == null ? '' : c.variant).slice(0, 60), docs };
}
function parse(text) {
    const d = JSON.parse(text);
    if (!d || d.schema !== 1 || !Array.isArray(d.entries)) throw new Error('not a Service Book file');
    return { entries: d.entries.map(clean), car: cleanCar(d.car) };
}

class LogStore {
    constructor(dataDir, log) {
        this.dir = dataDir;
        this.file = path.join(dataDir, FILE);
        this.backups = path.join(dataDir, 'backups');
        this.log = log || { info() {}, warn() {}, error() {} };
        this.entries = [];
        this.car = cleanCar(null);
        this.warning = '';
        this.loaded = false;
    }

    load() {
        mkdir(this.dir); mkdir(this.backups);
        let text = null;
        try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') this.log.warn('read log: ' + e.message); }
        if (text === null) {
            // no main file: a write may have stopped between backup and rename; a backup has the data
            const b = this._newestBackup();
            this._use(b);
            if (b) { this.warning = 'Log restored from backup ' + b.name; this._write(); }
        } else {
            try { this._use(parse(text)); } catch (e) {
                const bad = this.file + '.corrupt-' + stamp();
                try { fs.renameSync(this.file, bad); } catch (e2) { /* */ }
                const b = this._newestBackup();
                this._use(b);
                this.warning = 'Log file was damaged (' + e.message + '); ' + (b ? 'restored backup ' + b.name : 'no backup found') + '. Kept as ' + path.basename(bad);
                this.log.warn(this.warning);
                this._write();
            }
        }
        this.entries.sort(order);
        this.loaded = true;
        return this.entries;
    }

    _use(d) { this.entries = d ? d.entries : []; this.car = d ? d.car : cleanCar(null); }

    _backupNames() {
        try { return fs.readdirSync(this.backups).filter((n) => /^servicebook-.*\.json$/.test(n)).sort(); } catch (e) { return []; }
    }
    _newestBackup() {
        const names = this._backupNames();
        for (let i = names.length - 1; i >= 0; i--) {
            try { return Object.assign({ name: names[i] }, parse(fs.readFileSync(path.join(this.backups, names[i]), 'utf8'))); } catch (e) { /* try older */ }
        }
        return null;
    }
    _write() {
        // keep the current file as a backup first (copy, so the main file is never missing)
        try {
            const cur = fs.readFileSync(this.file);
            const at = stamp();
            let n = 0, name;
            do name = 'servicebook-' + at + '-' + ('00' + (n++)).slice(-3) + '.json'; while (fs.existsSync(path.join(this.backups, name)));
            writeAtomic(path.join(this.backups, name), cur);
        } catch (e) { if (e.code !== 'ENOENT') this.log.warn('backup: ' + e.message); }
        writeAtomic(this.file, JSON.stringify({ schema: 1, app: 'sp_servicebook', saved: new Date().toISOString(), entries: this.entries, car: this.car }, null, 1));
        const names = this._backupNames();
        names.slice(0, Math.max(0, names.length - KEEP)).forEach((n) => { try { fs.unlinkSync(path.join(this.backups, n)); } catch (e) { /* */ } });
    }

    /** Add or replace (same id) an entry; writes before returning. Returns the stored entry. */
    save(entry) {
        const now = new Date().toISOString();
        const old = entry.id ? this.entries.find((e) => e.id === entry.id) : null;
        const e = clean(Object.assign({}, entry, { created: old ? old.created : now, updated: now }));
        const next = this.entries.filter((x) => x.id !== e.id).concat([e]).sort(order);
        const prev = this.entries;
        this.entries = next;
        try { this._write(); } catch (err) { this.entries = prev; throw err; }
        return e;
    }
    remove(id) {
        const prev = this.entries;
        this.entries = prev.filter((e) => e.id !== id);
        if (this.entries.length === prev.length) return false;
        try { this._write(); } catch (err) { this.entries = prev; throw err; }
        return true;
    }

    /* ---------- car details ---------- */
    _commitCar(change) {
        const prev = this.car, next = JSON.parse(JSON.stringify(prev));
        const out = change(next);
        this.car = cleanCar(next);
        try { this._write(); } catch (err) { this.car = prev; throw err; }
        return out;
    }
    setVariant(v) { return this._commitCar((c) => { c.variant = String(v || '').trim(); }); }
    /** The current period of a document (or null). */
    current(kind) { return (this.car.docs[kind] || [])[0] || null; }
    /** Add a period, or replace the one with the same id. Returns the stored period. */
    saveDoc(kind, period) {
        if (!this.car.docs[kind]) throw new Error('unknown document ' + kind);
        const now = new Date().toISOString();
        const old = period.id ? this.car.docs[kind].find((p) => p.id === period.id) : null;
        const p = cleanPeriod(Object.assign({}, period, { created: old ? old.created : now, updated: now }));
        this._commitCar((c) => { c.docs[kind] = c.docs[kind].filter((x) => x.id !== p.id).concat([p]); });
        return p;
    }
    /** Add what importer.plan() found new, in one write (all or nothing). Returns the counts. */
    applyImport(p) {
        if (!p || !p.ok) throw new Error('the import has problems');
        const prevE = this.entries, prevC = this.car;
        const now = new Date().toISOString();
        const stampIt = (x) => Object.assign({}, x, { created: now, updated: now });
        this.entries = prevE.concat(p.entries.map((e) => clean(stampIt(e)))).sort(order);
        const car = JSON.parse(JSON.stringify(prevC));
        DOCS.forEach((d) => { car.docs[d[0]] = car.docs[d[0]].concat((p.docs[d[0]] || []).map((x) => cleanPeriod(stampIt(x)))); });
        if (p.variant != null) car.variant = p.variant;
        this.car = cleanCar(car);
        try { this._write(); } catch (err) { this.entries = prevE; this.car = prevC; throw err; }
        return p.counts;
    }
    removeDoc(kind, id) {
        if (!this.car.docs[kind] || !this.car.docs[kind].some((p) => p.id === id)) return false;
        this._commitCar((c) => { c.docs[kind] = c.docs[kind].filter((x) => x.id !== id); });
        return true;
    }
}

module.exports = { LogStore, TYPES, DOCS, clean, cleanPeriod, parse, KEEP };
