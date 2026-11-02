#!/usr/bin/env python3
"""A local mirror of the site's /models/ path, for trying the tuned model in development.

    python3 -I scripts/serve-models.py <stage root> [port]     (default 8790)
    VITE_MODEL_BASE=http://localhost:8790/models/ npm run dev

Serves <stage root>/<build>/<file> (from scripts/stage-model.py) at
/models/<build>/<file> and at /models/<build>/resolve/main/<file>, the path
WebLLM asks for, with the same headers as the server: a year's immutable
caching on files that exist, and CORS for the dev and preview servers.
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.expanduser(sys.argv[1])) if len(sys.argv) > 1 else sys.exit(__doc__)
ORIGINS = {f'http://{host}:{port}' for host in ('localhost', '127.0.0.1') for port in (5173, 4173)}


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        origin = self.headers.get('Origin')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        super().end_headers()

    def send_response(self, code, message=None):
        super().send_response(code, message)
        if code in (200, 206, 304):
            self.send_header('Cache-Control', 'public, max-age=31536000, immutable')

    def translate_path(self, path):
        parts = path.split('?')[0].split('/')
        if parts[3:5] == ['resolve', 'main']:
            del parts[3:5]
        if len(parts) == 4 and parts[:2] == ['', 'models'] and all(p and not p.startswith('.') for p in parts[2:]):
            return os.path.join(ROOT, parts[2], parts[3])
        return '/nonexistent'

    def list_directory(self, path):
        self.send_error(404)


ThreadingHTTPServer(('127.0.0.1', int(sys.argv[2]) if len(sys.argv) > 2 else 8790), Handler).serve_forever()
