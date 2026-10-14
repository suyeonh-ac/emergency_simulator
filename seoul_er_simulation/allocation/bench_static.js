// 15차(2026-10-14) — 정적(한 시점) 배치 배정 벤치마크.
// 같은 인스턴스에 구성형·메타휴리스틱 해법을 시간 한도별로 돌려 목적값·소요시간을 비교하고,
// 인스턴스를 JSON으로 내보내 exact_cpsat.py(OR-Tools CP-SAT 정확해)와의 격차를 잴 수 있게 한다.
// 사용: node bench_static.js [시나리오ID...]      결과: results/static_<ID>.json, results/instances/<ID>_<seed>.json
const fs = require('fs');
const path = require('path');
const createWorld = require('./sim_world');
const A = require('./allocation_core');

const OUT = path.join(__dirname, 'results');
fs.mkdirSync(path.join(OUT, 'instances'), {recursive: true});

// 시나리오: n = 동시 배정 환자 수, cells = 발생 격자(없으면 서울 전역), load = 시작 병상 가동률 목표(없으면 E-Gen 스냅샷 그대로)
const SCENARIOS = {
  A: {label: '평시 분산 (n=20, 스냅샷 가동률)',          n: 20},
  B: {label: '고부하 분산 (n=60, 응급실·ICU 가동 ~92%)', n: 60, load: 0.92},
  C: {label: '다수사상자 집중 (n=100, 강남 1개 격자)',    n: 100, cells: [6]},
  D: {label: '대형 재난 (n=250, 2개 격자, 가동 ~85%)',    n: 250, cells: [5, 6], load: 0.85}
};
const INSTANCE_SEEDS = [1, 2, 3, 4, 5];
const SOLVER_SEEDS = [11, 12];
const BUDGETS_MS = [20, 100, 500];

function makeInstance(world, sc, seed){
  const H = world.makeHospitals();
  world.seedInitialState(H, seed, 0);
  const r = world.mulberry32(seed*7919 + 13);
  if(sc.load){
    // 스냅샷 점유에 더해 병원별로 목표 가동률(±15% 흔들림)까지 채운다
    H.forEach(h => {
      const tgt = x => Math.min(1, sc.load*(0.85 + 0.3*r()));
      h.occupied = Math.max(h.occupied, Math.min(h.capacity, Math.round(h.capacity*tgt())));
      world.ICU_TYPES.forEach(k => { const c = h.icuCap[k]; if(c) h.icuOcc[k] = Math.max(h.icuOcc[k], Math.min(c, Math.round(c*tgt()))); });
    });
  }
  const P = [];
  for(let i=0;i<sc.n;i++){
    const prof = world.sampler.sampleProfile(r, 15);
    const cell = sc.cells ? sc.cells[(r()*sc.cells.length)|0] : undefined;
    P.push(world.attachTravel(Object.assign(prof, world.sampleLocation(r, cell)), H));
  }
  return {H, P, inst: A.buildInstance(P, H)};
}

// CP-SAT용 내보내기: 후보별 선형 비용 + 병원별 볼록 한계비용 표
function exportInstance(inst, file){
  const K = A.ICU_TYPES.length, p = inst.params;
  const out = {n: inst.n, m: inst.m, K, unassigned: [], patients: [], erMarg: [], icuMarg: []};
  for(let i=0;i<inst.n;i++){
    out.unassigned.push(inst.w[i]*p.unassignedPenaltySec);
    out.patients.push({icuK: inst.icuK[i], cand: Array.from(inst.cand[i]), cost: Array.from(inst.cand[i]).map(j => inst.w[i]*inst.t[i*inst.m+j])});
  }
  for(let j=0;j<inst.m;j++){
    const a = []; for(let c=1;c<=inst.erFree[j];c++) a.push(inst.marg[inst.erMargOff[j]+c]); out.erMarg.push(a);
    const row = [];
    for(let k=0;k<K;k++){ const b = []; for(let c=1;c<=inst.icuFree[j*K+k];c++) b.push(inst.marg[inst.icuMargOff[j*K+k]+c]); row.push(b); }
    out.icuMarg.push(row);
  }
  fs.writeFileSync(file, JSON.stringify(out));
}

function main(){
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
  const world = createWorld();
  // JIT 워밍업 (첫 호출 시간 왜곡 방지)
  { const w = makeInstance(world, SCENARIOS.A, 99); Object.keys(A.SOLVERS).forEach(k => A.solve(k, w.inst, {timeLimitMs: 20, seed: 1})); }

  ids.forEach(id => {
    const sc = SCENARIOS[id]; const rows = [];
    INSTANCE_SEEDS.forEach(seed => {
      const {inst} = makeInstance(world, sc, seed);
      exportInstance(inst, path.join(OUT, 'instances', id+'_'+seed+'.json'));
      let erFree = 0; for(let j=0;j<inst.m;j++) erFree += inst.erFree[j];
      Object.keys(A.SOLVERS).forEach(name => {
        const kind = A.SOLVERS[name].kind;
        const budgets = kind === 'meta' ? BUDGETS_MS : [null];
        budgets.forEach(b => {
          (kind === 'meta' ? SOLVER_SEEDS : [SOLVER_SEEDS[0]]).forEach(ss => {
            const res = A.solve(name, inst, b ? {timeLimitMs: b, seed: ss} : {seed: ss});
            rows.push({scenario: id, instance: seed, solver: name, kind, budgetMs: b, solverSeed: ss,
                       cost: res.cost, timeMs: res.timeMs, iters: res.iters, ...res.summary, erFreeTotal: erFree});
          });
        });
      });
      process.stderr.write(id+' seed '+seed+' done\n');
    });
    fs.writeFileSync(path.join(OUT, 'static_'+id+'.json'), JSON.stringify({scenario: id, ...sc, rows}, null, 1));
  });
}
main();
