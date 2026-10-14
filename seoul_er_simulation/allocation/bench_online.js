// 15차(2026-10-14) — 온라인(시간 흐름) 벤치마크. 메인 HTML의 updatePatients() 흐름을 DOM 없이 재현하고
// 배정 정책만 바꿔 끼운다. 같은 시드면 모든 정책이 같은 환자 발생열(spawn 난수 분리)을 쓴다.
//   sequential  현재 기본(순차 문의, 30초/곳, 직선거리 순, 10분 초과 시 실패)
//   global      현재 GLOBAL(매 틱 직선거리 최근접 적격 병원 즉시 배정)
//   batch:<해법> 중앙 배정: 새 환자가 생긴 틱(또는 30초마다)에 대기 환자 전체를 allocation_core 해법으로 동시 배정.
//               대기 1~2명은 국소탐색으로 바로 끝냄(메타휴리스틱은 3명 이상일 때만 시간 한도 사용).
// 사용: node bench_online.js            (병렬 워커로 전체 실행 → results/online_results.json)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');
const createWorld = require('./sim_world');
const A = require('./allocation_core');

const WAIT_TIMEOUT_SEC = 600, CONTACT_ATTEMPT_SEC = 30, DT = 2, BATCH_RETRY_SEC = 30;

const SCENARIOS = {
  N1: {label: '평시 24시간 (수요 ×1)', hours: 24, demand: 1},
  N2: {label: '고수요 24시간 (수요 ×2.5)', hours: 24, demand: 2.5},
  M1: {label: '다수사상자: 평시 + 1시간 시점 강남 80명 동시 발생', hours: 6, demand: 1, burst: {at: 3600, n: 80, cells: [6]}},
  M2: {label: '고수요 + 대형 재난: 수요 ×1.5 + 1시간 시점 2개 격자 200명', hours: 6, demand: 1.5, burst: {at: 3600, n: 200, cells: [5, 6]}}
};
const POLICIES = ['sequential', 'global', 'batch:greedy_time', 'batch:greedy_cost', 'batch:priority', 'batch:regret', 'batch:ls',
  'batch:sa', 'batch:tabu', 'batch:ils', 'batch:vns', 'batch:lns', 'batch:alns', 'batch:grasp', 'batch:ga', 'batch:memetic', 'batch:aco', 'batch:pso'];
const SEEDS = [101, 202, 303];
const BUDGET_MS = 50;

