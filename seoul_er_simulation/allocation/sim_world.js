// 15차(2026-10-14) — 메인 HTML과 같은 규칙으로 병원·환자·시작 상태를 만드는 헤드리스 모듈.
// seoul_er_dispatch_map_9.html 의 hospitals 구성 / samplePatientLocation / seedInitialState /
// resolveRoute(캐시 소요시간)를 DOM 없이 옮긴 것. 판정 조건은 화면과 같다.
const loadMainHtml = require('./main_html_data');

const ICU_TYPES = ['신생아','소아','일반','내과','외과','신경외과','심장내과','흉부외과','신경과'];
const ER_SNAPSHOT_KEYS = ['ER.일반','ER.소아','ER.외상소생실','ER.일반격리','ER.음압격리','ER.소아일반격리','ER.소아음압격리','ER.코호트격리'];
const AVG_SPEED_KMH = 19.5;

function mulberry32(seed){
  return function(){
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function haversineMeters(lat1,lng1,lat2,lng2){
  const R = 6371000, dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// 화면의 POPULATION_DENSITY_CELLS / SEOUL_APPROX_POLYGON / HAN_RIVER_CENTERLINE 과 같은 값
const CELLS = (function(){
  const lat = [37.43570,37.49390,37.55213,37.61036,37.66860], lng = [126.77640,126.87654,126.97672,127.07690,127.17710];
  const out = [];
  for(let r=0;r<4;r++) for(let c=0;c<4;c++) out.push({latMin:lat[r],latMax:lat[r+1],lngMin:lng[c],lngMax:lng[c+1],routeOriginIdx:r*4+c});
  return out;
})();
const POLY = [[37.6686,126.8010],[37.6686,126.9470],[37.6686,127.0740],[37.6570,127.1510],[37.6200,127.1771],[37.5680,127.1771],[37.5300,127.1510],[37.4910,127.1270],[37.4590,127.0870],[37.4357,127.0200],[37.4420,126.9440],[37.4510,126.8700],[37.4670,126.8090],[37.5100,126.7764],[37.5700,126.7764],[37.6250,126.7860]];
const RIVER = [[37.5860,126.7764],[37.5700,126.8200],[37.5550,126.8700],[37.5420,126.9200],[37.5250,126.9700],[37.5150,127.0200],[37.5190,127.0700],[37.5350,127.1200],[37.5550,127.1771]];
function pointInPolygon(lat, lng, polygon){
  let inside = false;
  for(let i=0, j=polygon.length-1; i<polygon.length; j=i++){
    const yi=polygon[i][0], xi=polygon[i][1], yj=polygon[j][0], xj=polygon[j][1];
    if(((yi>lat)!==(yj>lat)) && (lng < (xj-xi)*(lat-yi)/((yj-yi)||1e-12)+xi)) inside = !inside;
  }
  return inside;
}
function riverLat(lng){
  for(let i=1;i<RIVER.length;i++){ const a=RIVER[i-1], b=RIVER[i]; if(lng>=a[1] && lng<=b[1]) return a[0]+(b[0]-a[0])*(lng-a[1])/((b[1]-a[1])||1e-12); }
  return null;
}

function createWorld(opts){
  opts = opts || {};
  const D = loadMainHtml(opts.htmlPath);
  const sampler = D.createPatientProfileSampler(D.PATIENT_PROBABILITIES);
  const routeSec = {};
  D.ROUTE_CACHE_RAW.forEach(r => { if(!r.error) routeSec[r.o+'_'+r.h] = r.d; });

  function validPoint(lat, lng){
    const B = D.SPAWN_BOUNDS;
    if(lat<B.latMin || lat>B.latMax || lng<B.lngMin || lng>B.lngMax) return false;
    if(!pointInPolygon(lat,lng,POLY)) return false;
    const rl = riverLat(lng);
    return !(rl!==null && Math.abs(lat-rl) < 0.0045);
  }

  function makeHospitals(){
    return D.HOSPITALS_DATA.map(h => {
      const cols = D.HOSPITAL_ICU_COLUMNS[h.hpid];
      const icu = {}; ICU_TYPES.forEach(k => { icu[k] = Number(cols.icu[k])||0; });
      const specialties = ICU_TYPES.filter(k => icu[k] > 0);
      specialties.push('응급_성인');
      if(cols.erPediatricBeds > 0) specialties.push('응급_소아');
      const occ = {}; ICU_TYPES.forEach(k => { occ[k] = 0; });
      return { hpid:h.hpid, name:h.shortName, lat:h.lat, lng:h.lng, capacity:h.capacity, occupied:0,
               specialties, icuCap:icu, icuOcc:occ, orCap:(h.resources && h.resources.surgery)||0, orOcc:0 };
    });
  }

  // 화면 samplePatientLocation(): 격자 가중 선택(현재 모두 1) → 격자 안 균등(서울·한강 밖 재추첨)
  function sampleLocation(rand, cellIdx){
    const cell = CELLS[cellIdx === undefined ? Math.min(15, (rand()*16)|0) : cellIdx];
    for(let a=0;a<80;a++){
      const lat = cell.latMin + rand()*(cell.latMax-cell.latMin), lng = cell.lngMin + rand()*(cell.lngMax-cell.lngMin);
      if(validPoint(lat,lng)) return {lat, lng, routeOriginIdx: cell.routeOriginIdx};
    }
    const o = D.ROUTE_ORIGINS[cell.routeOriginIdx];
    return {lat:o.lat, lng:o.lng, routeOriginIdx:cell.routeOriginIdx};
  }

  // 화면 resolveRoute()의 소요시간: 캐시(카카오 실도로) 우선, 없으면 직선/19.5km/h × 혼잡(평균 1.05)
  function travelSec(originIdx, hIdx, lat, lng, hos){
    const d = routeSec[originIdx+'_'+hIdx];
    if(d !== undefined) return d;
    return haversineMeters(lat,lng,hos.lat,hos.lng)/(AVG_SPEED_KMH*1000/3600)*1.05;
  }

  function attachTravel(patient, hospitals){
    patient.travelSec = hospitals.map((h, j) => travelSec(patient.routeOriginIdx, j, patient.lat, patient.lng, h));
    patient.distM = hospitals.map(h => haversineMeters(patient.lat, patient.lng, h.lat, h.lng));
    return patient;
  }

  // 화면 seedInitialState()와 같은 규칙. 반환: 시작 시점에 이미 병상에 있는 환자 목록(잔여시간 포함)
  function seedInitialState(hospitals, seed, snapshotIdx, icuRate){
    const r = mulberry32(((seed>>>0) ^ 0x9E3779B9)>>>0);
    const snap = D.BED_SNAPSHOTS[snapshotIdx || 0];
    icuRate = icuRate === undefined ? D.PATIENT_PROBABILITIES.icuInitialOccupancy.default : icuRate;
    const startHour = Number(snap.startHour)||0;
    const pre = [];
    function occ(cats, keys){
      let o=0, t=0, found=false;
      keys.forEach(k => { const c = cats[k]; if(!c || !(c.total>0)) return; found=true; t+=c.total; o+=Math.min(c.total, Math.max(0, c.total-c.avail)); });
      return found ? o/t : null;
    }
    function sround(x){ const f = Math.floor(x); return f + (r() < x-f ? 1 : 0); }
    hospitals.forEach((hos, idx) => {
      const cats = snap.hospitals[hos.hpid] ? snap.hospitals[hos.hpid].cats : null;
      if(cats){
        const er = occ(cats, ER_SNAPSHOT_KEYS);
        if(er !== null){
          const nEr = Math.min(hos.capacity, sround(hos.capacity*er));
          for(let j=0;j<nEr;j++){ hos.occupied++; pre.push({status:'treating', hospitalIdx:idx, preexisting:true, treatRemaining: sampler.sampleErResidualSec(r, startHour)}); }
        }
        const or = occ(cats, ['OR.수술실']);
        if(or !== null){
          const nOr = Math.min(hos.orCap, sround(hos.orCap*or));
          for(let q=0;q<nOr;q++){ hos.orOcc++; pre.push({status:'surgery', hospitalIdx:idx, preexisting:true, orRemaining: sampler.sampleOrResidualSec(r)}); }
        }
      }
      ICU_TYPES.forEach(k => {
        const cap = hos.icuCap[k]||0; if(!cap) return;
        const o = cats ? occ(cats, k === '소아' ? ['ICU.소아','EMG.소아중환자실'] : ['ICU.'+k]) : null;
        const count = Math.min(cap, sround(cap*(o === null ? icuRate : o)));
        for(let j=0;j<count;j++){ hos.icuOcc[k]++; pre.push({status:'icu', hospitalIdx:idx, preexisting:true, requiredSpecialty:k, needsICU:true, icuRemaining: sampler.sampleIcuResidualSec(r)}); }
      });
    });
    return {pre, startHour, label: snap.label};
  }

  return { D, sampler, ICU_TYPES, CELLS, mulberry32, haversineMeters, makeHospitals, sampleLocation, travelSec, attachTravel, seedInitialState };
}

module.exports = createWorld;
