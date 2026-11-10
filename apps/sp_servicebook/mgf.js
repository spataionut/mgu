'use strict';
/**
 * mgf.js - MG Flasher's Custom Code settings over the head unit's own diagnostic link
 * (InternalTasu, kit/diag.js, DME 0x12), the way the MG Flasher app does it over ENET.
 *
 * From a capture of the MG Flasher iPhone app on this car (2026-11-10; tested from the head unit
 * with MGF Test 0.2.1, map write confirmed):
 *   set     2E 69 <id> <value> <sum>, sum = 69 + id + value. The DME answers 7F 2E 69: MG Flasher's
 *           code takes the request and the stock handler still refuses it, so that is expected.
 *   state   23 44 <address> <length>: the RAM where MG Flasher keeps each setting.
 *   taken   23 44 60107F14 2 -> <id> 69: the id of the last command MG Flasher's code took.
 * The addresses belong to this MG Flasher build and may move after an MG Flasher update: before
 * any write the state must read sane (every value in range, the last id ending in 69), else the
 * page is info only.
 *
 * What may leave the head unit is fixed here: check() throws for anything but these reads and
 * these writes (each feature's own values only) to the DME. The Diag is private to this module.
 * Nothing is sent until the Custom Code page is opened (start()).
 */
const DME = 0x12;
/* the same order as customcode.js FEATURES */
const FEATURES = [
    { key: 'map', id: 0x45, addr: 0x60107F32, len: 2, values: 3 },
    { key: 'cooling', id: 0x47, addr: 0x60107F98, len: 1, values: 2 },
    { key: 'flap', id: 0x49, addr: 0x60107F6F, len: 1, values: 3 },
    { key: 'valet', id: 0x4A, addr: 0x60107FC7, len: 1, values: 2 },
];
const LAST = { addr: 0x60107F14, len: 2 };
const TIMEOUT_MS = 3000;
const GAP_MS = 60;
const SETTLE_MS = 250;            // MG Flasher reads the new state ~200 ms after the write

