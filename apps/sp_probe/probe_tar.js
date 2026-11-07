'use strict';
/**
 * probe_tar.js - a minimal ustar writer (regular files only), so the probe can
 * put many files into one archive on a FAT32 stick or an HTTP response.
 * Node 8 compatible.
 *
 *   const t = new TarWriter((buf) => promiseThatResolvesWhenWritten);
 *   await t.add('etc/a.json', buffer, mtimeSeconds);
 *   await t.finish();
 */

const BLOCK = 512;

function octal(n, width) {
    // width includes the trailing NUL
    const s = Math.floor(n).toString(8);
    if (s.length > width - 1) throw new Error('tar field overflow');
    return '0'.repeat(width - 1 - s.length) + s + '\0';
}

/** Split a path into ustar prefix (155) + name (100). null if it cannot fit. */
function splitName(p) {
    const b = Buffer.byteLength(p);
    if (b <= 100) return { prefix: '', name: p };
    if (b > 256) return null;
    for (let i = p.length - 1; i > 0; i--) {
        if (p[i] !== '/') continue;
        const prefix = p.slice(0, i), name = p.slice(i + 1);
        if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { prefix, name };
    }
    return null;
}

function header(p, size, mtime) {
    const parts = splitName(p);
    if (!parts) return null;
    const h = Buffer.alloc(BLOCK, 0);
    h.write(parts.name, 0, 100, 'utf8');
    h.write(octal(0o644, 8), 100, 8, 'ascii');
    h.write(octal(0, 8), 108, 8, 'ascii');
    h.write(octal(0, 8), 116, 8, 'ascii');
    h.write(octal(size, 12), 124, 12, 'ascii');
    h.write(octal(mtime, 12), 136, 12, 'ascii');
    h.write('        ', 148, 8, 'ascii');      // checksum placeholder: spaces
    h.write('0', 156, 1, 'ascii');             // regular file
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    h.write(parts.prefix, 345, 155, 'utf8');
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += h[i];
    h.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
    return h;
}

class TarWriter {
    constructor(write) {
        this.write = write;
        this.bytes = 0;
        this.files = 0;
    }
    /** Returns false (and writes nothing) when the path is too long for ustar. */
    add(p, data, mtime) {
        const h = header(p.replace(/^\/+/, ''), data.length, mtime || Date.now() / 1000);
        if (!h) return Promise.resolve(false);
        const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
        this.files++;
        this.bytes += BLOCK + data.length + pad;
        return this.write(h)
            .then(() => (data.length ? this.write(data) : null))
            .then(() => (pad ? this.write(Buffer.alloc(pad, 0)) : null))
            .then(() => true);
    }
    finish() {
        this.bytes += 2 * BLOCK;
        return this.write(Buffer.alloc(2 * BLOCK, 0));
    }
}

module.exports = { TarWriter, splitName };
