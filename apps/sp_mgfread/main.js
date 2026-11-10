'use strict';
/**
 * MGF Test: does the DME answer the head unit's diagnostic link, and can the head unit switch
 * MG Flasher's map the way the MG Flasher app does?
 *
 * - Reads (reader.js, fixed list): when the link is up, and on "Read again".
 * - 0.2.0: one write, the map to slot 0 or slot 2. A button arms it; a second tap within 5 s sends
 *   it, and only if carstate.js says the car is stationary with the engine running and not in
 *   R / N / D. Then it is confirmed by reading the last command id and the map back.
 * Every request passes reader.js check() first. Results also go to the app's log. Node 8.
 */
const mgu = require('./kit/mgu');
const { Diag } = require('./kit/diag');
const { Reader, READS } = require('./reader');
const { CarState } = require('./carstate');

const ROW = { ident: 'T_IDENT', map: 'T_MAP', cooling: 'T_COOLING', flap: 'T_FLAP', valet: 'T_VALET', ack: 'T_ACK', last: 'T_LAST' };
const LABEL = { ident: 'DME' };
READS.forEach((r) => { LABEL[r.key] = r.label; });
const ARM_MS = 5000;
const SLOT_NAME = { 0: 'slot 0 (100 RON)', 2: 'slot 2 (stock)' };

function show(ctx, key, res) {
    ctx.ui.text(ROW[key], LABEL[key] + ': ' + (res.ok ? '' : 'x ') + res.text + (res.raw ? '  [' + res.raw + ']' : '') + (res.ms != null ? '  (' + res.ms + ' ms)' : ''));
}

mgu.run({
    async start(ctx) {
        let reader = null;
        const car = new CarState();
        const say = (id, t) => { try { ctx.ui.text(id, t); } catch (e) { ctx.log.error('ui', e); } };

        const pass = (why) => {
            if (!reader || reader.busy) return;
            say('T_STATUS', 'Reading (' + why + ')...');
            reader.readAll((k, r) => { try { show(ctx, k, r); } catch (e) { ctx.log.error('show', e); } })
                .then((out) => {
                    if (!out) return;
                    const n = Object.keys(out).filter((k) => out[k].ok).length;
                    say('T_STATUS', 'Read: ' + n + ' of ' + Object.keys(out).length + ' answered.');
                })
                .catch((e) => { ctx.log.error('read', e); say('T_STATUS', 'Read failed: ' + (e.message || e)); });
        };

        // the map write: first tap arms, a second tap on the same button within ARM_MS sends
        let armed = null;
        const mapButton = (slot) => () => {
            try {
                if (!reader) { say('T_WRITE', 'Map write: no diagnostic link'); return Promise.resolve(); }
                if (reader.busy) { say('T_WRITE', 'Map write: busy, try again'); return Promise.resolve(); }
                const g = car.gate();
                if (!g.ok) { armed = null; say('T_WRITE', 'Map write: not now, ' + g.why); return Promise.resolve(); }
                if (!armed || armed.slot !== slot || Date.now() - armed.t > ARM_MS) {
                    armed = { slot, t: Date.now() };
                    say('T_WRITE', 'Map write: tap again within 5 s to switch to ' + SLOT_NAME[slot]);
                    return Promise.resolve();
                }
                armed = null;
                say('T_WRITE', 'Map write: sending ' + SLOT_NAME[slot] + '...');
                return reader.setMap(slot, () => car.gate()).then((r) => {
                    say('T_WRITE', (r.confirmed ? 'CONFIRMED: ' : r.sent ? 'NOT confirmed: ' : '') + r.steps.join(' · '));
                    if (r.map) show(ctx, 'map', r.map);
                }).catch((e) => { ctx.log.error('map write', e); say('T_WRITE', 'Map write failed: ' + (e.message || e)); });
            } catch (e) {
                ctx.log.error('map button', e);
                return Promise.resolve();
            }
        };

        try {
            ctx.ui.onClick('BTN_READ', () => { pass('button'); return Promise.resolve(); });
            ctx.ui.onClick('BTN_MAP0', mapButton(0));
            ctx.ui.onClick('BTN_MAP2', mapButton(2));
            const h = car.handlers();
            Object.keys(h).forEach((iface) => {
                // a value that doesn't change (0 km/h when stopped) isn't sent again: poll the getters
                // every second, so a standing car still has a fresh speed (0.2.1)
                ctx.signals.watch(iface, '1', h[iface], ctx.log, { pollMs: 1000 }).then((sub) => {
                    if (sub.error) ctx.log.warn(iface + ': ' + sub.error);
                    car.status[iface.split('.').pop()] = sub;
                }).catch((e) => ctx.log.warn(iface + ': ' + e));
            });
            setInterval(() => say('T_CAR', 'Car: ' + car.text() + (car.gate().ok ? '  ·  map write allowed' : '')), 1000);

            const diag = new Diag(ctx.signals, ctx.log);
            await diag.init();
            if (diag.error) { say('T_STATUS', 'No diagnostic link: ' + diag.error.slice(0, 80)); return; }
            reader = new Reader(diag, ctx.log);
            let first = false;
            const go = () => { if (!first) { first = true; pass('start'); } };
            diag.on('available', (a) => { if (a) go(); });
            say('T_STATUS', 'Link ' + (diag.available ? 'up' : 'waiting') + '...');
            if (diag.available) go();
            setTimeout(go, 5000);           // availability isn't always reported: try anyway
        } catch (e) {
            ctx.log.error('start', e);
            say('T_STATUS', 'Start failed: ' + (e.message || e));
        }
    },
});
