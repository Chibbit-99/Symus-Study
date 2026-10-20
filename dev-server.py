#!/usr/bin/env python3
"""Static development server for Symus Study.

`python3 -m http.server` sends no cache headers, so after you pull a change a
browser can keep serving the old HTML/JS/CSS and the app looks unchanged. This
server sends `Cache-Control: no-store` for every response, so a normal reload
always shows the current files.

Usage:
    python3 dev-server.py            # http://localhost:8000
    python3 dev-server.py 8080       # custom port
"""

import argparse
import functools
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    parser = argparse.ArgumentParser(description="Serve Symus Study without caching.")
    parser.add_argument("port", nargs="?", type=int, default=8000)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    handler = functools.partial(NoCacheHandler, directory=str(ROOT))
    with ThreadingHTTPServer((args.host, args.port), handler) as httpd:
        print(f"Serving {ROOT} at http://localhost:{args.port} (caching disabled)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