function run(job){
  const world = createWorld();
  const sc = SCENARIOS[job.scenario], policy = job.policy, W = A.DEFAULT_PARAMS.ktasWeight;
  const H = world.makeHospitals();
  const init = world.seedInitialState(H, job.seed, 0);
  const patients = init.pre;
  const spawnRand = world.mulberry32(job.seed >>> 0), burstRand = world.mulberry32((job.seed*31 + 7) >>> 0);
  const hourOf = t => ((init.startHour*3600 + t) % 86400)/3600;
  const nextGap = t => Math.max(1, -Math.log(Math.max(Number.EPSILON, 1-spawnRand()))/world.sampler.arrivalRatePerSec(hourOf(t), {multiplier: sc.demand}));
  let simTime = 0, spawnTimer = nextGap(0), burstDone = !sc.burst, nextBatchAt = 0, newArrival = false;
  const M = {spawned: 0, failed: 0, assigned: 0, transitSum: 0, critN: 0, critTransitSum: 0, critFailed: 0, searchSum: 0,
             weightedDelaySum: 0, attemptsSum: 0, orWaitStarts: 0, erStaySum: 0, erDis: 0,
             solverCalls: 0, solverMsSum: 0, solverMsMax: 0, solverMs: [], maxBatch: 0, fullHospMin: 0, erOccSum: 0, erOccN: 0,
             burstFailed: 0, burstTransitSum: 0, burstAssigned: 0};
  const erCapTotal = H.reduce((s, h) => s + h.capacity, 0);

  function spawn(rand, cell, isBurst){
    const prof = world.sampler.sampleProfile(rand, hourOf(simTime));
    const p = world.attachTravel(Object.assign(prof, world.sampleLocation(rand, cell)), H);
    p.status = 'waiting'; p.waitElapsed = 0; p.burst = !!isBurst; p.spawnedAt = simTime;
    patients.push(p); M.spawned++; newArrival = true;
    if(policy === 'sequential'){
      p.candidateList = H.map((h, j) => j).filter(j => H[j].specialties.indexOf(p.requiredSpecialty) !== -1)
        .sort((a, b) => p.distM[a] - p.distM[b]);
      p.candidateIdx = 0; p.contactAttempts = 0; p.contactElapsed = 0; p.status = 'contacting';
    }
  }
  function eligible(p, h){
    if(h.occupied >= h.capacity) return false;
    if(h.specialties.indexOf(p.requiredSpecialty) === -1) return false;
    if(p.needsICU && h.icuOcc[p.requiredSpecialty] >= h.icuCap[p.requiredSpecialty]) return false;
    if(p.needsSurgery && h.orOcc >= h.orCap) return false;
    return true;
  }
  function assign(p, j, attempts){
    const h = H[j]; h.occupied++; if(p.needsICU) h.icuOcc[p.requiredSpecialty]++;
    p.hospitalIdx = j; p.status = 'transit'; p.elapsed = 0; p.duration = p.travelSec[j];
    M.assigned++; M.transitSum += p.duration; M.searchSum += p.waitElapsed; M.attemptsSum += attempts;
    M.weightedDelaySum += (W[p.ktasLevel]||1)*(p.waitElapsed + p.duration);
    if(p.ktasLevel <= 2){ M.critN++; M.critTransitSum += p.duration; }
    if(p.burst){ M.burstAssigned++; M.burstTransitSum += p.waitElapsed + p.duration; }
  }
  function fail(p){
    p.status = 'failed'; M.failed++; if(p.ktasLevel <= 2) M.critFailed++; if(p.burst) M.burstFailed++;
    // 실패 가중 지연: 한도(10분) + 2시간 벌점으로 집계
    M.weightedDelaySum += (W[p.ktasLevel]||1)*(WAIT_TIMEOUT_SEC + 7200);
  }

  function runBatch(){
    const waiting = patients.filter(p => p.status === 'waiting');
    if(!waiting.length) return;
    const solver = policy.slice(6);
    const inst = A.buildInstance(waiting, H.map(h => ({capacity: h.capacity, occupied: h.occupied, specialties: h.specialties,
      icuCap: h.icuCap, icuOcc: h.icuOcc, orCap: h.orCap, orOcc: h.orOcc})));
    const useMeta = A.SOLVERS[solver].kind === 'meta' && waiting.length >= 3;
    const res = A.solve(useMeta ? solver : (A.SOLVERS[solver].kind === 'meta' ? 'ls' : solver), inst, useMeta ? {timeLimitMs: BUDGET_MS, seed: job.seed} : {seed: job.seed});
    M.solverCalls++; M.solverMsSum += res.timeMs; M.solverMsMax = Math.max(M.solverMsMax, res.timeMs); M.solverMs.push(res.timeMs);
    M.maxBatch = Math.max(M.maxBatch, waiting.length);
    res.assignment.forEach((j, q) => { if(j >= 0) assign(waiting[q], j, 1); });
  }

  const endT = sc.hours*3600;
  while(simTime < endT){
    simTime += DT; spawnTimer -= DT;
    while(spawnTimer <= 0){ spawn(spawnRand); spawnTimer += nextGap(simTime); }
    if(!burstDone && simTime >= sc.burst.at){
      burstDone = true;
      for(let b=0;b<sc.burst.n;b++) spawn(burstRand, sc.burst.cells[(burstRand()*sc.burst.cells.length)|0], true);
    }
    if(policy.startsWith('batch:') && (newArrival || simTime >= nextBatchAt)){
      runBatch(); newArrival = false; nextBatchAt = simTime + BATCH_RETRY_SEC;
    }
    for(let i=patients.length-1;i>=0;i--){
      const p = patients[i];
      if(p.status === 'waiting'){
        p.waitElapsed += DT;
        if(policy === 'global'){
          let best = -1, bd = Infinity;
          for(let j=0;j<H.length;j++){ if(!eligible(p, H[j])) continue; if(p.distM[j] < bd){ bd = p.distM[j]; best = j; } }
          if(best >= 0) assign(p, best, 1); else if(p.waitElapsed > WAIT_TIMEOUT_SEC) fail(p);
        } else if(p.waitElapsed > WAIT_TIMEOUT_SEC) fail(p);
      } else if(p.status === 'contacting'){
        p.waitElapsed += DT;
        if(p.waitElapsed > WAIT_TIMEOUT_SEC){ fail(p); continue; }
        p.contactElapsed += DT;
        while(p.contactElapsed >= CONTACT_ATTEMPT_SEC && p.status === 'contacting'){
          p.contactElapsed -= CONTACT_ATTEMPT_SEC;
          const j = p.candidateList[p.candidateIdx % p.candidateList.length];
          p.contactAttempts++;
          if(eligible(p, H[j])) assign(p, j, p.contactAttempts);
          else { p.candidateIdx++; if(p.waitElapsed > WAIT_TIMEOUT_SEC) fail(p); }
        }
      } else if(p.status === 'transit'){
        p.elapsed += DT;
        if(p.elapsed >= p.duration){ p.status = 'treating'; p.treatRemaining = p.erLosSec; p.arrivedAt = simTime; }
      } else if(p.status === 'treating'){
        p.treatRemaining -= DT;
        if(p.treatRemaining <= 0){
          const h = H[p.hospitalIdx];
          if(p.needsSurgery && h.orOcc >= h.orCap){ if(!p.waitingOR){ p.waitingOR = true; M.orWaitStarts++; } continue; }
          h.occupied--;
          if(p.preexisting){ patients.splice(i, 1); continue; }
          M.erDis++; M.erStaySum += simTime - p.arrivedAt;
          if(p.needsSurgery){ h.orOcc++; p.status = 'surgery'; p.orRemaining = p.orSec; }
          else if(p.needsICU){ p.status = 'icu'; p.icuRemaining = p.icuLosSec; }
          else patients.splice(i, 1);
        }
      } else if(p.status === 'surgery'){
        p.orRemaining -= DT;
        if(p.orRemaining <= 0){
          H[p.hospitalIdx].orOcc--;
          if(p.needsICU){ p.status = 'icu'; p.icuRemaining = p.icuLosSec; } else patients.splice(i, 1);
        }
      } else if(p.status === 'icu'){
        p.icuRemaining -= DT;
        if(p.icuRemaining <= 0){ H[p.hospitalIdx].icuOcc[p.requiredSpecialty]--; patients.splice(i, 1); }
      } else if(p.status === 'failed'){
        patients.splice(i, 1);
      }
    }
    if(simTime % 60 === 0){
      let occ = 0, full = 0; H.forEach(h => { occ += h.occupied; if(h.occupied >= h.capacity) full++; });
      M.erOccSum += occ/erCapTotal; M.erOccN++; M.fullHospMin += full;
    }
  }
  const ms = M.solverMs.sort((a, b) => a - b);
  return {
    scenario: job.scenario, policy, seed: job.seed,
    spawned: M.spawned, failed: M.failed, failRatePct: M.failed/M.spawned*100, critFailed: M.critFailed,
    meanTransitMin: M.transitSum/Math.max(1, M.assigned)/60, critMeanTransitMin: M.critTransitSum/Math.max(1, M.critN)/60,
    meanSearchMin: M.searchSum/Math.max(1, M.assigned)/60, meanAttempts: M.attemptsSum/Math.max(1, M.assigned),
    weightedDelayPerPatientMin: M.weightedDelaySum/M.spawned/60,
    burstFailed: M.burstFailed, burstMeanArrivalMin: M.burstAssigned ? M.burstTransitSum/M.burstAssigned/60 : null,
    orWaitStarts: M.orWaitStarts, meanErStayH: M.erStaySum/Math.max(1, M.erDis)/3600,
    meanErOccPct: M.erOccSum/Math.max(1, M.erOccN)*100, fullHospitalHours: M.fullHospMin/60,
    solverCalls: M.solverCalls, solverMsTotal: M.solverMsSum, solverMsMean: M.solverCalls ? M.solverMsSum/M.solverCalls : 0,
    solverMsP95: ms.length ? ms[Math.floor(ms.length*0.95)] : 0, solverMsMax: M.solverMsMax, maxBatch: M.maxBatch
  };
}

