'use strict';
/**
 * carstate.js - the car's state for the write gate: speed, engine speed and selector, live only.
 * Field names and scalings are the kit's (kit/car.js, from BMW's own TypeConverters); there is no
 * demo data here, so a missing or stale signal means "don't send".
 *
 *   speed  Vehicle2.statusCarSpeed2.speedVehicleCentreOfGravity      x 0.015625 km/h, 65535 = none
 *   rpm    CDS.statusEngineSpeed2.actualValueRPMEngineCrankshaft      x 0.25 rpm, 65535 = none
 *   stage  VehicleInformation.statusGearboxDrive.statusActualStageDrive (P R N D, or 1 2 3 4)
 *          VehicleInformation.DataPowerTrain2.statusGearSelectionDrive (N R P, or 1 2 3)
 */
const FRESH_MS = 3000;
const RUNNING_RPM = 400;
const STAGES = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
const SELECTION = { N: 'N', R: 'R', P: 'P', 1: 'N', 2: 'R', 3: 'P' };

class CarState {
    constructor(now) {
        this.now = now || Date.now;
        this.v = {};            // key -> { value, t }
        this.status = {};       // interface -> its watch ({ available, error }), for the screen
    }
    _put(k, value) { if (value !== null && value !== undefined) this.v[k] = { value, t: this.now() }; }
    _fresh(k) { const x = this.v[k]; return x && this.now() - x.t <= FRESH_MS ? x.value : null; }
    speed(raw) { if (typeof raw === 'number' && raw !== 65535) this._put('speed', raw * 0.015625); }
    rpm(raw) { if (typeof raw === 'number' && raw !== 65535) this._put('rpm', raw * 0.25); }
    stage(raw) { if (STAGES[raw]) this._put('stage', STAGES[raw]); }
    selection(raw) { if (SELECTION[raw]) this._put('stage', SELECTION[raw]); }

    /** the handlers for ctx.signals.watch, per interface */
    handlers() {
        return {
            'de.bmw.infotainment.vehicle.Vehicle2': { statusCarSpeed2: (v) => this.speed(v && v.speedVehicleCentreOfGravity) },
            'de.bmw.infotainment.vehicle.CDS': { statusEngineSpeed2: (v) => this.rpm(v && v.actualValueRPMEngineCrankshaft) },
            'de.bmw.infrastructure.VehicleInformation': {
                statusGearboxDrive: (v) => this.stage(v && v.statusActualStageDrive),
                DataPowerTrain2: (v) => this.selection(v && v.statusGearSelectionDrive),
            },
        };
    }

    /** a value for the screen: fresh, or the last one with its age, or ? and the interface's state */
    _show(k, unit, iface) {
        const x = this.v[k];
        if (!x) {
            const w = this.status[iface];
            return '? ' + unit + (w ? ' (' + (w.error ? 'error' : w.available ? 'up, no value' : 'not available') + ')' : '');
        }
        const age = this.now() - x.t, v = typeof x.value === 'number' ? Math.round(x.value) : x.value;
        return v + (unit ? ' ' + unit : '') + (age > FRESH_MS ? ' (' + Math.round(age / 1000) + ' s old)' : '');
    }

    text() {
        return this._show('speed', 'km/h', 'Vehicle2') + '  ·  ' + this._show('rpm', 'rpm', 'CDS') + '  ·  ' + this._show('stage', '', 'VehicleInformation');
    }

    /** May the map write go now? Stationary (live speed under 1 km/h), engine running, not in R / N / D. */
    gate() {
        const s = this._fresh('speed'), r = this._fresh('rpm'), g = this._fresh('stage');
        if (s === null) return { ok: false, why: 'no live speed from the car' };
        if (s >= 1) return { ok: false, why: 'the car is moving' };
        if (r === null) return { ok: false, why: 'no live engine speed' };
        if (r < RUNNING_RPM) return { ok: false, why: 'the engine is not running' };
        if (g && g !== 'P') return { ok: false, why: 'selector in ' + g + ', put it in P' };
        return { ok: true };
    }
}

module.exports = { CarState, FRESH_MS };
