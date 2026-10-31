"""Tiny standard-library web server for the ASEAN Startup Passport demo.

    python3 server.py                      # mock extractor, http://localhost:8080
    PASSPORT_BACKEND=ollama python3 server.py
"""

import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from passport import credential
from passport.backends import BACKENDS, get_backend
from passport.mock_extract import extract as quick_extract
from passport.pipeline import analyze

ROOT = Path(__file__).parent
SAMPLES = ROOT / "samples"
MAX_BODY = 5 * 1024 * 1024


def list_samples():
    out = []
    for path in sorted(SAMPLES.glob("*.txt")):
        text = path.read_text(encoding="utf-8")
        ex = quick_extract(path.name, text)
        out.append({"name": path.name, "text": text, "country": ex["country"], "language": ex["language"],
                    "doc_type": ex["doc_type"], "company": ex["company"]["name"]})
    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "web"), **kwargs)

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("Request body too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path == "/api/samples":
            return self._json(200, list_samples())
        if self.path == "/api/config":
            default = get_backend()
            return self._json(200, {"backend": default.name, "description": default.description,
                                    "available": list(BACKENDS)})
        return super().do_GET()

    def do_POST(self):
        try:
            payload = self._body()
            if self.path == "/api/analyze":
                docs = [{"name": str(d["name"]), "text": str(d["text"])} for d in payload.get("documents", [])]
                if not docs:
                    return self._json(400, {"error": "Select at least one document"})
                return self._json(200, analyze(docs, get_backend(payload.get("backend"))))
            if self.path == "/api/verify":
                return self._json(200, credential.verify(payload.get("credential")))
            return self._json(404, {"error": "Not found"})
        except (ValueError, KeyError, TypeError) as exc:
            return self._json(400, {"error": str(exc)})


def main():
    port = int(os.environ.get("PORT", sys.argv[1] if len(sys.argv) > 1 else 8080))
    print(f"ASEAN Startup Passport on http://localhost:{port}  (backend: {get_backend().description})")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
