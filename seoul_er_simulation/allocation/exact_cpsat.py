# 15차(2026-10-14) — bench_static.js 가 내보낸 배치 배정 인스턴스의 정확해(또는 하한)를 OR-Tools CP-SAT로 구한다.
# 볼록 혼잡 비용은 "c번째 칸" 0/1 변수 u_jc 로 선형화한다(한계비용이 증가하므로 최소화 시 앞 칸부터 채워짐 → 정확).
# 사용: python exact_cpsat.py [시간한도초=60]     결과: results/exact_results.json
import glob
import json
import os
import sys
import time

from ortools.sat.python import cp_model

SCALE = 10  # 비용을 0.1초 단위 정수로
HERE = os.path.dirname(os.path.abspath(__file__))


def solve(path, limit):
    d = json.load(open(path, encoding="utf-8"))
    n, m, K = d["n"], d["m"], d["K"]
    md = cp_model.CpModel()
    obj = []
    er_terms = [[] for _ in range(m)]
    icu_terms = [[[] for _ in range(K)] for _ in range(m)]
    for i, p in enumerate(d["patients"]):
        xs = []
        for j, c in zip(p["cand"], p["cost"]):
            x = md.NewBoolVar(f"x{i}_{j}")
            xs.append(x)
            obj.append(int(round(c * SCALE)) * x)
            er_terms[j].append(x)
            if p["icuK"] >= 0:
                icu_terms[j][p["icuK"]].append(x)
        u = md.NewBoolVar(f"un{i}")  # 보류
        md.AddExactlyOne(xs + [u])
        obj.append(int(round(d["unassigned"][i] * SCALE)) * u)

    def convex(terms, marg, tag):
        if not terms:
            return
        md.Add(sum(terms) <= len(marg))
        slots = [md.NewBoolVar(f"{tag}_{c}") for c in range(len(marg))]
        md.Add(sum(slots) == sum(terms))
        for c, v in enumerate(slots):
            obj.append(int(round(marg[c] * SCALE)) * v)
        for c in range(len(slots) - 1):  # 대칭 제거(정확성에는 불필요, 속도용)
            md.AddImplication(slots[c + 1], slots[c])

    for j in range(m):
        convex(er_terms[j], d["erMarg"][j], f"er{j}")
        for k in range(K):
            convex(icu_terms[j][k], d["icuMarg"][j][k], f"icu{j}_{k}")
    md.Minimize(sum(obj))
    s = cp_model.CpSolver()
    s.parameters.max_time_in_seconds = limit
    s.parameters.num_workers = 8
    t0 = time.perf_counter()
    st = s.Solve(md)
    ms = (time.perf_counter() - t0) * 1000
    return {
        "status": s.StatusName(st),
        "cost": s.ObjectiveValue() / SCALE if st in (cp_model.OPTIMAL, cp_model.FEASIBLE) else None,
        "bound": s.BestObjectiveBound() / SCALE,
        "timeMs": ms,
    }


if __name__ == "__main__":
    limit = float(sys.argv[1]) if len(sys.argv) > 1 else 60
    out = {}
    for f in sorted(glob.glob(os.path.join(HERE, "results", "instances", "*.json"))):
        key = os.path.splitext(os.path.basename(f))[0]
        out[key] = solve(f, limit)
        print(key, out[key], flush=True)
    json.dump(out, open(os.path.join(HERE, "results", "exact_results.json"), "w", encoding="utf-8"), indent=1)
