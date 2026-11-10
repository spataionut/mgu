'use strict';
/**
 * reader.js - READ-ONLY look at MG Flasher's Custom Code state in the DME, over the head unit's own
 * diagnostic link (InternalTasu, kit/diag.js), to learn whether the DME answers the head unit at all.
 *
 * What may leave the head unit is fixed here and nothing else: check() throws for anything that is
 * not one of these requests to the DME (0x12):
 *   22 F1 50                                  the DME's SGBD index (which DME this is)
 *   23 44 <address(4)> <length(4)>            ReadMemoryByAddress, only the addresses in READS
 *   2E 69 45 <slot> <sum>                     0.2.0: MG Flasher's map switch, slot 0 or 2 only
 *                                             (sum = 69 + 45 + slot), sent by setMap() alone
 * No other write, no routine (31), no session (10), no I/O control (2F), no functional request.
 * The Diag underneath is private to this module.
 *
 * READS come from a capture of the MG Flasher iPhone app on this car (2026-11-10,
 * the owner's notes; the same addresses as Service Book's mgf.js): the RAM where MG Flasher's code keeps each feature's state.
 * They belong to this MG Flasher build and may move after an MG Flasher update.
 */
const DME = 0x12;
const READS = [
    { key: 'map', label: 'Map', addr: 0x60107F32, len: 2, names: ['slot 0 · 100 RON', 'slot 1 · 95 RON', 'slot 2 · stock'] },
    { key: 'cooling', label: 'Max Cooling', addr: 0x60107F98, len: 1, names: ['off', 'on'] },
    { key: 'flap', label: 'Exhaust Flap', addr: 0x60107F6F, len: 1, names: ['automatic', 'closed', 'opened'] },
    { key: 'valet', label: 'Valet Mode', addr: 0x60107FC7, len: 1, names: ['off', 'on'] },
    { key: 'ack', label: 'Last command taken', addr: 0x60107F64, len: 1 },
    { key: 'last', label: 'Last command id', addr: 0x60107F14, len: 2 },
];
const IDENT = [0xF1, 0x50];
const GAP_MS = 100;
const TIMEOUT_MS = 3000;

const be4 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const hex = (b) => (b || []).map((x) => (x < 16 ? '0' : '') + x.toString(16).toUpperCase()).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readRequest(r) { return [0x44].concat(be4(r.addr), be4(r.len)); }
const MAP_ID = 0x45;
const MAP_SLOTS = [0, 2];                 // 0.2.0 test: 100 RON max power and stock only
function mapWrite(slot) { return [0x69, MAP_ID, slot, (0x69 + MAP_ID + slot) & 0xFF]; }
const ALLOWED = [[0x22].concat(IDENT)].concat(READS.map((r) => [0x23].concat(readRequest(r))))
    .concat(MAP_SLOTS.map((v) => [0x2E].concat(mapWrite(v)))).map((b) => hex(b));
const READ_BY_KEY = {};
READS.forEach((r) => { READ_BY_KEY[r.key] = r; });
/** this request's answer, or a refusal of its service (no other app talks to the DME, but be strict) */
const answers = (sid) => (u) => u[0] === sid + 0x40 || (u[0] === 0x7F && u[1] === sid);

/** Throws unless (target, sid, data) is one of the fixed reads above. Exported for the tests. */
function check(target, sid, data) {
    if (target !== DME) throw new Error('read-only: only the DME (12) may be asked');
    const req = hex([sid].concat(data || []));
    if (ALLOWED.indexOf(req) < 0) throw new Error('read-only: not an allowed request: ' + req);
}

/** What a reply means, for the screen. */
function decode(r, uds) {
    if (!uds) return { ok: false, text: 'no answer' };
    if (uds[0] === 0x7F) return { ok: false, text: 'refused, NRC ' + hex([uds[2]]) };
    if (uds[0] !== 0x63 || uds.length < 1 + r.len) return { ok: false, text: 'unexpected ' + hex(uds) };
    const v = uds.slice(1, 1 + r.len);
    if (r.key === 'last') return { ok: true, value: v, text: hex(v) + (v[1] === 0x69 ? ' (= 69 ' + hex([v[0]]) + ')' : '') };
    if (r.key === 'ack') return { ok: true, value: v, text: String(v[0]) };
    const n = v[0];
    return { ok: true, value: v, text: (r.names && r.names[n]) || ('value ' + n), raw: hex(v) };
}

