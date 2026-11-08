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
 * Node 8: no fs.promises, no recursive mkdir.
 */
const fs = require('fs');
const path = require('path');

const FILE = 'servicebook.json';
const KEEP = 20;
const TYPES = ['Oil & filter', 'Brakes', 'Spark plugs', 'Tyres', 'Air/cabin filter', 'Fluids', 'Battery', 'Coding/Mods', 'Inspection', 'Other'];

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

function parse(text) {
    const d = JSON.parse(text);
    if (!d || d.schema !== 1 || !Array.isArray(d.entries)) throw new Error('not a Service Book file');
    return d.entries.map(clean);
}

class LogStore {
    constructor(dataDir, log) {
        this.dir = dataDir;
        this.file = path.join(dataDir, FILE);
        this.backups = path.join(dataDir, 'backups');
        this.log = log || { info() {}, warn() {}, error() {} };
        this.entries = [];
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
            this.entries = b ? b.entries : [];
            if (b) { this.warning = 'Log restored from backup ' + b.name; this._write(); }
        } else {
            try { this.entries = parse(text); } catch (e) {
                const bad = this.file + '.corrupt-' + stamp();
                try { fs.renameSync(this.file, bad); } catch (e2) { /* */ }
                const b = this._newestBackup();
                this.entries = b ? b.entries : [];
                this.warning = 'Log file was damaged (' + e.message + '); ' + (b ? 'restored backup ' + b.name : 'no backup found') + '. Kept as ' + path.basename(bad);
                this.log.warn(this.warning);
                this._write();
            }
        }
        this.entries.sort(order);
        this.loaded = true;
        return this.entries;
    }

    _backupNames() {
        try { return fs.readdirSync(this.backups).filter((n) => /^servicebook-.*\.json$/.test(n)).sort(); } catch (e) { return []; }
    }
    _newestBackup() {
        const names = this._backupNames();
        for (let i = names.length - 1; i >= 0; i--) {
            try { return { name: names[i], entries: parse(fs.readFileSync(path.join(this.backups, names[i]), 'utf8')) }; } catch (e) { /* try older */ }
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
        writeAtomic(this.file, JSON.stringify({ schema: 1, app: 'sp_servicebook', saved: new Date().toISOString(), entries: this.entries }, null, 1));
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
}

module.exports = { LogStore, TYPES, clean, parse, KEEP };
