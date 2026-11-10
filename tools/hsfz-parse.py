#!/usr/bin/env python3
"""hsfz-parse.py - pull the UDS requests and replies out of a capture of a BMW ENET session.

    python3 tools/hsfz-parse.py private/mgf-<time>.pcap [--ecu 12] [--all] [--no-reads]

tcpdump reads the file (so any link type works, rvi0 included) and prints each packet from the
IP header on. The TCP streams are put back together per direction, and every stream is tried as
  HSFZ  (BMW, TCP 6801):  length(4) control(2) payload; control 0x0001 = diagnostic message,
                          payload = source(1) target(1) UDS
  DoIP  (ISO 13400):      02 FD type(2) length(4); type 0x8001 = diagnostic message,
                          payload = source(2) target(2) UDS
whatever the port. A stream that is neither is listed with its first bytes (16 03 .. = TLS,
i.e. encrypted, and nothing can be read from it).

Output: a timeline (seconds from the first packet), then the distinct requests to the ECU
(default 0x12, the DME) other than reads (22) and tester present (3E): the candidates.
The capture holds the VIN and the car's replies: keep it in private/.
"""
import argparse
import collections
import os
import re
import subprocess
import sys

SERVICES = {
    0x10: 'DiagnosticSessionControl', 0x11: 'ECUReset', 0x14: 'ClearDTC', 0x19: 'ReadDTC', 0x22: 'ReadDataByIdentifier',
    0x23: 'ReadMemoryByAddress', 0x27: 'SecurityAccess', 0x28: 'CommunicationControl', 0x2C: 'DynamicallyDefineDID',
    0x2E: 'WriteDataByIdentifier', 0x2F: 'IOControlByIdentifier', 0x31: 'RoutineControl', 0x34: 'RequestDownload',
    0x35: 'RequestUpload', 0x36: 'TransferData', 0x37: 'RequestTransferExit', 0x3D: 'WriteMemoryByAddress',
    0x3E: 'TesterPresent', 0x85: 'ControlDTCSetting', 0x7F: 'NegativeResponse',
}
HEADER = re.compile(r'^(\d+\.\d+) ')
HEXLINE = re.compile(r'^\s+0x[0-9a-f]+:\s+((?:[0-9a-f]{2,4}\s?)+)')


def readable(path):
    """macOS tcpdump on rvi0 (PKTAP) can write a pcap header followed by a pcapng file; tcpdump
    then can't read it. Such a file is copied without the stray 24 bytes, next to it (.pcapng)."""
    with open(path, 'rb') as f:
        head = f.read(28)
    if len(head) == 28 and head[:4] in (b'\xd4\xc3\xb2\xa1', b'\xa1\xb2\xc3\xd4') and head[24:28] == b'\x0a\x0d\x0d\x0a':
        fixed = path.rsplit('.', 1)[0] + '.pcapng'
        with open(path, 'rb') as f, open(fixed, 'wb') as g:
            f.seek(24)
            g.write(f.read())
        os.chmod(fixed, 0o600)
        print('(read as pcapng: %s)' % fixed, file=sys.stderr)
        return fixed
    return path


def packets(path):
    """(time, ip packet bytes) for every packet, via tcpdump."""
    path = readable(path)
    try:
        out = subprocess.run(['tcpdump', '-r', path, '-nn', '-tt', '-x'], capture_output=True, text=True)
    except FileNotFoundError:
        sys.exit('tcpdump not found')
    if out.returncode and not out.stdout:
        sys.exit(out.stderr.strip())
    t, buf = None, []
    for line in out.stdout.splitlines():
        m = HEADER.match(line)
        if m:
            if t is not None:
                yield t, bytes.fromhex(''.join(buf))
            t, buf = float(m.group(1)), []
            continue
        h = HEXLINE.match(line)
        if h and t is not None:
            buf.append(h.group(1).replace(' ', ''))
    if t is not None:
        yield t, bytes.fromhex(''.join(buf))


def tcp_segment(ip):
    """(src, sport, dst, dport, seq, payload) for a TCP packet over IPv4 or IPv6, else None."""
    if not ip:
        return None
    v = ip[0] >> 4
    if v == 4:
        ihl = (ip[0] & 15) * 4
        if ip[9] != 6:
            return None
        total = int.from_bytes(ip[2:4], 'big') or len(ip)
        src, dst, tcp = '.'.join(map(str, ip[12:16])), '.'.join(map(str, ip[16:20])), ip[ihl:total]
    elif v == 6:
        if ip[6] != 6:          # extension headers aren't followed: ENET traffic has none
            return None
        plen = int.from_bytes(ip[4:6], 'big')
        src, dst, tcp = ip[8:24].hex(), ip[24:40].hex(), ip[40:40 + plen]
    else:
        return None
    if len(tcp) < 20:
        return None
    off = (tcp[12] >> 4) * 4
    return (src, int.from_bytes(tcp[0:2], 'big'), dst, int.from_bytes(tcp[2:4], 'big'),
            int.from_bytes(tcp[4:8], 'big'), tcp[off:])


