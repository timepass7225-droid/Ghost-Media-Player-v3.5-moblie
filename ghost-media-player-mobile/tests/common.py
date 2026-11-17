"""Shared helpers for the headless-Chromium tests. Serves www/ on localhost and drives the real app."""
import os, sys, threading, http.server, socketserver, functools, time, json

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
WWW = os.path.join(ROOT, "www")
FX = os.environ.get("GHOST_FX", "/tmp/fx")

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def serve():
    handler = functools.partial(Quiet, directory=WWW)
    srv = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, "http://127.0.0.1:%d/index.html" % srv.server_address[1]

class Report:
    def __init__(self): self.ok = 0; self.bad = []
    def check(self, name, cond, detail=""):
        if cond: self.ok += 1; print("  PASS  " + name + (("  [" + str(detail) + "]") if detail != "" else ""))
        else: self.bad.append(name); print("  FAIL  " + name + (("  [" + str(detail) + "]") if detail != "" else ""))
    def section(self, t): print("\n== " + t)
    def done(self):
        print("\n%d passed, %d failed" % (self.ok, len(self.bad)))
        for b in self.bad: print("   FAILED:", b)
        return 1 if self.bad else 0

def fx(*names): return [os.path.join(FX, n) for n in names]

def launch(p, **ctx):
    b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"])
    c = b.new_context(**ctx)
    page = c.new_page()
    errors, requests = [], []
    page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    page.on("console", lambda m: errors.append("console." + m.type + ": " + m.text) if m.type in ("error",) else None)
    page.on("request", lambda r: requests.append(r.url))
    return b, c, page, errors, requests
