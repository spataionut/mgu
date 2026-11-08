#!/usr/bin/env python3
"""Receive SB Probe's files on the Mac.

The car and the Mac join the same phone hotspot (the car through Store, Settings, Wi-Fi).
Run this, then tap "Send files to Mac" in SB Probe. The probe finds this server on the
hotspot's subnet (GET /sp-probe-hello) and uploads report-<time>.txt and dump-<time>.tar.

  python3 tools/receive-dump.py [--out DIR] [--port 8737] [--once]

--once exits after a dump arrives. Files land in DIR (default ~/Desktop/sp_probe-dump).
"""
import argparse
import http.server
import os
import re
import subprocess
import sys

HELLO = b'sp-probe-receiver 1\n'
NAME = re.compile(r'^/upload/((?:report|dump)-[0-9A-Za-z-]{1,64}\.(?:txt|tar))$')
MAX_BYTES = 512 * 1024 * 1024


def mac_addresses():
    out = []
    for iface in ('en0', 'en1', 'en2', 'bridge100'):
        try:
            ip = subprocess.run(['ipconfig', 'getifaddr', iface], capture_output=True, text=True, timeout=3).stdout.strip()
        except Exception:
            ip = ''
        if ip:
            out.append(iface + ' ' + ip)
    return out


class Handler(http.server.BaseHTTPRequestHandler):
    timeout = 120
    server_version = 'sp-probe-receiver/1'

    def log_message(self, fmt, *args):
        pass

    def reply(self, code, body):
        self.send_response(code)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/sp-probe-hello':
            print('Probe found this Mac from ' + self.client_address[0], flush=True)
            self.reply(200, HELLO)
        else:
            self.reply(404, b'not here\n')

    def chunks(self):
        if self.headers.get('Transfer-Encoding', '').lower() == 'chunked':
            while True:
                line = self.rfile.readline(1024)
                if not line:
                    raise ValueError('connection closed mid-upload')
                size = int(line.split(b';')[0].strip(), 16)
                if size == 0:
                    while self.rfile.readline(1024) not in (b'\r\n', b'\n', b''):
                        pass
                    return
                left = size
                while left:
                    data = self.rfile.read(min(left, 1 << 20))
                    if not data:
                        raise ValueError('connection closed mid-upload')
                    left -= len(data)
                    yield data
                self.rfile.readline(1024)
        else:
            left = int(self.headers.get('Content-Length', '0'))
            while left:
                data = self.rfile.read(min(left, 1 << 20))
                if not data:
                    raise ValueError('connection closed mid-upload')
                left -= len(data)
                yield data

    def do_PUT(self):
        m = NAME.match(self.path)
        if not m:
            self.reply(400, b'bad name\n')
            return
        name = m.group(1)
        final = os.path.join(self.server.out, name)
        part = final + '.part'
        total = 0
        try:
            with open(part, 'wb') as f:
                for data in self.chunks():
                    total += len(data)
                    if total > MAX_BYTES:
                        raise ValueError('too large')
                    f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(part, final)
        except Exception as e:
            try:
                os.unlink(part)
            except OSError:
                pass
            print('Upload of ' + name + ' failed: ' + str(e), flush=True)
            self.reply(500, ('failed: ' + str(e) + '\n').encode())
            return
        print('Received ' + final + ' (' + str(total) + ' bytes)', flush=True)
        self.reply(200, ('ok ' + str(total) + '\n').encode())
        if name.startswith('dump-'):
            self.server.got_dump = True


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--out', default=os.path.expanduser('~/Desktop/sp_probe-dump'))
    ap.add_argument('--port', type=int, default=8737)
    ap.add_argument('--once', action='store_true', help='exit after a dump arrives')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    server = http.server.HTTPServer(('0.0.0.0', a.port), Handler)
    server.out = a.out
    server.got_dump = False
    print('Listening on port ' + str(a.port) + ', saving to ' + a.out, flush=True)
    for addr in mac_addresses():
        print('  this Mac: ' + addr, flush=True)
    print('Now tap "Send files to Mac" in SB Probe. Ctrl-C to stop.', flush=True)
    try:
        while not (a.once and server.got_dump):
            server.handle_request()
    except KeyboardInterrupt:
        pass
    server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
