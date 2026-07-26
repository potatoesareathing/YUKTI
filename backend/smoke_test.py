import json
import time
import urllib.request

BASE = "http://127.0.0.1:8000"


def get(path: str, timeout: int = 180):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.load(r)


def main() -> None:
    t0 = time.time()
    print("health", get("/api/health")["data"])
    districts = get("/api/districts")["data"]
    print("districts", len(districts), "rate", districts[0]["rate"], "riskNorm", round(districts[0]["riskNorm"], 3))
    risk = get("/api/risk-scores")["data"]
    print("risk", len(risk), "evidence", len(risk[0]["evidence"]), "band", risk[0]["band"])
    anom = get("/api/anomalies")["data"]
    print("anomalies", len(anom), "evidence", len(anom[0]["evidence"]) if anom else 0)
    graph = get("/api/graph")["data"]
    pred = sum(1 for e in graph["edges"] if e.get("predicted"))
    print("graph", len(graph["nodes"]), "edges", len(graph["edges"]), "predicted", pred)
    print("partial_s", round(time.time() - t0, 2))
    t1 = time.time()
    boot = get("/api/bootstrap")["data"]
    print(
        "bootstrap_s",
        round(time.time() - t1, 2),
        "incidents",
        len(boot["incidents"]),
        "stations",
        len(boot["stations"]),
        "models",
        len(boot["models"]),
        "catSeries",
        len(boot["categorySeries"]),
        "distSeries",
        len(boot["districtSeries"]),
    )


if __name__ == "__main__":
    main()
