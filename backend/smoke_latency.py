"""Latency + correctness smoke for production readiness."""

from __future__ import annotations

import json
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:8000"
# CIAP §13: dashboard views under 3s. Hot paths should be well under that after warm.
TARGETS_MS = {
    "/api/health": 100,
    "/api/ready": 500,
    "/api/districts": 500,
    "/api/state-totals": 500,
    "/api/incidents": 800,
    "/api/stations": 500,
    "/api/series?category=Property%20Crime": 500,
    "/api/risk-scores": 500,
    "/api/anomalies": 500,
    "/api/graph": 800,
    "/api/models": 300,
    "/api/bootstrap": 3000,
}


def get(path: str, timeout: int = 60):
    t0 = time.perf_counter()
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        body = json.load(r)
    ms = (time.perf_counter() - t0) * 1000
    return body, ms


def main() -> int:
    # Warm-up pass (fills process memory)
    try:
        get("/api/health")
        get("/api/bootstrap")
    except Exception as e:
        print("API not reachable:", e)
        return 1

    failed = 0
    print(f"{'PATH':55} {'MS':>8} {'LIMIT':>8} RESULT")
    for path, limit in TARGETS_MS.items():
        try:
            body, ms = get(path)
            ok = body.get("success") is True and ms <= limit
            if path == "/api/ready":
                ok = ok and body.get("data", {}).get("ready") is True
            status = "PASS" if ok else "FAIL"
            if not ok:
                failed += 1
            print(f"{path:55} {ms:8.1f} {limit:8} {status}")
        except Exception as e:
            failed += 1
            print(f"{path:55} {'ERR':>8} {limit:8} FAIL ({e})")

    # Contract spot-checks on bootstrap
    body, _ = get("/api/bootstrap")
    b = body["data"]
    checks = [
        ("districts=30", len(b["districts"]) == 30),
        ("evidence on risk", all(r.get("evidence") for r in b["riskScores"])),
        ("predicted edges", any(e.get("predicted") for e in b["network"]["edges"])),
        ("incidents sample", 1000 <= len(b["incidents"]) <= 8000),
    ]
    for name, cond in checks:
        print(f"[{'PASS' if cond else 'FAIL'}] {name}")
        if not cond:
            failed += 1

    print(f"\nSUMMARY: {'READY' if failed == 0 else 'NOT READY'} ({failed} failures)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
