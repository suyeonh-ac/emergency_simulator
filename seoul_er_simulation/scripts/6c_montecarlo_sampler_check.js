// 6c단계: patient_profile_sampler.js 를 node 에서 100만 명 샘플링해 확률표 기대값과 비교.
// 사용: node scripts/6c_montecarlo_sampler_check.js
const path = require('path');
const T = require(path.join(__dirname, '..', 'data', 'patient_probabilities.json'));
const create = require(path.join(__dirname, '..', 'patient_profile_sampler.js'));

function mulberry32(seed){ return function(){ seed|=0; seed=(seed+0x6D2B79F5)|0; let t=Math.imul(seed^(seed>>>15),1|seed); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; }; }

const N = 1000000;
const S = create(T);
const rng = mulberry32(42);
const hourRng = mulberry32(7);
const bands = T.arrival.bands;
const cnt = { ktas:{}, age:{}, res:{}, icuType:{}, spec:{} };
let icu=0, surg=0, erLos=0, erLos8=0, icuLosSum=0, orSum=0;
const erHist=new Array(7).fill(0); const EB=[2,4,6,8,12,24,Infinity];
const inc=(o,k)=>{ o[k]=(o[k]||0)+1; };
for(let i=0;i<N;i++){
  // 도착 시각: 시간대 비중으로 구간 선택 후 구간 내 균등 (도착 과정과 같은 분포)
  let u=hourRng(), acc=0, b=bands.length-1;
  for(let j=0;j<bands.length;j++){ acc+=bands[j].share; if(u<acc){ b=j; break; } }
  const hour = bands[b].startHour + hourRng()*(bands[b].endHour-bands[b].startHour);
  const p = S.sampleProfile(rng, hour);
  inc(cnt.ktas,p.ktasGroup); inc(cnt.age,p.ageGroup);
  inc(cnt.res, p.disposition.startsWith('입원')?'입원':p.disposition);
  if(p.needsICU){ icu++; inc(cnt.icuType, p.ageGroup==='infant'||p.ageGroup==='pediatric' ? p.ageGroup+':'+p.icuType : p.icuType); icuLosSum+=p.icuLosSec/86400; }
  if(p.needsSurgery){ surg++; orSum+=p.orSec/60; }
  { const h=p.erLosSec/3600; erHist[EB.findIndex(b=>h<b)]++; }
  inc(cnt.spec, p.requiredSpecialty);
  erLos += p.erLosSec/3600; if(p.erLosSec>=8*3600) erLos8++;
}
const pct=(o)=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,+(v/N*100).toFixed(2)]));
const T8 = {ktas:{'1+2':45587,'3':109410,'4+5':29613}, age:{infant:1723,pediatric:11283,adult:79181,elderly:92452}};
const sum=o=>Object.values(o).reduce((a,b)=>a+b,0);
const tgt=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,+(v/sum(o)*100).toFixed(2)]));
console.log('N =', N);
console.log('KTAS 그룹  샘플', pct(cnt.ktas), ' 표8 119', tgt(T8.ktas));
console.log('연령군     샘플', pct(cnt.age), ' 표8 119', tgt(T8.age));
console.log('결과       샘플', pct(cnt.res), ' (표8 119: 귀가 59.83 입원 34.44 전원 3.51 사망 2.14)');
console.log('ICU 필요', (icu/N*100).toFixed(2)+'%', '· 수술 필요', (surg/N*100).toFixed(2)+'%', ' (6b 해석값 ICU 7.57%)');
console.log('ICU 종류 (전체 환자 대비 %)', pct(cnt.icuType));
console.log('requiredSpecialty 분포', pct(cnt.spec));
console.log('응급실 재실 평균', (erLos/N).toFixed(2)+'h', '· 8h 이상', (erLos8/N*100).toFixed(2)+'%');
// 재실시간 구간 비율: 샘플 vs 확률표 기대값(119 결합분포로 가중)
console.log('응급실 재실 구간(%) 샘플', erHist.map(v=>+(v/N*100).toFixed(2)), ' [<2,2-4,4-6,6-8,8-12,12-24,24+]');
console.log('수술실 평균', (orSum/surg).toFixed(1)+'분 (문헌 평균 191.05분)');
console.log('ICU 재실 평균', (icuLosSum/icu).toFixed(2)+'일 (HIRA 공표 평균 9.8일, 구간 균등 가정 기대값 ≈10.6일)');

// 재현성: 같은 시드 → 같은 환자열, 환자 1명당 소비 난수 개수 고정
const a = mulberry32(123), bb = mulberry32(123);
const s1 = []; for(let i=0;i<1000;i++) s1.push(JSON.stringify(S.sampleProfile(a, (i*0.37)%24)));
let same = true; for(let i=0;i<1000;i++) if(JSON.stringify(S.sampleProfile(bb,(i*0.37)%24))!==s1[i]) same=false;
console.log('같은 시드 재현', same ? 'OK' : 'FAIL');
let c=0; const counting=()=>{ c++; return Math.random(); };
for(let i=0;i<1000;i++) S.sampleProfile(counting, 10);
for(let i=0;i<5000;i++){ const q=S.sampleProfile(Math.random,i%24); if(!(q.erLosSec>0 && q.erLosSec<=168*3600)) { console.log('ER LOS 범위 오류', q.erLosSec); break; } }
console.log('환자당 난수 소비', c/1000, '(고정값', S.DRAWS_PER_PATIENT+')');
console.log('도착률(119, 9–12시)', (S.arrivalRatePerSec(10,{use119:true})*3600).toFixed(2)+'명/시', '· 전체 내원(기본)', (S.arrivalRatePerSec(10)*3600).toFixed(2)+'명/시');
