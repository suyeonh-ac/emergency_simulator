// 15차(2026-10-14) — 벤치마크 결과(results/*.json)를 마크다운 표로 요약한다. 사용: node analyze.js > results/summary.md
const fs = require('fs');
const path = require('path');
const A = require('./allocation_core');
const R = path.join(__dirname, 'results');
const read = f => fs.existsSync(path.join(R, f)) ? JSON.parse(fs.readFileSync(path.join(R, f), 'utf8')) : null;
const mean = a => a.reduce((s, x) => s + x, 0)/Math.max(1, a.length);
const fx = (v, d) => v === null || v === undefined || Number.isNaN(v) ? '-' : v.toFixed(d);

const exact = read('exact_results.json') || {};
const out = [];
out.push('# 정적 배치 배정 벤치마크 (목적값 = 중증 가중 이송시간 + 혼잡 + 보류 벌점, 초)\n');
['A', 'B', 'C', 'D'].forEach(id => {
  const S = read('static_' + id + '.json'); if(!S) return;
  out.push('## ' + id + '. ' + S.label + '\n');
  const insts = [...new Set(S.rows.map(r => r.instance))];
  const ex = insts.map(s => exact[id + '_' + s]).filter(Boolean);
  if(ex.length){
    out.push('CP-SAT(OR-Tools, 8스레드, 한도 60초): 상태 ' + [...new Set(ex.map(e => e.status))].join('/') +
      ', 평균 ' + fx(mean(ex.map(e => e.timeMs)), 0) + 'ms\n');
  }
  // 기준값: 인스턴스별 최적(있으면 CP-SAT 최적, 없으면 전체 해법 중 최솟값)
  const ref = {};
  insts.forEach(s => {
    const e = exact[id + '_' + s];
    const bestHeur = Math.min(...S.rows.filter(r => r.instance === s).map(r => r.cost));
    ref[s] = e && e.status === 'OPTIMAL' ? e.cost : Math.min(bestHeur, e && e.cost ? e.cost : Infinity);
  });
  out.push('| 해법 | 시간한도 | 평균 소요(ms) | 최적 대비 격차(%) | 최적 도달 비율 | 보류(명) | 평균 이송(분) | KTAS1-2 이송(분) | 반복수 |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  const keys = [];
  S.rows.forEach(r => { const k = r.solver + '|' + (r.budgetMs || ''); if(keys.indexOf(k) < 0) keys.push(k); });
  keys.forEach(k => {
    const [solver, b] = k.split('|'), rows = S.rows.filter(r => r.solver === solver && String(r.budgetMs || '') === b);
    const gaps = rows.map(r => (r.cost - ref[r.instance])/ref[r.instance]*100);
    const hit = rows.filter(r => r.cost <= ref[r.instance]*(1 + 1e-6)).length/rows.length*100;
    out.push('| ' + A.SOLVERS[solver].label + ' | ' + (b ? b + 'ms' : '-') + ' | ' + fx(mean(rows.map(r => r.timeMs)), 1) + ' | ' +
      fx(mean(gaps), 2) + ' | ' + fx(hit, 0) + '% | ' + fx(mean(rows.map(r => r.unassigned)), 1) + ' | ' +
      fx(mean(rows.map(r => r.meanTravelMin)), 1) + ' | ' + fx(mean(rows.map(r => r.critMeanTravelMin)), 1) + ' | ' + fx(mean(rows.map(r => r.iters)), 0) + ' |');
  });
  out.push('');
});

const ON = read('online_results.json');
if(ON){
  out.push('# 온라인(시간 흐름) 시뮬레이션 벤치마크 (시드 ' + [...new Set(ON.results.map(r => r.seed))].join(',') + ' 평균, 메타휴리스틱 한도 ' + ON.budgetMs + 'ms/결정)\n');
  Object.keys(ON.scenarios).forEach(sid => {
    const rows = ON.results.filter(r => r.scenario === sid); if(!rows.length) return;
    out.push('## ' + sid + '. ' + ON.scenarios[sid].label + '\n');
    out.push('| 정책 | 발생 | 실패 | KTAS1-2 실패 | 평균 탐색(분) | 평균 이송(분) | KTAS1-2 이송(분) | 가중 지연(분/명) | 재난환자 도착(분) | 만석 병원·시간 | 결정당 계산(ms) 평균/p95/최대 | 최대 동시 배치 |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    const pols = [...new Set(rows.map(r => r.policy))];
    pols.forEach(p => {
      const g = rows.filter(r => r.policy === p), f = k => mean(g.map(r => r[k]));
      const label = p.startsWith('batch:') ? '배치 · ' + A.SOLVERS[p.slice(6)].label : (p === 'sequential' ? '현재 순차 문의' : '현재 GLOBAL');
      out.push('| ' + label + ' | ' + fx(f('spawned'), 0) + ' | ' + fx(f('failed'), 1) + ' | ' + fx(f('critFailed'), 1) + ' | ' + fx(f('meanSearchMin'), 2) + ' | ' +
        fx(f('meanTransitMin'), 2) + ' | ' + fx(f('critMeanTransitMin'), 2) + ' | ' + fx(f('weightedDelayPerPatientMin'), 2) + ' | ' +
        (g[0].burstMeanArrivalMin === null ? '-' : fx(f('burstMeanArrivalMin'), 1)) + ' | ' + fx(f('fullHospitalHours'), 1) + ' | ' +
        (f('solverCalls') ? fx(f('solverMsMean'), 2) + ' / ' + fx(f('solverMsP95'), 1) + ' / ' + fx(Math.max(...g.map(r => r.solverMsMax)), 0) : '-') + ' | ' +
        (f('solverCalls') ? fx(Math.max(...g.map(r => r.maxBatch)), 0) : '-') + ' |');
    });
    out.push('');
  });
}
process.stdout.write(out.join('\n') + '\n');