const be4 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const hex = (b) => (b || []).map((x) => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readReq = (r) => [0x44].concat(be4(r.addr), be4(r.len));
const writeReq = (f, v) => [0x69, f.id, v, (0x69 + f.id + v) & 0xFF];

const ALLOWED = {};
FEATURES.concat([LAST]).forEach((r) => { ALLOWED[hex([0x23].concat(readReq(r)))] = true; });
FEATURES.forEach((f) => { for (let v = 0; v < f.values; v++) ALLOWED[hex([0x2E].concat(writeReq(f, v)))] = true; });

/** Throws unless (target, sid, data) is one of the fixed requests. Exported for the tests. */
function check(target, sid, data) {
    if (target !== DME) throw new Error('mgf: only the DME may be asked');
    const req = hex([sid].concat(data || []));
    if (!ALLOWED[req]) throw new Error('mgf: not an allowed request: ' + req);
}
const answers = (sid) => (u) => u[0] === sid + 0x40 || (u[0] === 0x7F && u[1] === sid);

class MgfLink {
    /**
     * makeDiag() -> a kit Diag (or a stand-in), made on start(); log: ctx.log; onChange(): redraw.
     * state: link 'off' (not started) / 'starting' / 'ok' / 'none' (no answer) / 'unknown' (answers
     * that don't look like this MG Flasher build); values[i] (null = not read); note (why not ok).
     */
    constructor(makeDiag, log, onChange) {
        let diag = null;
        this._start = async () => { diag = makeDiag(); if (diag.init) await diag.init(); return !diag.error; };
        this._send = (sid, data) => { check(DME, sid, data); return diag.physical(DME, sid, data, TIMEOUT_MS, answers(sid), { maxRetries: 2 }); };
        this.log = log || { info() {}, warn() {}, error() {} };
        this.onChange = onChange || (() => {});
        this.link = 'off';
        this.note = '';
        this.values = FEATURES.map(() => null);
        this.busy = false;
        this.result = null;           // { i, v, ok, text } of the last set
        this.readAt = 0;
    }

    get writable() { return this.link === 'ok' && !this.busy; }

    async start() {
        if (this.link !== 'off') return;
        this.link = 'starting'; this.onChange();
        try {
            if (!(await this._start())) { this.link = 'none'; this.note = 'no diagnostic link'; this.onChange(); return; }
        } catch (e) { this.link = 'none'; this.note = String(e.message || e); this.onChange(); return; }
        await this.refresh();
    }

    async _read(r) {
        const u = await this._send(0x23, readReq(r));
        if (!u) return { error: 'no answer' };
        if (u[0] !== 0x63 || u.length < 1 + r.len) return { error: u[0] === 0x7F ? 'refused (' + hex([u[2]]) + ')' : 'unexpected ' + hex(u) };
        return { bytes: u.slice(1, 1 + r.len) };
    }

    /** the value a state read holds, or null when it isn't one MG Flasher's code would keep */
    static valueOf(f, b) {
        if (!b || b[0] >= f.values) return null;
        if (f.len === 2 && b[1] !== 0) return null;
        return b[0];
    }

    /** Read every setting (and the last id, as the sanity check). Returns true when all read sane. */
    async refresh() {
        if (this.busy || this.link === 'off') return false;
        this.busy = true;
        try {
            let answered = 0, sane = true, why = '';
            for (let i = 0; i < FEATURES.length; i++) {
                const f = FEATURES[i];
                let r;
                try { r = await this._read(f); } catch (e) { r = { error: String(e.message || e) }; }
                if (r.bytes) answered++;
                const v = r.bytes ? MgfLink.valueOf(f, r.bytes) : null;
                if (r.bytes && v === null) { sane = false; why = why || f.key + ' reads ' + hex(r.bytes); }
                if (r.error) { sane = false; why = why || f.key + ': ' + r.error; }
                this.values[i] = v;
                await sleep(GAP_MS);
            }
            let last;
            try { last = await this._read(LAST); } catch (e) { last = { error: String(e.message || e) }; }
            if (last.bytes) answered++;
            if (!last.bytes || last.bytes[1] !== 0x69) { sane = false; why = why || 'last command ' + (last.error || hex(last.bytes)); }
            this.link = sane ? 'ok' : answered ? 'unknown' : 'none';
            this.note = sane ? '' : why;
            this.readAt = Date.now();
            if (!sane) this.log.warn('mgf: ' + this.link + ': ' + why);
            return sane;
        } finally {
            this.busy = false;
            this.onChange();
        }
    }

    /**
     * Set feature i to value v as MG Flasher does, then confirm it as MG Flasher does: the last id
     * must read <id> 69 and the setting must read v. gate() -> { ok, why } is asked right before
     * the write. Resolves with this.result: { i, v, ok, text }.
     */
    async set(i, v, gate) {
        const f = FEATURES[i];
        const done = (ok, text) => {
            this.result = { i, v, ok, text, at: Date.now() };
            this.log.info('mgf set ' + (f ? f.key : i) + '=' + v + ': ' + text);
            this.onChange();
            return this.result;
        };
        if (!f || !(v >= 0 && v < f.values)) return done(false, 'not a value of this setting');
        if (this.link !== 'ok') return done(false, 'not available: ' + (this.note || this.link));
        if (this.busy) return done(false, 'busy, try again');
        const g = gate ? gate() : { ok: false, why: 'no car check' };
        if (!g.ok) return done(false, 'not now: ' + g.why);
        this.busy = true;
        this.result = { i, v, ok: null, text: 'sending', at: Date.now() };
        this.onChange();
        try {
            let reply;
            try { reply = await this._send(0x2E, writeReq(f, v)); } catch (e) { return done(false, 'not sent: ' + (e.message || e)); }
            if (reply && !(reply[0] === 0x6E || (reply[0] === 0x7F && reply[1] === 0x2E && reply[2] === 0x69))) {
                return done(false, 'the DME refused it (' + hex(reply) + ')');
            }
            await sleep(GAP_MS);
            let last, now;
            try { last = await this._read(LAST); } catch (e) { last = { error: String(e.message || e) }; }
            await sleep(SETTLE_MS);
            try { now = await this._read(f); } catch (e) { now = { error: String(e.message || e) }; }
            const nv = now.bytes ? MgfLink.valueOf(f, now.bytes) : null;
            if (now.bytes) this.values[i] = nv;
            const took = last.bytes && last.bytes[0] === f.id && last.bytes[1] === 0x69;
            if (took && nv === v) return done(true, 'confirmed');
            return done(false, 'not confirmed (' + (took ? 'taken, but it reads ' + (nv === null ? hex(now.bytes) || now.error : nv) : 'not taken: last ' + (last.error || hex(last.bytes))) + ')');
        } finally {
            this.busy = false;
            this.onChange();
        }
    }
}

module.exports = { MgfLink, FEATURES, check, ALLOWED, DME };