class Reader {
    /** diag: a kit Diag (or a stand-in with physical()), private to this object */
    constructor(diag, log) {
        const d = diag;
        this._send = (sid, data) => { check(DME, sid, data); return d.physical(DME, sid, data, TIMEOUT_MS, answers(sid), { maxRetries: 2 }); };
        this.log = log || { info() {}, warn() {} };
        this.busy = false;
    }

    /** One pass: the DME's identity, then every READS entry. onStep(key, result) as each arrives. */
    async readAll(onStep) {
        if (this.busy) return null;
        this.busy = true;
        const out = {};
        try {
            const t0 = Date.now();
            let ident;
            try { ident = await this._send(0x22, IDENT); } catch (e) { ident = { error: String(e.message || e) }; }
            out.ident = ident && ident.error ? { ok: false, text: ident.error }
                : !ident ? { ok: false, text: 'no answer' }
                    : ident[0] === 0x62 ? { ok: true, text: 'SGBD index ' + hex(ident.slice(3, 6)).replace(/ /g, ''), ms: Date.now() - t0 }
                        : { ok: false, text: 'refused ' + hex(ident) };
            this.log.info('ident: ' + out.ident.text);
            if (onStep) onStep('ident', out.ident);
            for (const r of READS) {
                await sleep(GAP_MS);
                const t = Date.now();
                let res;
                try { res = decode(r, await this._send(0x23, readRequest(r))); } catch (e) { res = { ok: false, text: String(e.message || e) }; }
                res.ms = Date.now() - t;
                out[r.key] = res;
                this.log.info(r.key + ': ' + res.text + (res.raw ? ' [' + res.raw + ']' : '') + ' (' + res.ms + ' ms)');
                if (onStep) onStep(r.key, res);
            }
        } finally {
            this.busy = false;
        }
        return out;
    }
}

Reader.prototype.read = async function (key) {
    const r = READ_BY_KEY[key];
    const t = Date.now();
    let res;
    try { res = decode(r, await this._send(0x23, readRequest(r))); } catch (e) { res = { ok: false, text: String(e.message || e) }; }
    res.ms = Date.now() - t;
    return res;
};

/**
 * Switch MG Flasher's map to slot (0 or 2) the way the MG Flasher app does, then confirm it the
 * way it does. gate() -> { ok, why } is asked right before sending (the car's state). Returns
 * { sent, confirmed, steps: [text], map }. The DME answers the write 7F 2E 69 (MG Flasher's code
 * takes it, the stock handler refuses it): that is expected, not a failure. Confirmed only when
 * the last command id reads 45 69 AND the map reads the new slot.
 */
Reader.prototype.setMap = async function (slot, gate) {
    const steps = [];
    const out = { sent: false, confirmed: false, steps };
    if (MAP_SLOTS.indexOf(slot) < 0) { steps.push('slot ' + slot + ' is not allowed in this test'); return out; }
    if (this.busy) { steps.push('busy, try again'); return out; }
    this.busy = true;
    try {
        const g = gate ? gate() : { ok: false, why: 'no car check' };
        if (!g.ok) { steps.push('not sent: ' + g.why); return out; }
        const req = mapWrite(slot);
        this.log.info('map write: 2E ' + hex(req));
        let reply;
        try { reply = await this._send(0x2E, req); } catch (e) { steps.push('not sent: ' + (e.message || e)); return out; }
        out.sent = true;
        steps.push('write ' + (!reply ? 'no answer' : hex(reply) + (reply[0] === 0x7F && reply[2] === 0x69 ? ' (expected)' : reply[0] === 0x6E ? ' (positive)' : ' (unexpected)')));
        await sleep(GAP_MS);
        const last = await this.read('last');
        const took = last.ok && last.value[0] === MAP_ID && last.value[1] === 0x69;
        steps.push('last command ' + last.text + (took ? ' = map, taken' : ' (not the map)'));
        await sleep(250);                         // MG Flasher reads the state ~200 ms later
        const map = await this.read('map');
        out.map = map;
        const now = map.ok ? map.value[0] : null;
        steps.push('map now ' + map.text);
        out.confirmed = took && now === slot;
        this.log.info('map write ' + slot + ': ' + steps.join('; ') + (out.confirmed ? ' -> CONFIRMED' : ' -> NOT confirmed'));
        return out;
    } finally {
        this.busy = false;
    }
};

module.exports = { Reader, READS, check, decode, ALLOWED, DME, MAP_SLOTS, mapWrite };
