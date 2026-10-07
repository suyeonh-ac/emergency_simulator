// 환자 프로필 샘플러 (10차) — data/patient_probabilities.data.js 의 확률표를 사용한다.
// 브라우저에서는 window.createPatientProfileSampler, node 에서는 module.exports.
//
// 난수는 호출하는 쪽이 넘긴 rand()(= sim.js 의 spawnRandom)만 쓴다. 분기와 무관하게 환자 1명당
// 항상 DRAWS_PER_PATIENT 개를 소비해서, 표나 분기가 바뀌어도 이후 환자의 난수열이 밀리지 않는다.
// 응급실 재실·수술실·ICU 시간까지 발생 시점에 정하므로 두 배정 모드가 같은 환자열을 쓴다.
(function(root){
  var DRAWS_PER_PATIENT = 11;

  function pickIndex(probs, u){
    var acc = 0;
    for(var i=0;i<probs.length;i++){ acc += probs[i]; if(u < acc) return i; }
    return probs.length-1; // 반올림 오차 대비
  }
  function pickKey(obj, u){
    var keys = Object.keys(obj), probs = keys.map(function(k){ return obj[k]; });
    return keys[pickIndex(probs, u)];
  }
  function bandIndex(bands, hour){
    for(var i=0;i<bands.length;i++){ if(hour>=bands[i].startHour && hour<bands[i].endHour) return i; }
    return bands.length-1;
  }

  // 표준정규 누적분포 (Abramowitz–Stegun 7.1.26 기반 erf 근사, 오차 < 1.5e-7)
  function normCdf(z){
    var t = 1/(1+0.3275911*Math.abs(z)/Math.SQRT2);
    var y = 1 - (((((1.061405429*t - 1.453152027)*t) + 1.421413741)*t - 0.284496736)*t + 0.254829592)*t*Math.exp(-z*z/2);
    return z >= 0 ? (1+y)/2 : (1-y)/2;
  }
  function mixCdf(m, t){
    if(t <= 0) return 0;
    var lt = Math.log(t);
    return m.w*normCdf((lt-m.mu1)/m.sigma1) + (1-m.w)*normCdf((lt-m.mu2)/m.sigma2);
  }
  // 구간 [a,b) 안에서 혼합분포의 조건부 분포를 따르는 값 (역CDF를 로그 시간에서 이분법으로)
  function sampleMixInBin(m, a, b, u){
    var Fa = mixCdf(m, a), Fb = mixCdf(m, b);
    if(!(Fb - Fa > 1e-12)) return a + u*(b-a);          // 혼합분포가 이 구간에 질량이 거의 없으면 균등
    var target = Fa + u*(Fb - Fa);
    var lo = a > 0 ? Math.log(a) : Math.log(1/60), hi = Math.log(b);
    for(var i=0;i<50;i++){
      var mid = (lo+hi)/2;
      if(mixCdf(m, Math.exp(mid)) < target) lo = mid; else hi = mid;
    }
    return Math.min(b, Math.max(a, Math.exp((lo+hi)/2)));
  }
  // Box–Muller (u1,u2 두 개로 표준정규 하나)
  function stdNormal(u1, u2){
    return Math.sqrt(-2*Math.log(Math.max(Number.EPSILON, u1)))*Math.cos(2*Math.PI*u2);
  }

  function createPatientProfileSampler(T){
    if(!T) throw new Error('PATIENT_PROBABILITIES 가 없습니다 — data/patient_probabilities.data.js 를 먼저 로드하세요.');
    var bands = T.arrival.bands;
    var disp = T.dispositionByKtasGroupAge;
    var losT = T.erLosByKtasGroupAgeResult;
    var icuLos = T.icuLosDays;
    var orT = T.orDurationMin;

    // ICU 재실일수 [a,b) 구간 균등 → 구간 i의 평균 = (a+b)/2
    var icuBinMeans = icuLos.binsDays.map(function(b){ return (b[0]+b[1])/2; });
    var icuLengthBiased = (function(){
      var w = icuLos.probs.map(function(p,i){ return p*icuBinMeans[i]; });
      var s = w.reduce(function(x,y){ return x+y; },0);
      return w.map(function(x){ return x/s; });
    })();

    function sampleErLosSec(ktasGroup, ageGroup, result, uBin, uIn){
      var bins = losT.binsHours, probs = losT.table[ktasGroup][ageGroup][result];
      var m = losT.mixture[ktasGroup][ageGroup][result];
      var i = pickIndex(probs, uBin);
      var a = bins[i][0], b = bins[i][1] === null ? losT.maxHours : bins[i][1];
      return sampleMixInBin(m, a, b, uIn)*3600;
    }

    function sampleProfile(rand, hourOfDay){
      var u = []; for(var i=0;i<DRAWS_PER_PATIENT;i++) u.push(rand());
      var b = bandIndex(bands, hourOfDay);
      var ktasGroup = pickKey(T.ktasGroupByBand.bands[b].probs, u[0]);
      var ageGroup = pickKey(T.ageByBandKtasGroup.bands[b].probs[ktasGroup], u[1]);
      var ktasLevel = Number(pickKey(T.ktasLevelByGroupAge.table[ktasGroup][ageGroup], u[2]));
      var disposition = pickKey(disp.table[ktasGroup][ageGroup], u[3]);
      var flags = disp.flags[disposition];

      var icuType = null;
      if(flags.needsICU) icuType = pickKey(T.icuTypeByAge.table[ageGroup], u[4]);
      var isChild = ageGroup==='infant' || ageGroup==='pediatric';
      // ICU 불필요 환자: 연령으로 소아/성인 응급실만 구분 (2026-10-06 결정)
      var requiredSpecialty = flags.needsICU ? icuType : (isChild ? '응급_소아' : '응급_성인');

      var result = losT.resultKeyFromDisposition[disposition];
      var erLosSec = sampleErLosSec(ktasGroup, ageGroup, result, u[5], u[6]);

      var icuLosSec = 0;
      if(flags.needsICU){
        var di = pickIndex(icuLos.probs, u[7]);
        var db = icuLos.binsDays[di];
        icuLosSec = (db[0] + u[8]*(db[1]-db[0]))*86400;
      }
      var orSec = 0;
      if(flags.needsSurgery){
        var minutes = Math.exp(orT.mu + orT.sigma*stdNormal(u[9], u[10]));
        orSec = Math.min(orT.maxMin, minutes)*60;
      }

      var severityGroup = ktasLevel<=2 ? 'critical' : (ktasLevel===3 ? 'urgent' : 'less_urgent');
      return {
        patientType: ageGroup+'_ktas_'+ktasLevel,
        ageGroup: ageGroup,
        ktasLevel: ktasLevel,
        ktasGroup: ktasGroup,
        severityGroup: severityGroup,
        disposition: disposition,
        requiredSpecialty: requiredSpecialty,
        icuType: icuType,
        needsICU: flags.needsICU,
        needsSurgery: flags.needsSurgery,
        erLosSec: erLosSec,
        orSec: orSec,
        icuLosSec: icuLosSec
      };
    }

    // 시뮬레이션 시작 시 이미 ICU에 있는 환자의 "남은" 재실시간(초).
    // 정상상태 잔여시간: 재실일수 L을 L에 비례하는 확률로 뽑고(길이 편향), 그중 균등한 비율이 남음.
    function sampleIcuResidualSec(rand){
      var i = pickIndex(icuLengthBiased, rand());
      var db = icuLos.binsDays[i];
      var L = db[0] + rand()*(db[1]-db[0]);
      return rand()*L*86400;
    }

    // 11차 — 시작 시점에 이미 응급실/수술실에 있는 환자의 "남은" 시간(초). 정상상태 잔여시간:
    // 길이 L을 L에 비례하는 확률로 뽑고(기각 샘플링, 상한 = 분포 최대값), 그중 균등한 비율이 남음.
    // 응급실은 그 시각에 도착하는 환자 프로필 분포에서 재실시간을 뽑는다(KTAS·연령·결과 반영).
    function sampleErResidualSec(rand, hourOfDay){
      var maxSec = losT.maxHours*3600;
      for(var tries=0; tries<2000; tries++){
        var L = sampleProfile(rand, hourOfDay).erLosSec;
        if(rand()*maxSec < L) return rand()*L;
      }
      return rand()*4*3600; // 사실상 오지 않음 (방어용)
    }
    function sampleOrResidualSec(rand){
      var maxSec = orT.maxMin*60;
      for(var tries=0; tries<2000; tries++){
        var L = Math.min(orT.maxMin, Math.exp(orT.mu + orT.sigma*stdNormal(rand(), rand())))*60;
        if(rand()*maxSec < L) return rand()*L;
      }
      return rand()*orT.mean*60;
    }

    // 시간대별 도착률(명/초). 기본은 전체 내원 건수(2026-10-07 결정), opts.use119 면 119 건수.
    function arrivalRatePerSec(hourOfDay, opts){
      opts = opts || {};
      var annual = opts.use119 ? T.arrival.annualCount119 : T.arrival.annualCountAll;
      var band = bands[bandIndex(bands, hourOfDay)];
      var perHour = (annual/T.arrival.daysInYear) * band.share / (band.endHour-band.startHour);
      return perHour/3600*(opts.multiplier||1);
    }

    return {
      sampleProfile: sampleProfile,
      sampleIcuResidualSec: sampleIcuResidualSec,
      sampleErResidualSec: sampleErResidualSec,
      sampleOrResidualSec: sampleOrResidualSec,
      arrivalRatePerSec: arrivalRatePerSec,
      DRAWS_PER_PATIENT: DRAWS_PER_PATIENT
    };
  }

  if(typeof module!=='undefined' && module.exports) module.exports = createPatientProfileSampler;
  else root.createPatientProfileSampler = createPatientProfileSampler;
})(typeof window!=='undefined' ? window : this);
