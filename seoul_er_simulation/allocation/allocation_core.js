// 15차(2026-10-14) — 메타휴리스틱 결합 배정(allocation) 코어.
// 브라우저(window.ErAllocation)와 node(module.exports) 양쪽에서 쓴다. DOM·지도와 무관한 순수 계산만 있다.
//
// ── 문제 정의 (배치 배정 = 다자원 일반화 할당 문제, GAP + 혼잡 비용) ─────────────────────────
// 한 결정 시점(epoch)에 대기 중인 환자 n명을 병원 m곳(서울 51곳)에 동시에 배정한다.
//   결정변수  a[i] ∈ {-1} ∪ cand[i]   (-1 = 이번 시점엔 배정 보류)
//   제약      병원 j의 응급실 잔여 병상, (ICU 필요 환자는) 진료계열 k 중환자실 잔여 병상을 넘지 않음.
//             진료계열 미표방·수술 필요인데 빈 수술실 없음 → 후보(cand)에서 아예 제외(정적 적격성,
//             시뮬레이션 isHospitalEligible()과 같은 조건).
//   목적(초 단위, 최소화)
//     Σ_배정  w_i · t_ij                         중증도 가중 이송시간 (t = 카카오 실도로 소요시간)
//   + Σ_보류  w_i · P                            배정 보류 벌점 (P = 2시간)
//   + Σ_j Σ_{c=1..n_j} Ce · ((o_j+c)/cap_j)^2     응급실 혼잡 비용 (볼록, 몰림 방지)
//   + Σ_jk Σ_{c=1..n_jk} Ci · ((o_jk+c)/cap_jk)^2  중환자실 혼잡 비용
//   w = KTAS 가중치(기본 1:8, 2:4, 3:2, 4:1, 5:1). 혼잡 항 때문에 목적이 비선형 → 정확해(MILP/CP)는
//   n이 커지면 느려지고, 메타휴리스틱이 의미를 가진다. Ce=Ci=0 이면 선형 GAP.
//
// ── 해법 ────────────────────────────────────────────────────────────────────────────────
//   구성형:  greedy_current(현재 GLOBAL과 같은 직선거리 최근접), greedy_time(도로시간 최근접),
//            greedy_cost(목적함수 한계비용), priority(중증·희소 우선), regret(regret-2 삽입)
//   개선형(단일해): ls(국소탐색), sa(담금질), tabu(타부), ils(반복 국소탐색), vns(가변 이웃),
//            lns(대규모 이웃), alns(적응형 LNS)
//   개체군:  ga(유전), memetic(유전+국소탐색), aco(개미 집락, MMAS), pso(랜덤키 입자군집), grasp
// 모든 개선형/개체군 해법은 priority 해를 초기해(warm start)로 쓰고, 시간 한도(timeLimitMs) 또는
// 반복 한도(maxIters) 중 먼저 닿는 쪽에서 멈춘다.
(function(root){
  'use strict';

  var ICU_TYPES = ['신생아','소아','일반','내과','외과','신경외과','심장내과','흉부외과','신경과'];
  var K = ICU_TYPES.length;
  var DEFAULT_PARAMS = {
    ktasWeight: {1:8, 2:4, 3:2, 4:1, 5:1},
    // 2시간: 캐시 최장 이송(약 100분) + 혼잡 최대(600초)보다 커서, 배정 가능한 환자를 보류하는 해가 더 싸지 않다
    unassignedPenaltySec: 7200,
    erCrowdSec: 300,
    icuCrowdSec: 300
  };

  var now = (typeof performance !== 'undefined' && performance.now) ? function(){ return performance.now(); } : function(){ return Date.now(); };

  function mulberry32(seed){
    return function(){
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------------------------
  // 인스턴스
  //  patients[i] = {ktasLevel, requiredSpecialty, needsICU, needsSurgery, travelSec:[m], distM?:[m]}
  //  hospitals[j] = {capacity, occupied, specialties:[...], icuCap:{k:n}, icuOcc:{k:n}, orCap, orOcc}
  // ---------------------------------------------------------------------------------------
  function buildInstance(patients, hospitals, params){
    params = Object.assign({}, DEFAULT_PARAMS, params || {});
    var n = patients.length, m = hospitals.length;
    var inst = {
      n: n, m: m, params: params,
      w: new Float64Array(n), icuK: new Int32Array(n),
      t: new Float64Array(n*m), d: null,
      cand: [], erFree: new Int32Array(m), icuFree: new Int32Array(m*K),
      erMargOff: new Int32Array(m), icuMargOff: new Int32Array(m*K), marg: null
    };
    var hasDist = n > 0 && !!patients[0].distM;
    if(hasDist) inst.d = new Float64Array(n*m);
    // 한계 혼잡비용 표: c번째 추가 환자의 비용 = C·((o+c)/cap)^2, c=1..free
    var margList = [0], j, k, c;
    for(j=0;j<m;j++){
      var H = hospitals[j];
      inst.erFree[j] = Math.max(0, H.capacity - H.occupied);
      inst.erMargOff[j] = margList.length - 1;              // marg[off + c]
      for(c=1;c<=inst.erFree[j];c++) margList.push(params.erCrowdSec * Math.pow((H.occupied + c)/H.capacity, 2));
      for(k=0;k<K;k++){
        var cap = (H.icuCap && H.icuCap[ICU_TYPES[k]]) || 0, occ = (H.icuOcc && H.icuOcc[ICU_TYPES[k]]) || 0;
        var free = Math.max(0, cap - occ);
        inst.icuFree[j*K+k] = free;
        inst.icuMargOff[j*K+k] = margList.length - 1;
        for(c=1;c<=free;c++) margList.push(params.icuCrowdSec * Math.pow((occ + c)/cap, 2));
      }
    }
    inst.marg = Float64Array.from(margList);
    for(var i=0;i<n;i++){
      var p = patients[i];
      inst.w[i] = params.ktasWeight[p.ktasLevel] || 1;
      inst.icuK[i] = p.needsICU ? ICU_TYPES.indexOf(p.requiredSpecialty) : -1;
      var cand = [];
      for(j=0;j<m;j++){
        inst.t[i*m+j] = p.travelSec[j];
        if(hasDist) inst.d[i*m+j] = p.distM[j];
        var H2 = hospitals[j];
        if(H2.specialties.indexOf(p.requiredSpecialty) === -1) continue;
        if(p.needsSurgery && H2.orOcc >= H2.orCap) continue;
        if(inst.erFree[j] <= 0) continue;
        if(inst.icuK[i] >= 0 && inst.icuFree[j*K+inst.icuK[i]] <= 0) continue;
        cand.push(j);
      }
      cand.sort(function(a,b){ return inst.t[i*m+a] - inst.t[i*m+b]; });
      inst.cand.push(Int32Array.from(cand));
    }
    return inst;
  }

  // ---------------------------------------------------------------------------------------
  // 해(solution) 상태 + 증분 평가
  // ---------------------------------------------------------------------------------------
  function emptySol(inst){
    var a = new Int32Array(inst.n); a.fill(-1);
    var s = {a: a, erN: new Int32Array(inst.m), icuN: new Int32Array(inst.m*K), cost: 0};
    for(var i=0;i<inst.n;i++) s.cost += inst.w[i]*inst.params.unassignedPenaltySec;
    return s;
  }
  function cloneSol(s){ return {a: s.a.slice(), erN: s.erN.slice(), icuN: s.icuN.slice(), cost: s.cost}; }
  function copyInto(dst, src){ dst.a.set(src.a); dst.erN.set(src.erN); dst.icuN.set(src.icuN); dst.cost = src.cost; }

  // 환자 i를 j에 "추가"할 때의 비용(혼잡 한계비용 포함). 불가능하면 Infinity.
  function addCost(inst, s, i, j){
    if(j < 0) return inst.w[i]*inst.params.unassignedPenaltySec;
    var ne = s.erN[j] + 1;
    if(ne > inst.erFree[j]) return Infinity;
    var c = inst.w[i]*inst.t[i*inst.m+j] + inst.marg[inst.erMargOff[j] + ne];
    var k = inst.icuK[i];
    if(k >= 0){
      var jk = j*K+k, ni = s.icuN[jk] + 1;
      if(ni > inst.icuFree[jk]) return Infinity;
      c += inst.marg[inst.icuMargOff[jk] + ni];
    }
    return c;
  }
  // 환자 i를 현재 병원에서 "빼낼" 때 줄어드는 비용
  function removeGain(inst, s, i){
    var j = s.a[i];
    if(j < 0) return inst.w[i]*inst.params.unassignedPenaltySec;
    var c = inst.w[i]*inst.t[i*inst.m+j] + inst.marg[inst.erMargOff[j] + s.erN[j]];
    var k = inst.icuK[i];
    if(k >= 0){ var jk = j*K+k; c += inst.marg[inst.icuMargOff[jk] + s.icuN[jk]]; }
    return c;
  }
  function detach(inst, s, i){
    var j = s.a[i]; if(j < 0) return;
    s.erN[j]--; if(inst.icuK[i] >= 0) s.icuN[j*K+inst.icuK[i]]--; s.a[i] = -1;
  }
  function attach(inst, s, i, j){
    s.a[i] = j; if(j < 0) return;
    s.erN[j]++; if(inst.icuK[i] >= 0) s.icuN[j*K+inst.icuK[i]]++;
  }
  function deltaMove(inst, s, i, j){
    var from = s.a[i]; if(from === j) return 0;
    var g = removeGain(inst, s, i);
    detach(inst, s, i);
    var c = addCost(inst, s, i, j);
    attach(inst, s, i, from);
    return c - g;
  }
  function applyMove(inst, s, i, j, delta){
    detach(inst, s, i); attach(inst, s, i, j); s.cost += delta;
  }
  function deltaSwap(inst, s, i1, i2){
    var j1 = s.a[i1], j2 = s.a[i2];
    if(j1 === j2) return Infinity;
    if(j2 >= 0 && !inCand(inst, i1, j2)) return Infinity;
    if(j1 >= 0 && !inCand(inst, i2, j1)) return Infinity;
    var before = s.cost;
    var d1 = deltaMove(inst, s, i1, -1); applyMove(inst, s, i1, -1, d1);
    var d2 = deltaMove(inst, s, i2, j1);
    if(d2 === Infinity){ applyMove(inst, s, i1, j1, -d1); s.cost = before; return Infinity; }
    applyMove(inst, s, i2, j1, d2);
    var d3 = deltaMove(inst, s, i1, j2);
    // 원상 복구
    applyMove(inst, s, i2, j2, -d2);
    applyMove(inst, s, i1, j1, -d1);
    s.cost = before;
    return d3 === Infinity ? Infinity : d1 + d2 + d3;
  }
  function applySwap(inst, s, i1, i2, delta){
    var j1 = s.a[i1], j2 = s.a[i2];
    detach(inst, s, i1); detach(inst, s, i2); attach(inst, s, i1, j2); attach(inst, s, i2, j1); s.cost += delta;
  }
  function inCand(inst, i, j){
    var c = inst.cand[i];
    for(var q=0;q<c.length;q++) if(c[q] === j) return true;
    return false;
  }

  // 전체 재계산(검증용)
  function evaluate(inst, a){
    var s = emptySol(inst), ok = true;
    for(var i=0;i<inst.n;i++){
      var j = a[i]; if(j < 0) continue;
      if(!inCand(inst, i, j)){ ok = false; continue; }
      var d = deltaMove(inst, s, i, j);
      if(d === Infinity){ ok = false; continue; }
      applyMove(inst, s, i, j, d);
    }
    return {cost: s.cost, feasible: ok, sol: s};
  }
  function summarize(inst, a){
    var assigned = 0, wt = 0, tt = 0, crit = 0, critT = 0, unW = 0;
    for(var i=0;i<inst.n;i++){
      var j = a[i];
      if(j < 0){ unW += inst.w[i]; continue; }
      assigned++; var t = inst.t[i*inst.m+j]; tt += t; wt += inst.w[i]*t;
      if(inst.w[i] >= 4){ crit++; critT += t; }
    }
    return {assigned: assigned, unassigned: inst.n - assigned, meanTravelMin: assigned ? tt/assigned/60 : 0,
            weightedTravel: wt, critMeanTravelMin: crit ? critT/crit/60 : 0};
  }

  // ---------------------------------------------------------------------------------------
  // 구성형 휴리스틱
  // ---------------------------------------------------------------------------------------
  // 순서대로 하나씩, score(i,j)가 가장 작은 적격 병원에 넣는다.
  function greedyInOrder(inst, order, score, s){
    s = s || emptySol(inst);
    for(var q=0;q<order.length;q++){
      var i = order[q]; if(s.a[i] >= 0) continue;
      var best = -1, bestScore = Infinity, bestDelta = 0, c = inst.cand[i];
      for(var r=0;r<c.length;r++){
        var j = c[r], dl = deltaMove(inst, s, i, j);
        if(dl === Infinity) continue;
        var sc = score ? score(i, j, dl) : dl;
        if(sc < bestScore){ bestScore = sc; best = j; bestDelta = dl; }
      }
      if(best >= 0) applyMove(inst, s, i, best, bestDelta);
    }
    return s;
  }
  function identityOrder(n){ var o = []; for(var i=0;i<n;i++) o.push(i); return o; }
  function priorityOrder(inst){
    // 중증(w 큰) → 후보 적은(희소 자원) → 원래 순서
    return identityOrder(inst.n).sort(function(a,b){
      return (inst.w[b]-inst.w[a]) || (inst.cand[a].length - inst.cand[b].length) || (a-b);
    });
  }

  // 현재 화면의 GLOBAL 모드와 같은 기준: 발생 순서대로 직선거리 최근접 적격 병원
  function solveGreedyCurrent(inst){
    var d = inst.d || inst.t;
    return greedyInOrder(inst, identityOrder(inst.n), function(i, j){ return d[i*inst.m+j]; });
  }
  function solveGreedyTime(inst){
    return greedyInOrder(inst, identityOrder(inst.n), function(i, j){ return inst.t[i*inst.m+j]; });
  }
  function solveGreedyCost(inst){ return greedyInOrder(inst, identityOrder(inst.n), null); }
  function solvePriority(inst){ return greedyInOrder(inst, priorityOrder(inst), null); }

  // regret-2 삽입: (2순위 비용 − 1순위 비용)이 가장 큰 환자부터 확정
  function regretRepair(inst, s, pool, rng, noise){
    pool = pool.slice();
    while(pool.length){
      var bestQ = -1, bestReg = -Infinity, bestJ = -1, bestD = 0;
      for(var q=0;q<pool.length;q++){
        var i = pool[q], c = inst.cand[i], b1 = Infinity, b2 = Infinity, j1 = -1;
        for(var r=0;r<c.length;r++){
          var dl = deltaMove(inst, s, i, c[r]);
          if(dl < b1){ b2 = b1; b1 = dl; j1 = c[r]; } else if(dl < b2){ b2 = dl; }
        }
        if(b2 > 0) b2 = 0;                           // 2순위가 없으면 "보류"(증분 0)가 2순위
        var reg = (j1 < 0) ? -Infinity : (b2 - b1);
        if(noise) reg *= 1 + noise*(rng()-0.5);
        if(reg > bestReg || bestQ < 0){ bestReg = reg; bestQ = q; bestJ = j1; bestD = b1; }
      }
      var ii = pool[bestQ];
      if(bestJ >= 0) applyMove(inst, s, ii, bestJ, bestD);
      pool.splice(bestQ, 1);
    }
    return s;
  }
  function solveRegret(inst){ return regretRepair(inst, emptySol(inst), identityOrder(inst.n)); }

  // ---------------------------------------------------------------------------------------
  // 국소탐색 (relocate + swap, best-improvement 한 바퀴씩)
  // ---------------------------------------------------------------------------------------
  function localSearch(inst, s, deadline, counter){
    var improved = true, n = inst.n;
    while(improved){
      improved = false;
      // relocate (보류 포함)
      for(var i=0;i<n;i++){
        var c = inst.cand[i], bestD = -1e-9, bestJ = -2;
        for(var r=-1;r<c.length;r++){
          var j = r < 0 ? -1 : c[r]; if(j === s.a[i]) continue;
          var dl = deltaMove(inst, s, i, j);
          if(dl < bestD){ bestD = dl; bestJ = j; }
        }
        if(bestJ !== -2){ applyMove(inst, s, i, bestJ, bestD); improved = true; }
        if(counter) counter.n++;
      }
      // swap (서로 다른 병원)
      for(var i1=0;i1<n;i1++){
        if(deadline && (i1 & 15) === 0 && now() > deadline) return s;
        for(var i2=i1+1;i2<n;i2++){
          if(s.a[i1] === s.a[i2]) continue;
          var ds = deltaSwap(inst, s, i1, i2);
          if(ds < -1e-9){ applySwap(inst, s, i1, i2, ds); improved = true; }
        }
        if(counter) counter.n++;
      }
      if(deadline && now() > deadline) return s;
    }
    return s;
  }
  function solveLS(inst){ return localSearch(inst, solvePriority(inst)); }

  // 무작위 이웃 하나 (relocate 70% / swap 30%)
  function randomNeighbor(inst, s, rng, out){
    var n = inst.n;
    if(n >= 2 && rng() < 0.3){
      var i1 = (rng()*n)|0, i2 = (rng()*n)|0;
      if(i1 === i2) return false;
      var ds = deltaSwap(inst, s, i1, i2); if(ds === Infinity) return false;
      out.type = 1; out.i = i1; out.j = i2; out.delta = ds; return true;
    }
    var i = (rng()*n)|0, c = inst.cand[i];
    var j = (c.length === 0 || rng() < 0.05) ? -1 : c[(rng()*Math.min(c.length, 12))|0]; // 가까운 12곳 위주
    if(j === s.a[i]) return false;
    var dl = deltaMove(inst, s, i, j); if(dl === Infinity) return false;
    out.type = 0; out.i = i; out.j = j; out.delta = dl; return true;
  }
  function applyNeighbor(inst, s, mv){
    if(mv.type === 0) applyMove(inst, s, mv.i, mv.j, mv.delta); else applySwap(inst, s, mv.i, mv.j, mv.delta);
  }

  // ---------------------------------------------------------------------------------------
  // 담금질 기법 (Simulated Annealing)
  // ---------------------------------------------------------------------------------------
  function solveSA(inst, opts){
    var rng = mulberry32(opts.seed), s = solvePriority(inst), best = cloneSol(s);
    if(inst.n === 0) return best;
    var mv = {}, deadline = opts.deadline, maxIt = opts.maxIters || Infinity;
    // 초기 온도: 무작위 상승 이동 평균의 −1/ln(0.3)배 (상승 이동 30% 수락)
    var up = 0, cnt = 0;
    for(var q=0;q<200;q++) if(randomNeighbor(inst, s, rng, mv) && mv.delta > 0){ up += mv.delta; cnt++; }
    var T0 = cnt ? (up/cnt)/(-Math.log(0.3)) : 1, Tend = T0*1e-3, T = T0;
    var it = 0, start = now(), total = deadline ? Math.max(1e-3, deadline - start) : maxIt;   // 초기해 단계가 한도를 이미 넘겼으면 0에 가까운 값 → 바로 종료
    while(it < maxIt){
      if((it & 255) === 0){
        var frac = deadline ? (now()-start)/total : it/maxIt;
        if(frac >= 1) break;
        T = T0*Math.pow(Tend/T0, frac);
      }
      it++;
      if(!randomNeighbor(inst, s, rng, mv)) continue;
      if(mv.delta <= 0 || rng() < Math.exp(-mv.delta/T)){
        applyNeighbor(inst, s, mv);
        if(s.cost < best.cost - 1e-9) copyInto(best, s);
      }
    }
    best.iters = it;
    return localSearch(inst, best);
  }

  // ---------------------------------------------------------------------------------------
  // 타부 탐색 (Tabu Search) — relocate 이웃 전체(또는 표본) 중 최선의 비금지 이동
  // ---------------------------------------------------------------------------------------
  function solveTabu(inst, opts){
    var rng = mulberry32(opts.seed), s = localSearch(inst, solvePriority(inst)), best = cloneSol(s);
    var n = inst.n, m = inst.m; if(n === 0) return best;
    var tabuUntil = new Int32Array(n*(m+1));      // (환자, 병원+1) 로 돌아가는 것을 금지
    var it = 0, maxIt = opts.maxIters || Infinity, deadline = opts.deadline;
    var sampleN = Math.min(n, 40);
    while(it < maxIt && !(deadline && now() > deadline)){
      it++;
      var bestD = Infinity, bi = -1, bj = -2;
      for(var q=0;q<sampleN;q++){
        var i = sampleN === n ? q : (rng()*n)|0, c = inst.cand[i];
        for(var r=-1;r<c.length;r++){
          var j = r < 0 ? -1 : c[r]; if(j === s.a[i]) continue;
          var dl = deltaMove(inst, s, i, j); if(dl === Infinity) continue;
          var isTabu = tabuUntil[i*(m+1)+j+1] > it;
          if(isTabu && s.cost + dl >= best.cost - 1e-9) continue;   // 열망 기준
          if(dl < bestD){ bestD = dl; bi = i; bj = j; }
        }
      }
      if(bi < 0) break;
      tabuUntil[bi*(m+1)+s.a[bi]+1] = it + 7 + ((rng()*7)|0);
      applyMove(inst, s, bi, bj, bestD);
      if(s.cost < best.cost - 1e-9) copyInto(best, s);
    }
    best.iters = it;
    return best;
  }

  // ---------------------------------------------------------------------------------------
  // 반복 국소탐색 (ILS) / 가변 이웃 탐색 (VNS)
  // ---------------------------------------------------------------------------------------
  function perturb(inst, s, rng, k){
    var mv = {};
    for(var q=0, tries=0; q<k && tries<k*20; tries++){
      if(randomNeighbor(inst, s, rng, mv)){ applyNeighbor(inst, s, mv); q++; }
    }
  }
  function solveILS(inst, opts){
    var rng = mulberry32(opts.seed), s = localSearch(inst, solvePriority(inst)), best = cloneSol(s), cur = cloneSol(s);
    var it = 0, maxIt = opts.maxIters || Infinity, k = Math.max(2, Math.round(inst.n*0.1));
    if(inst.n === 0) return best;
    while(it < maxIt && !(opts.deadline && now() > opts.deadline)){
      it++;
      copyInto(s, cur);
      perturb(inst, s, rng, k);
      localSearch(inst, s, opts.deadline);
      if(s.cost < cur.cost - 1e-9 || rng() < 0.05) copyInto(cur, s);   // 더 좋으면 이동, 가끔 수락
      if(s.cost < best.cost - 1e-9) copyInto(best, s);
    }
    best.iters = it;
    return best;
  }
  function solveVNS(inst, opts){
    var rng = mulberry32(opts.seed), cur = localSearch(inst, solvePriority(inst)), best = cloneSol(cur), s = cloneSol(cur);
    var kmax = Math.max(3, Math.min(30, Math.round(inst.n*0.3))), k = 1, it = 0, maxIt = opts.maxIters || Infinity;
    if(inst.n === 0) return best;
    while(it < maxIt && !(opts.deadline && now() > opts.deadline)){
      it++;
      copyInto(s, cur);
      perturb(inst, s, rng, k);
      localSearch(inst, s, opts.deadline);
      if(s.cost < cur.cost - 1e-9){ copyInto(cur, s); k = 1; if(s.cost < best.cost) copyInto(best, s); }
      else { k = k >= kmax ? 1 : k + 1; }
    }
    best.iters = it;
    return best;
  }

  // ---------------------------------------------------------------------------------------
  // LNS / ALNS — 파괴(destroy) 후 재건(repair)
  // ---------------------------------------------------------------------------------------
  function destroyRandom(inst, s, rng, q){
    var out = [], seen = new Uint8Array(inst.n);
    while(out.length < q){ var i = (rng()*inst.n)|0; if(!seen[i]){ seen[i] = 1; out.push(i); } }
    return out;
  }
  function destroyWorst(inst, s, rng, q){
    // 기여 비용(가중 이송시간, 보류 벌점)이 큰 순 — 무작위성 p=3
    var ord = identityOrder(inst.n).map(function(i){ return [i, removeGain(inst, s, i) - (s.a[i] >= 0 ? inst.t[i*inst.m+inst.cand[i][0]]*inst.w[i] : 0)]; });
    ord.sort(function(x,y){ return y[1]-x[1]; });
    var out = [], seen = new Uint8Array(inst.n);
    while(out.length < q){
      var idx = Math.floor(Math.pow(rng(), 3)*ord.length), i = ord[idx][0];
      if(!seen[i]){ seen[i] = 1; out.push(i); }
    }
    return out;
  }
  function destroyRelated(inst, s, rng, q){
    // Shaw 관련성: 무작위 기준 환자와 "가까운 병원 후보가 비슷한" 환자들(이송시간 벡터 거리)
    var seed = (rng()*inst.n)|0, m = inst.m;
    var ord = identityOrder(inst.n).map(function(i){
      var dsum = 0; for(var j=0;j<m;j+=3) dsum += Math.abs(inst.t[i*m+j]-inst.t[seed*m+j]);
      return [i, dsum + (s.a[i] === s.a[seed] ? 0 : 600)];
    });
    ord.sort(function(x,y){ return x[1]-y[1]; });
    var out = [];
    for(var r=0;r<ord.length && out.length<q;r++) if(rng() < 0.9 || ord.length - r <= q - out.length) out.push(ord[r][0]);
    return out;
  }
  function destroyHospital(inst, s, rng, q){
    // 가장 붐비는(혼잡 한계비용 큰) 병원 한두 곳의 환자를 통째로 빼냄
    var load = [];
    for(var j=0;j<inst.m;j++) if(s.erN[j] > 0) load.push([j, inst.marg[inst.erMargOff[j]+s.erN[j]]]);
    if(!load.length) return destroyRandom(inst, s, rng, q);
    load.sort(function(x,y){ return y[1]-x[1]; });
    var out = [], picked = 0;
    while(out.length < q && picked < load.length){
      var jj = load[Math.min(load.length-1, (Math.pow(rng(),2)*load.length)|0)][0]; picked++;
      for(var i=0;i<inst.n && out.length<q;i++) if(s.a[i] === jj && out.indexOf(i) < 0) out.push(i);
    }
    if(out.length < q){ var extra = destroyRandom(inst, s, rng, q); for(var e=0;e<extra.length && out.length<q;e++) if(out.indexOf(extra[e])<0) out.push(extra[e]); }
    return out;
  }
  function removeAll(inst, s, list){
    for(var q=0;q<list.length;q++){ var i = list[q]; var d = deltaMove(inst, s, i, -1); applyMove(inst, s, i, -1, d); }
  }
  function repairGreedy(inst, s, list, rng){
    var ord = list.slice().sort(function(a,b){ return (inst.w[b]-inst.w[a]) || (rng()-0.5); });
    return greedyInOrder(inst, ord, null, s);
  }
  function repairRegret(inst, s, list, rng){ return regretRepair(inst, s, list, rng, 0.2); }

  function solveLNS(inst, opts){
    var rng = mulberry32(opts.seed), cur = localSearch(inst, solvePriority(inst)), best = cloneSol(cur), s = cloneSol(cur);
    var it = 0, maxIt = opts.maxIters || Infinity;
    if(inst.n < 2) return best;
    while(it < maxIt && !(opts.deadline && now() > opts.deadline)){
      it++;
      copyInto(s, cur);
      var q = Math.max(2, Math.round(inst.n*(0.1 + 0.25*rng())));
      var rem = destroyRandom(inst, s, rng, q);
      removeAll(inst, s, rem);
      repairRegret(inst, s, rem, rng);
      if(s.cost < cur.cost - 1e-9){ copyInto(cur, s); if(s.cost < best.cost) copyInto(best, s); }
    }
    best.iters = it;
    return best;
  }

  function solveALNS(inst, opts){
    var rng = mulberry32(opts.seed), cur = localSearch(inst, solvePriority(inst)), best = cloneSol(cur), s = cloneSol(cur);
    if(inst.n < 2) return best;
    var D = [destroyRandom, destroyWorst, destroyRelated, destroyHospital], R = [repairGreedy, repairRegret];
    var wD = [1,1,1,1], wR = [1,1], sD = [0,0,0,0], sR = [0,0], uD = [0,0,0,0], uR = [0,0];
    var SIG = [33, 9, 13], RHO = 0.1, SEG = 50;
    function pick(w){ var t = 0, k; for(k=0;k<w.length;k++) t += w[k]; var u = rng()*t; for(k=0;k<w.length;k++){ u -= w[k]; if(u <= 0) return k; } return w.length-1; }
    var T0 = Math.max(1, cur.cost*0.002), T = T0, it = 0, maxIt = opts.maxIters || Infinity, start = now();
    var total = opts.deadline ? Math.max(1e-3, opts.deadline - start) : maxIt;   // 초기 LS가 한도를 넘긴 경우 음수가 되어 무한 반복하던 버그 방지
    while(it < maxIt){
      var frac = opts.deadline ? (now()-start)/total : it/maxIt;
      if(frac >= 1) break;
      T = T0*Math.pow(1e-3, frac);
      it++;
      var di = pick(wD), ri = pick(wR);
      copyInto(s, cur);
      var q = Math.max(2, Math.round(inst.n*(0.1 + 0.3*rng())));
      var rem = D[di](inst, s, rng, Math.min(q, inst.n));
      removeAll(inst, s, rem);
      R[ri](inst, s, rem, rng);
      var score = 0;
      if(s.cost < best.cost - 1e-9){ copyInto(best, s); copyInto(cur, s); score = SIG[0]; }
      else if(s.cost < cur.cost - 1e-9){ copyInto(cur, s); score = SIG[1]; }
      else if(rng() < Math.exp(-(s.cost-cur.cost)/T)){ copyInto(cur, s); score = SIG[2]; }
      sD[di] += score; uD[di]++; sR[ri] += score; uR[ri]++;
      if(it % SEG === 0){
        for(var a=0;a<wD.length;a++){ if(uD[a]) wD[a] = (1-RHO)*wD[a] + RHO*sD[a]/uD[a]; wD[a] = Math.max(wD[a], 0.05); sD[a]=0; uD[a]=0; }
        for(var b=0;b<wR.length;b++){ if(uR[b]) wR[b] = (1-RHO)*wR[b] + RHO*sR[b]/uR[b]; wR[b] = Math.max(wR[b], 0.05); sR[b]=0; uR[b]=0; }
      }
    }
    best.iters = it;
    best.operatorWeights = {destroy: wD.slice(), repair: wR.slice()};
    return localSearch(inst, best);
  }

  // ---------------------------------------------------------------------------------------
  // 개체군 기반: GA / Memetic / ACO / PSO / GRASP
  // ---------------------------------------------------------------------------------------
  // 염색체(병원 배열)를 실행 가능해로 고친다: 용량 넘치면 경량 환자부터 빼고, 빠진 환자는 greedy 재삽입
  function repairChromosome(inst, genes, rng){
    var s = emptySol(inst), order = identityOrder(inst.n).sort(function(a,b){ return (inst.w[b]-inst.w[a]) || (rng()-0.5); });
    var left = [];
    for(var q=0;q<order.length;q++){
      var i = order[q], j = genes[i];
      if(j >= 0){ var d = deltaMove(inst, s, i, j); if(d !== Infinity){ applyMove(inst, s, i, j, d); continue; } }
      left.push(i);
    }
    return greedyInOrder(inst, left, null, s);
  }
  function randomizedGreedy(inst, rng, alpha){
    // GRASP 구성: 중증 순서(동점 무작위), 한계비용 RCL(최소 + alpha·범위) 안에서 무작위 선택
    var s = emptySol(inst), order = priorityOrder(inst);
    for(var q=0;q<order.length;q++){
      var i = order[q], c = inst.cand[i], ds = [], lo = Infinity, hi = -Infinity;
      for(var r=0;r<c.length;r++){ var d = deltaMove(inst, s, i, c[r]); if(d === Infinity) continue; ds.push([c[r], d]); if(d<lo) lo=d; if(d>hi) hi=d; }
      if(!ds.length) continue;
      var th = lo + alpha*(hi-lo), rcl = ds.filter(function(x){ return x[1] <= th; });
      var pickx = rcl[(rng()*rcl.length)|0];
      applyMove(inst, s, i, pickx[0], pickx[1]);
    }
    return s;
  }
  function solveGRASP(inst, opts){
    var rng = mulberry32(opts.seed), best = localSearch(inst, solvePriority(inst)), it = 0, maxIt = opts.maxIters || Infinity;
    while(it < maxIt && !(opts.deadline && now() > opts.deadline)){
      it++;
      var s = localSearch(inst, randomizedGreedy(inst, rng, 0.15), opts.deadline);
      if(s.cost < best.cost - 1e-9) best = s;
    }
    best.iters = it;
    return best;
  }

  function solveGA(inst, opts, memetic){
    var rng = mulberry32(opts.seed), P = 30, n = inst.n;
    if(n === 0) return emptySol(inst);
    var pop = [localSearch(inst, solvePriority(inst))];
    while(pop.length < P) pop.push(memetic ? localSearch(inst, randomizedGreedy(inst, rng, 0.3)) : randomizedGreedy(inst, rng, 0.3));
    pop.sort(function(x,y){ return x.cost-y.cost; });
    var gen = 0, maxIt = opts.maxIters || Infinity, pm = Math.max(1/n, 0.02);
    function tour(){ var a = pop[(rng()*P)|0], b = pop[(rng()*P)|0]; return a.cost < b.cost ? a : b; }
    while(gen < maxIt && !(opts.deadline && now() > opts.deadline)){
      gen++;
      var next = [cloneSol(pop[0]), cloneSol(pop[1])];                   // 엘리트 2
      while(next.length < P){
        var p1 = tour(), p2 = tour(), genes = new Int32Array(n);
        for(var i=0;i<n;i++){
          genes[i] = rng() < 0.5 ? p1.a[i] : p2.a[i];                     // 균등 교차
          if(rng() < pm){ var c = inst.cand[i]; genes[i] = c.length ? c[(rng()*Math.min(c.length, 10))|0] : -1; }  // 돌연변이
        }
        var child = repairChromosome(inst, genes, rng);
        if(memetic) localSearch(inst, child, opts.deadline);
        next.push(child);
      }
      pop = next.sort(function(x,y){ return x.cost-y.cost; });
    }
    var best = pop[0]; best.iters = gen;
    return memetic ? best : localSearch(inst, best);
  }

  function solveACO(inst, opts){
    // MAX-MIN Ant System. 페로몬 τ[i][r] (r = 후보 순위), 휴리스틱 η = 1/(한계비용 + 60)
    var rng = mulberry32(opts.seed), n = inst.n, ants = 15, alpha = 1, beta = 2, rho = 0.1;
    var best = localSearch(inst, solvePriority(inst));
    if(n === 0) return best;
    var tau = inst.cand.map(function(c){ return new Float64Array(c.length + 1).fill(1); });   // 마지막 칸 = 보류
    var tmax = 1, tmin = 0.01, order = priorityOrder(inst), it = 0, maxIt = opts.maxIters || Infinity;
    var prob = new Float64Array(52), dl = new Float64Array(52);
    while(it < maxIt && !(opts.deadline && now() > opts.deadline)){
      it++;
      var iterBest = null;
      for(var k=0;k<ants;k++){
        var s = emptySol(inst);
        for(var q=0;q<n;q++){
          var i = order[q], c = inst.cand[i], tot = 0, L = c.length;
          for(var r=0;r<=L;r++){
            // 후보 r의 휴리스틱 = 1/(배정 비용 + 60). 마지막 칸(보류)의 비용은 보류 벌점.
            var d = r < L ? deltaMove(inst, s, i, c[r]) : 0;
            var cost = r < L ? d + inst.w[i]*inst.params.unassignedPenaltySec : inst.w[i]*inst.params.unassignedPenaltySec;
            prob[r] = d === Infinity ? 0 : Math.pow(tau[i][r], alpha) * Math.pow(1/(Math.max(0, cost)+60), beta);
            dl[r] = d; tot += prob[r];
          }
          var u = rng()*tot, sel = L;
          for(var r2=0;r2<=L;r2++){ u -= prob[r2]; if(u <= 0){ sel = r2; break; } }
          if(sel < L) applyMove(inst, s, i, c[sel], dl[sel]);
        }
        if(!iterBest || s.cost < iterBest.cost) iterBest = s;
      }
      localSearch(inst, iterBest, opts.deadline);
      if(iterBest.cost < best.cost - 1e-9) best = cloneSol(iterBest);
      tmax = 1/(rho*Math.max(1, best.cost/1000)); tmin = tmax/(2*n);
      var src = rng() < 0.5 ? iterBest : best;
      for(var i2=0;i2<n;i2++){
        var t = tau[i2], c2 = inst.cand[i2];
        for(var r3=0;r3<t.length;r3++) t[r3] = Math.max(tmin, t[r3]*(1-rho));
        var rr = src.a[i2] < 0 ? c2.length : Array.prototype.indexOf.call(c2, src.a[i2]);
        t[rr] = Math.min(tmax, t[rr] + 1/Math.max(1, src.cost/1000));
      }
    }
    best.iters = it;
    return best;
  }

  function solvePSO(inst, opts){
    // 랜덤 키 PSO: 입자 위치 x ∈ R^n = 환자 처리 우선순위 → 순서대로 한계비용 greedy로 해독
    var rng = mulberry32(opts.seed), n = inst.n, P = 20, w = 0.7, c1 = 1.5, c2 = 1.5;
    if(n === 0) return emptySol(inst);
    function decode(x){ var o = identityOrder(n).sort(function(a,b){ return x[b]-x[a]; }); return greedyInOrder(inst, o, null); }
    var X = [], V = [], PB = [], PBc = [], gb = null, gbc = Infinity, gbSol = null;
    for(var p=0;p<P;p++){
      var x = new Float64Array(n), v = new Float64Array(n);
      for(var i=0;i<n;i++){ x[i] = p === 0 ? inst.w[i] + 0.01*rng() : inst.w[i]*rng(); v[i] = (rng()-0.5)*2; }
      var s = decode(x); X.push(x); V.push(v); PB.push(x.slice()); PBc.push(s.cost);
      if(s.cost < gbc){ gbc = s.cost; gb = x.slice(); gbSol = s; }
    }
    var it = 0, maxIt = opts.maxIters || Infinity;
    while(it < maxIt && !(opts.deadline && now() > opts.deadline)){
      it++;
      for(var p2=0;p2<P;p2++){
        var xx = X[p2], vv = V[p2], pb = PB[p2];
        for(var i2=0;i2<n;i2++){
          vv[i2] = w*vv[i2] + c1*rng()*(pb[i2]-xx[i2]) + c2*rng()*(gb[i2]-xx[i2]);
          if(vv[i2] > 4) vv[i2] = 4; else if(vv[i2] < -4) vv[i2] = -4;
          xx[i2] += vv[i2];
        }
        var s2 = decode(xx);
        if(s2.cost < PBc[p2]){ PBc[p2] = s2.cost; PB[p2] = xx.slice(); }
        if(s2.cost < gbc){ gbc = s2.cost; gb = xx.slice(); gbSol = s2; }
      }
    }
    gbSol.iters = it;
    return localSearch(inst, gbSol);
  }

  // ---------------------------------------------------------------------------------------
  var SOLVERS = {
    greedy_current: {label: '현재 GLOBAL(직선거리 최근접)', kind: 'construct', fn: solveGreedyCurrent},
    greedy_time:    {label: 'Greedy(도로시간 최근접)', kind: 'construct', fn: solveGreedyTime},
    greedy_cost:    {label: 'Greedy(목적함수 한계비용)', kind: 'construct', fn: solveGreedyCost},
    priority:       {label: '우선순위 Greedy(중증·희소 먼저)', kind: 'construct', fn: solvePriority},
    regret:         {label: 'Regret-2 삽입', kind: 'construct', fn: solveRegret},
    ls:             {label: '국소탐색(LS)', kind: 'improve', fn: solveLS},
    sa:             {label: '담금질(SA)', kind: 'meta', fn: solveSA},
    tabu:           {label: '타부 탐색(TS)', kind: 'meta', fn: solveTabu},
    ils:            {label: '반복 국소탐색(ILS)', kind: 'meta', fn: solveILS},
    vns:            {label: '가변 이웃 탐색(VNS)', kind: 'meta', fn: solveVNS},
    lns:            {label: '대규모 이웃 탐색(LNS)', kind: 'meta', fn: solveLNS},
    alns:           {label: '적응형 LNS(ALNS)', kind: 'meta', fn: solveALNS},
    grasp:          {label: 'GRASP', kind: 'meta', fn: solveGRASP},
    ga:             {label: '유전 알고리즘(GA)', kind: 'meta', fn: function(i,o){ return solveGA(i,o,false); }},
    memetic:        {label: '메메틱(GA+LS)', kind: 'meta', fn: function(i,o){ return solveGA(i,o,true); }},
    aco:            {label: '개미 집락(ACO, MMAS)', kind: 'meta', fn: solveACO},
    pso:            {label: '입자 군집(PSO, 랜덤키)', kind: 'meta', fn: solvePSO}
  };

  // opts: {timeLimitMs, maxIters, seed}
  function solve(name, inst, opts){
    opts = Object.assign({seed: 1}, opts || {});
    var S = SOLVERS[name]; if(!S) throw new Error('알 수 없는 배정 해법: '+name);
    var t0 = now();
    if(opts.timeLimitMs && !opts.deadline) opts.deadline = t0 + opts.timeLimitMs;
    var sol = S.fn(inst, opts);
    var ms = now() - t0;
    var chk = evaluate(inst, sol.a);
    if(!chk.feasible || Math.abs(chk.cost - sol.cost) > 1e-6*Math.max(1, Math.abs(chk.cost))){
      throw new Error(name+' 해 검증 실패: feasible='+chk.feasible+' cost '+sol.cost+' vs '+chk.cost);
    }
    return {name: name, assignment: Array.from(sol.a), cost: chk.cost, timeMs: ms, iters: sol.iters || 0,
            summary: summarize(inst, sol.a), extra: sol.operatorWeights ? {operatorWeights: sol.operatorWeights} : undefined};
  }

  var api = {
    ICU_TYPES: ICU_TYPES, DEFAULT_PARAMS: DEFAULT_PARAMS, SOLVERS: SOLVERS,
    buildInstance: buildInstance, solve: solve, evaluate: evaluate, summarize: summarize, mulberry32: mulberry32
  };
  if(typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ErAllocation = api;
})(typeof window !== 'undefined' ? window : this);
