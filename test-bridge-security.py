# SPDX-License-Identifier: GPL-3.0-or-later
"""Bridge origin-guard regression test (plain Python, no deps beyond the
bridge's own import path). Run:  python3 test-bridge-security.py

Checks (1) the pure verdict function against real-world Origin shapes,
(2) that serve() is actually wired to the handshake hook, so the guard can
never silently detach from the socket again."""
import importlib.util
import pathlib
import re
import sys

here = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("zs_bridge", here / "bridge.py")
bridge = importlib.util.module_from_spec(spec)
sys.argv = [sys.argv[0]]  # keep module top-level import-safe
spec.loader.exec_module(bridge)

ob = bridge.origin_blocked
CASES = [
    (None, False), ("", False),                                   # non-browser client
    ("chrome-extension://abcdefghijklmnopabcdefghijklmnop", False),  # Edge/Chrome worker
    ("moz-extension://11111111-2222-3333-4444-555555555555", False),  # Firefox
    ("https://chatgpt.com", True),                                # a web page
    ("http://evil.example", True),
    ("null", True),                                               # file://-like / sandboxed
    ("chrome-extension.org", True),                               # lookalike domain, NOT a scheme
    ("https://app.all-hands.dev", True),
]
fails = 0
for origin, want in CASES:
    got = bool(ob(origin))
    if got != want:
        fails += 1
        print(f"FAIL origin_blocked({origin!r}) = {got}, want {want}")
    else:
        print(f"ok   origin_blocked({origin!r}) = {got}")

src = (here / "bridge.py").read_text(encoding="utf-8")
if not re.search(r"process_request\s*=\s*reject_web_page_origins", src):
    fails += 1
    print("FAIL serve() is not wired to reject_web_page_origins")
else:
    print("ok   serve(... process_request=reject_web_page_origins)")

print("PASS  bridge origin guard" if not fails else f"FAIL  {fails} case(s)")
sys.exit(1 if fails else 0)
