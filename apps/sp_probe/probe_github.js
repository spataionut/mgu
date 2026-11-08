'use strict';
/**
 * GitHub upload for SB Probe, Node 8.
 *
 * - Names resolve through the uplink lease's DNS servers: the unit's own resolver doesn't
 *   reach the internet (mgu-uplink README).
 * - Sign-in is GitHub's device flow for a GitHub App: the car shows a code, the owner enters
 *   it on a phone. The token stays in memory; the App is installed on one private repo only,
 *   so the token can write nowhere else.
 * - Files go up as assets of a new release (raw bytes with a Content-Length, no base64).
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const urlMod = require('url');
const querystring = require('querystring');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A lookup() for http(s).request that asks the lease's DNS servers; undefined = system resolver. */
function makeLookup(lease) {
    const servers = lease && Array.isArray(lease.dns) ? lease.dns.filter((s) => typeof s === 'string' && s) : [];
    if (!servers.length || !dns.Resolver) return undefined;
    const resolver = new dns.Resolver();
    resolver.setServers(servers);
    return function lookup(host, opts, cb) {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        resolver.resolve4(host, (err, addrs) => {
            if (err) return cb(err);
            if (!addrs || !addrs.length) {
                const e = new Error('no address for ' + host);
                e.code = 'ENOTFOUND';
                return cb(e);
            }
            // Node 8 asks for one address; newer Node may ask for all of them.
            if (opts && opts.all) cb(null, addrs.map((a) => ({ address: a, family: 4 })));
            else cb(null, addrs[0], 4);
        });
    };
}

/**
 * One request. body: null, a Buffer, or { length, produce(write) } where write(buf) returns a promise.
 * Resolves { status, text, json }; answers are read up to 4 MiB.
 */
function request(lookup, method, url, headers, body, idleMs) {
    return new Promise((resolve, reject) => {
        const u = urlMod.parse(url);
        const mod = u.protocol === 'http:' ? http : https;
        let settled = false;
        let req = null;
        const fail = (e) => {
            if (settled) return;
            settled = true;
            reject(e);
            if (req) { try { req.emit('drain'); req.abort(); } catch (x) { /* gone */ } }
        };
        const h = Object.assign({ 'User-Agent': 'sp-probe' }, headers || {});
        if (body) h['Content-Length'] = body.length;
        const opts = { method: method, protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.path, headers: h };
        if (lookup) opts.lookup = lookup;
        req = mod.request(opts, (res) => {
            const parts = [];
            let n = 0;
            res.on('data', (d) => { n += d.length; if (n <= 4 * 1024 * 1024) parts.push(d); });
            res.on('end', () => {
                if (settled) return;
                settled = true;
                const text = Buffer.concat(parts).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch (e) { /* not json */ }
                resolve({ status: res.statusCode, text: text, json: json });
            });
            res.on('error', fail);
        });
        req.on('error', fail);
        req.setTimeout(idleMs || 30000, () => fail(new Error('timeout talking to ' + u.hostname)));
        if (!body) { req.end(); return; }
        if (Buffer.isBuffer(body)) { req.end(body); return; }
        let sent = 0;
        const write = (b) => new Promise((ok, no) => {
            if (settled) return no(new Error('request ended'));
            sent += b.length;
            if (sent > body.length) return no(new Error('body grew while sending'));
            if (req.write(b)) ok();
            else req.once('drain', () => (settled ? no(new Error('request ended')) : ok()));
        });
        body.produce(write).then(() => {
            if (sent !== body.length) return fail(new Error('body changed while sending (' + sent + ' of ' + body.length + ')'));
            req.end();
        }, fail);
    });
}

function form(obj) { return Buffer.from(querystring.stringify(obj)); }
const FORM = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };

function apiHeaders(token, extra) {
    return Object.assign({
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    }, extra || {});
}

/**
 * Device flow. gh: { web, clientId, lookup }. show(uri, code, expiresSec) puts the code on screen.
 * Resolves the access token.
 */
async function deviceLogin(gh, show) {
    let r = await request(gh.lookup, 'POST', gh.web + '/login/device/code', FORM, form({ client_id: gh.clientId }));
    if (r.status !== 200 || !r.json || !r.json.device_code) {
        throw new Error('sign-in start: HTTP ' + r.status + ' ' + String(r.json && r.json.error || r.text).slice(0, 60));
    }
    const d = r.json;
    show(d.verification_uri || 'https://github.com/login/device', d.user_code, Number(d.expires_in) || 900);
    let interval = Math.max(1, Number(d.interval) || 5) * 1000;
    const until = Date.now() + (Number(d.expires_in) || 900) * 1000;
    let netErrors = 0;
    while (Date.now() < until) {
        await sleep(interval);
        try {
            r = await request(gh.lookup, 'POST', gh.web + '/login/oauth/access_token', FORM, form({
                client_id: gh.clientId, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }));
        } catch (e) {
            if (++netErrors >= 5) throw e;
            continue;
        }
        netErrors = 0;
        const j = r.json || {};
        if (j.access_token) return j.access_token;
        if (j.error === 'authorization_pending') continue;
        if (j.error === 'slow_down') { interval += 5000; continue; }
        throw new Error('sign-in: ' + (j.error || 'HTTP ' + r.status));
    }
    throw new Error('sign-in code expired, tap Upload again');
}

async function createRelease(gh, token, tag, body) {
    const r = await request(gh.lookup, 'POST', gh.api + '/repos/' + gh.repo + '/releases',
        apiHeaders(token, { 'Content-Type': 'application/json' }),
        Buffer.from(JSON.stringify({ tag_name: tag, name: 'SB Probe ' + tag, body: body })));
    if (r.status !== 201 || !r.json || !r.json.id) {
        throw new Error('release: HTTP ' + r.status + ' ' + String(r.json && r.json.message || r.text).slice(0, 60));
    }
    return r.json.id;
}

/** body: Buffer or { length, produce }. */
async function uploadAsset(gh, token, releaseId, name, contentType, body) {
    const r = await request(gh.lookup, 'POST',
        gh.uploads + '/repos/' + gh.repo + '/releases/' + releaseId + '/assets?name=' + encodeURIComponent(name),
        apiHeaders(token, { 'Content-Type': contentType }), body, 60000);
    if (r.status !== 201) {
        throw new Error('upload ' + name + ': HTTP ' + r.status + ' ' + String(r.json && r.json.message || r.text).slice(0, 60));
    }
}

/** Removes an asset of that name, if any (a broken upload can leave one behind). */
async function deleteAsset(gh, token, releaseId, name) {
    const r = await request(gh.lookup, 'GET', gh.api + '/repos/' + gh.repo + '/releases/' + releaseId + '/assets?per_page=100',
        apiHeaders(token), null);
    const hit = r.status === 200 && Array.isArray(r.json) ? r.json.filter((a) => a && a.name === name)[0] : null;
    if (!hit) return false;
    await request(gh.lookup, 'DELETE', gh.api + '/repos/' + gh.repo + '/releases/assets/' + hit.id, apiHeaders(token), null);
    return true;
}

module.exports = { makeLookup, request, deviceLogin, createRelease, uploadAsset, deleteAsset };