if(process.argv[2] === '--child'){
  process.on('message', job => { process.send(run(job)); });
} else if(require.main === module){
  const jobs = [];
  const want = process.argv.slice(2);
  Object.keys(SCENARIOS).filter(s => !want.length || want.indexOf(s) >= 0).forEach(s =>
    SEEDS.forEach(seed => POLICIES.forEach(policy => jobs.push({scenario: s, policy, seed}))));
  const results = [], nWorkers = Math.max(1, Math.min(jobs.length, os.cpus().length - 2));
  let next = 0, doneN = 0;
  const t0 = Date.now();
  for(let w=0; w<nWorkers; w++){
    const child = fork(__filename, ['--child']);
    const feed = () => { if(next < jobs.length) child.send(jobs[next++]); else child.kill(); };
    child.on('message', r => {
      results.push(r); doneN++;
      process.stderr.write(`[${doneN}/${jobs.length}] ${r.scenario} ${r.policy} seed ${r.seed} fail ${r.failed}/${r.spawned} (${((Date.now()-t0)/1000).toFixed(0)}s)\n`);
      if(doneN === jobs.length){
        fs.mkdirSync(path.join(__dirname, 'results'), {recursive: true});
        const file = path.join(__dirname, 'results', 'online_results' + (want.length ? '_' + want.join('') : '') + '.json');
        fs.writeFileSync(file, JSON.stringify({scenarios: SCENARIOS, budgetMs: BUDGET_MS, workers: nWorkers, results}, null, 1));
      }
      feed();
    });
    feed();
  }
}

module.exports = {run, SCENARIOS, POLICIES};