def streams(path):
    """{(src, sport, dst, dport): [(time, offset in stream)], bytes} with retransmits dropped."""
    segs = collections.defaultdict(dict)
    t0 = None
    for t, ip in packets(path):
        t0 = t if t0 is None else t0
        s = tcp_segment(ip)
        if not s or not s[5]:
            continue
        key, seq, data = s[:4], s[4], s[5]
        if seq not in segs[key] or len(data) > len(segs[key][seq][1]):
            segs[key][seq] = (t - t0, data)
    out = {}
    for key, by_seq in segs.items():
        base = min(by_seq)                     # no wrap handling: a capture is short
        data, marks = bytearray(), []
        for seq in sorted(by_seq):
            t, d = by_seq[seq]
            at = seq - base
            if at > len(data):
                data.extend(b'\0' * (at - len(data)))   # a lost segment: keep offsets right
            if at + len(d) > len(data):
                marks.append((t, len(data)))
                data.extend(d[len(data) - at:])
        out[key] = (marks, bytes(data))
    return out


def time_at(marks, offset):
    t = marks[0][0] if marks else 0.0
    for mt, mo in marks:
        if mo > offset:
            break
        t = mt
    return t


def hsfz_frames(data):
    i, out = 0, []
    while i + 6 <= len(data):
        n, ctrl = int.from_bytes(data[i:i + 4], 'big'), int.from_bytes(data[i + 4:i + 6], 'big')
        if n > 0x10000 or ctrl > 0x0100 or i + 6 + n > len(data):
            break
        p = data[i + 6:i + 6 + n]
        if ctrl == 0x0001 and len(p) >= 3:
            out.append((i, p[0], p[1], p[2:]))
        i += 6 + n
    return out, i


def doip_frames(data):
    i, out = 0, []
    while i + 8 <= len(data):
        if data[i] != (data[i + 1] ^ 0xFF) or data[i] not in (1, 2, 3):
            break
        typ, n = int.from_bytes(data[i + 2:i + 4], 'big'), int.from_bytes(data[i + 4:i + 8], 'big')
        if n > 0x10000 or i + 8 + n > len(data):
            break
        p = data[i + 8:i + 8 + n]
        if typ == 0x8001 and len(p) >= 5:
            out.append((i, int.from_bytes(p[0:2], 'big'), int.from_bytes(p[2:4], 'big'), p[4:]))
        i += 8 + n
    return out, i


def describe(uds):
    sid = uds[0]
    if sid == 0x7F and len(uds) >= 3:
        return 'NEGATIVE to %02X (NRC %02X)' % (uds[1], uds[2])
    if sid in SERVICES:
        return SERVICES[sid]
    if sid - 0x40 in SERVICES:
        return 'positive ' + SERVICES[sid - 0x40]
    return '?'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('pcap')
    ap.add_argument('--ecu', default='12', help='ECU address in hex for the summary (default 12, the DME)')
    ap.add_argument('--all', action='store_true', help='timeline: all ECUs, not just --ecu')
    ap.add_argument('--no-reads', action='store_true', help='timeline: leave out 22 / 62 and 3E / 7E')
    a = ap.parse_args()
    ecu = int(a.ecu, 16)

    events, other = [], []
    for key, (marks, data) in streams(a.pcap).items():
        src, sport, dst, dport = key
        frames, used = hsfz_frames(data)
        kind = 'HSFZ'
        if not frames:
            frames, used = doip_frames(data)
            kind = 'DoIP'
        if not frames:
            other.append((key, len(data), data[:8].hex(' ')))
            continue
        for off, s, t, uds in frames:
            events.append((time_at(marks, off), kind, s, t, uds))
        if used < len(data):
            other.append((key, len(data) - used, 'after %d %s bytes: %s' % (used, kind, data[used:used + 8].hex(' '))))
    events.sort(key=lambda e: e[0])

    print('== timeline (s from the first packet; tester -> ECU are requests, ECU -> tester are replies)')
    for t, kind, s, d, uds in events:
        if not a.all and ecu not in (s, d):
            continue
        if a.no_reads and uds[0] in (0x22, 0x62, 0x3E, 0x7E):
            continue
        print('%8.3f %s %02X -> %02X  %-48s %s' % (t, kind, s, d, uds.hex(' ').upper()[:48], describe(uds)))

    print('\n== requests to %02X other than reads and tester present (the candidates)' % ecu)
    reqs = collections.OrderedDict()
    for t, kind, s, d, uds in events:
        if d == ecu and uds[0] not in (0x22, 0x3E):
            k = uds.hex(' ').upper()
            reqs.setdefault(k, []).append(t)
    for k, ts in reqs.items():
        print('  %-40s x%-3d first at %.3f s  %s' % (k, len(ts), ts[0], describe(bytes.fromhex(k))))
    if not reqs:
        print('  none')

    print('\n== ECUs seen: ' + (', '.join('%02X' % x for x in sorted({e[3] for e in events} | {e[2] for e in events})) or 'none'))
    if other:
        print('\n== other TCP streams (not HSFZ or DoIP; 16 03 = TLS, encrypted)')
        for (src, sport, dst, dport), n, head in other:
            print('  %s:%d -> %s:%d  %d bytes  %s' % (src, sport, dst, dport, n, head))


if __name__ == '__main__':
    main()
