// 서울 응급실 배정 시뮬레이션 — 로직 전체
// 데이터는 data/*.data.js 에서 window.HOSPITALS_DATA / ROUTE_ORIGINS / ROUTE_CACHE_RAW / SPAWN_BOUNDS 로 주입됨.
// index.html 에서 data/*.data.js 를 먼저 로드한 뒤 이 파일을 로드해야 함.

(function(){

  // 2026-10-07, 10차: 환자 진료계열을 병원 ICU 컬럼과 1:1로 맞춘 9종 + ICU가 필요 없는
  // 환자용 응급실 2종으로 바꿨다(기존 외상/심장/소아/일반/내과 묶음은 더 쓰지 않음).
  // 외상·음압격리·화상은 범위 밖. 병원별 값은 data/hospital_icu_columns.data.js
  // (scripts/6d, bed_detail_raw.json에서 직접 추출 — 1e의 icu_buckets()는 그대로 둠).
  var ICU_TYPES = ['신생아','소아','일반','내과','외과','신경외과','심장내과','흉부외과','신경과'];
  var ER_TYPES = ['응급_성인','응급_소아'];
  var SPECIALTIES = ICU_TYPES.concat(ER_TYPES);
  function zeroIcuMap(){ var o={}; ICU_TYPES.forEach(function(k){ o[k]=0; }); return o; }

  // 2026-09-28, 8차: 51개 병원 전체 중환자실 병상을 합산해보니 내과 단독(587병상)·
  // 외과 단독(543병상)이 이미 심장 버킷 전체(심장내과+흉부외과=404병상)보다 컸는데,
  // 내과는 "일반"이라는 포괄 버킷 안에 묻혀서 규모가 드러나지 않고 있었다(반면 더
  // 작은 심장은 처음부터 이름이 있었음) — scripts/1e_apply_manual_bed_detail.py의
  // icu_buckets()에서 내과를 분리해 icu.내과를 새로 만들었다. 이 변경으로
  // requiredSpecialty가 '심장'으로 전혀 나오지 않던 기존 문제(아래 "질병군 진료과
  // 배분" 참고)도 함께 해소된다.

  // 2026-09-21: 수연(환자 발생)·민성(병원 선정) 역할 분담 문서의 "공통 코드값" 중
  // PATIENT_STATUS는 그대로 유지. 문서 초안의 AGE_GROUP(pediatric/adult/elderly)과
  // SEVERITY(critical/emergent/non_emergent)는 수연님이 NEDIS 통계 기반 실제 구현을
  // 넣으면서 더 세분화된 값으로 대체됨 — ageGroup은 'infant'가 추가된 4단계, 중증도는
  // severity 대신 ktasLevel(1~5 숫자)과 severityGroup(critical/urgent/less_urgent)
  // 두 필드로 나뉘어 표현됨. 아래 "수연 담당 — 환자 발생 에이전트 모델링" 섹션 참고.
  // 2026-09-28, 9차: WAITING과 TRANSIT 사이에 CONTACTING을 추가 — 병원에 순차적으로
  // 문의(접촉)하는 과정 자체를 상태로 표현한다. 아래 "9차 업데이트" 섹션과
  // README.md의 "배정 로직 고도화 — 순차 탐색 모델" 섹션 참고.
  // 2026-10-07, 10차: 응급실 퇴실 이후 단계를 추가 — SURGERY(수술실 점유), ICU_STAY(중환자실
  // 재실). TREATING은 이제 "응급실 병상 점유(응급실 재실시간)"만 뜻한다.
  var PATIENT_STATUS = { WAITING: 'waiting', CONTACTING: 'contacting', TRANSIT: 'transit', TREATING: 'treating', SURGERY: 'surgery', ICU_STAY: 'icu', FAILED: 'failed' };

  // 2026-09-28, 9차: 배정 방식 두 가지를 화면에서 토글하기 위한 모드.
  // SEQUENTIAL(기본) — 가까운 병원부터 한 곳씩 문의, 그 시점 실제 자원으로 즉석 판정.
  // GLOBAL — 기존 로직 그대로: 51곳을 매 틱 즉시 전역 스캔해 최적 병원에 바로 배정
  //          ("병상 정보가 실시간으로 완전히 공유되는 이상적 시나리오"로 남겨둠).
  var ASSIGNMENT_MODE = { SEQUENTIAL: 'sequential', GLOBAL: 'global' };
  var assignmentMode = ASSIGNMENT_MODE.SEQUENTIAL;

  // 2026-09-28, 9차 — 환자 발생/배정에 쓰이는 모든 난수를 재현 가능하게 만들기 위한
  // 시드 고정 PRNG(mulberry32). 같은 시드면 두 배정 모드에 "동일한 환자 발생열"을
  // 재생할 수 있어 순차 탐색 vs 전역 스캔을 공정하게 비교할 수 있다(설계 문서 2번
  // 항목 "가능하면 좋고" 요구사항). nativeRandom은 시드 입력칸의 "새 시드" 버튼처럼
  // 재현성이 필요 없는 곳(새 시드값 뽑기)에 쓰는 원본 Math.random.
  // 2026-09-28, 9차 — 전역 Math.random을 통째로 덮어쓰지 않고, "환자 발생"에 쓰이는
  // 난수만 별도 스트림(spawnRandom)으로 분리했다. 처음엔 Math.random 자체를 시드
  // 고정 함수로 교체했는데, 그러면 배정 소요시간(문의 30초 대기 등)이 모드마다
  // 달라서 혼잡도 근사(rand(CONGESTION_MIN,CONGESTION_MAX))·치료시간
  // (rand(TREAT_MIN_SEC,TREAT_MAX_SEC)) 같은 "운영상" 난수 소비 시점이 모드별로
  // 어긋나 버려, 정작 재현하고 싶었던 "환자 발생열" 자체가 두 모드에서 슬쩍 달라지는
  // 문제가 있었다(직접 테스트로 확인함). 환자가 언제·어디서·어떤 프로필로
  // 발생하는지는 배정 결과와 무관하게 simTime만으로 결정되므로, 이 부분만 독립
  // 스트림으로 떼어내면 두 모드가 완전히 동일한 환자 발생열을 재생한다. 혼잡도
  // 근사·치료시간은 원래 쓰던 rand()/Math.random 그대로 둬서(운영상 잡음, 비교의
  // 본질이 아님) 손대지 않았다.
  var nativeRandom = Math.random.bind(Math);
  function mulberry32(seed){
    return function(){
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var spawnRandom = mulberry32(42); // 실제 값은 최초 로드 시/초기화마다 아래에서 재시드됨
  function spawnRand(a,b){ return a + spawnRandom()*(b-a); }
  function applySeed(seed){
    spawnRandom = mulberry32(seed >>> 0);
  }
  function readSeedFromInput(){
    var el = document.getElementById('seedInput');
    var v = el ? parseInt(el.value, 10) : NaN;
    return Number.isFinite(v) ? v : Date.now();
  }

  var GRADE_LABEL = {
    '권역응급의료센터':'권역센터',
    '지역응급의료센터':'지역센터',
    '지역응급의료기관':'지역기관',
    '응급실운영신고기관':'신고기관'
  };

  var HOSPITALS_DATA = window.HOSPITALS_DATA;
  var ROUTE_ORIGINS = window.ROUTE_ORIGINS;
  var ROUTE_CACHE_RAW = window.ROUTE_CACHE_RAW;
  var SPAWN_BOUNDS = window.SPAWN_BOUNDS;

  // 캐시를 "originIdx_hospitalIdx" 키로 색인
  var ROUTE_CACHE = {};
  ROUTE_CACHE_RAW.forEach(function(r){
    if(r.error) return;
    ROUTE_CACHE[r.o+'_'+r.h] = r;
  });

  // 2026-10-07, 10차 — 확률표·병원 ICU 컬럼은 별도 데이터 파일에서 주입된다.
  var PATIENT_PROBABILITIES = window.PATIENT_PROBABILITIES;
  var HOSPITAL_ICU_COLUMNS = window.HOSPITAL_ICU_COLUMNS;
  if(!PATIENT_PROBABILITIES || !HOSPITAL_ICU_COLUMNS || typeof window.createPatientProfileSampler !== 'function'){
    throw new Error('10차 데이터가 없습니다 — index.html에서 data/patient_probabilities.data.js, data/hospital_icu_columns.data.js, patient_profile_sampler.js 를 sim.js 앞에 로드하세요.');
  }
  var patientSampler = window.createPatientProfileSampler(PATIENT_PROBABILITIES);

  // ============================================================
  // 환자 발생 에이전트 모델링 (2026-10-07, 10차 — 통계연보 확률표로 교체)
  // 출처: 2024 응급의료 통계연보(제23호) 서울 편 표 3·8·9·11·12 + HIRA 중환자실 평가 등.
  // 확률표 생성: scripts/6_build_patient_probabilities.py → data/patient_probabilities.json
  // 실측/가정 구분: docs/10차_환자발생_확률표.md
  //  - 환자 프로필 분포: 119구급차 내원 모집단(표 8)
  //  - 도착률: 전체 내원 건수(800,599건/366일) × 시간대 비중(표 3), 요일·월 배율은 쓰지 않음
  // 이전 8·9차의 AGE_KTAS_JOINT_COUNTS / CASE_TYPE_COUNTS_BY_AGE /
  // RESOURCE_NEED_PROBABILITIES_BY_KTAS / DISEASE_SPECIALTY_WEIGHTS / ARRIVAL_DAY_COUNTS 는
  // 이 확률표로 대체되어 삭제했다(질병/손상 구분과 외상 진료계열도 함께 없어짐).
  // ============================================================
  var SIMULATION_START_HOUR = 0;   // 11차: 실측 스냅샷으로 시작하면 스냅샷 시각으로 바뀜 (seedInitialState)
  var PATIENT_DEMAND_MULTIPLIER = 1;
  // 시작 시 ICU 가동률 기본값(Cho et al. 2021, 전국 2019년 72.9%) — 화면 입력칸으로 조절
  var DEFAULT_ICU_INITIAL_OCCUPANCY = PATIENT_PROBABILITIES.icuInitialOccupancy.default;

  // 환자 발생 위치 모듈 (수연 담당)
  // 현재 populationWeight=1은 실제 생활인구 자료가 연결되기 전의 검증용 기본값이다.
  // 동일 면적 격자가 아니면 밀도가 아니라 '밀도 x 면적' 또는 생활인구 수를 입력해야 한다.
  // 4x4 격자 경계는 기존 ROUTE_ORIGINS 16개 지점 사이의 중간값으로 설정했다.
  var POPULATION_DENSITY_CELLS = [
    {densityCellId:'GRID_01',latMin:37.43570,latMax:37.49390,lngMin:126.77640,lngMax:126.87654,populationWeight:1,routeOriginIdx:0},
    {densityCellId:'GRID_02',latMin:37.43570,latMax:37.49390,lngMin:126.87654,lngMax:126.97672,populationWeight:1,routeOriginIdx:1},
    {densityCellId:'GRID_03',latMin:37.43570,latMax:37.49390,lngMin:126.97672,lngMax:127.07690,populationWeight:1,routeOriginIdx:2},
    {densityCellId:'GRID_04',latMin:37.43570,latMax:37.49390,lngMin:127.07690,lngMax:127.17710,populationWeight:1,routeOriginIdx:3},
    {densityCellId:'GRID_05',latMin:37.49390,latMax:37.55213,lngMin:126.77640,lngMax:126.87654,populationWeight:1,routeOriginIdx:4},
    {densityCellId:'GRID_06',latMin:37.49390,latMax:37.55213,lngMin:126.87654,lngMax:126.97672,populationWeight:1,routeOriginIdx:5},
    {densityCellId:'GRID_07',latMin:37.49390,latMax:37.55213,lngMin:126.97672,lngMax:127.07690,populationWeight:1,routeOriginIdx:6},
    {densityCellId:'GRID_08',latMin:37.49390,latMax:37.55213,lngMin:127.07690,lngMax:127.17710,populationWeight:1,routeOriginIdx:7},
    {densityCellId:'GRID_09',latMin:37.55213,latMax:37.61036,lngMin:126.77640,lngMax:126.87654,populationWeight:1,routeOriginIdx:8},
    {densityCellId:'GRID_10',latMin:37.55213,latMax:37.61036,lngMin:126.87654,lngMax:126.97672,populationWeight:1,routeOriginIdx:9},
    {densityCellId:'GRID_11',latMin:37.55213,latMax:37.61036,lngMin:126.97672,lngMax:127.07690,populationWeight:1,routeOriginIdx:10},
    {densityCellId:'GRID_12',latMin:37.55213,latMax:37.61036,lngMin:127.07690,lngMax:127.17710,populationWeight:1,routeOriginIdx:11},
    {densityCellId:'GRID_13',latMin:37.61036,latMax:37.66860,lngMin:126.77640,lngMax:126.87654,populationWeight:1,routeOriginIdx:12},
    {densityCellId:'GRID_14',latMin:37.61036,latMax:37.66860,lngMin:126.87654,lngMax:126.97672,populationWeight:1,routeOriginIdx:13},
    {densityCellId:'GRID_15',latMin:37.61036,latMax:37.66860,lngMin:126.97672,lngMax:127.07690,populationWeight:1,routeOriginIdx:14},
    {densityCellId:'GRID_16',latMin:37.61036,latMax:37.66860,lngMin:127.07690,lngMax:127.17710,populationWeight:1,routeOriginIdx:15}
  ];
  var HAS_EMPIRICAL_POPULATION_WEIGHTS = false;

  // 서울 외곽을 단순화한 검증용 폴리곤. 정밀 분석 시 행정경계 GeoJSON으로 교체한다.
  var SEOUL_APPROX_POLYGON = [
    [37.6686,126.8010],[37.6686,126.9470],[37.6686,127.0740],[37.6570,127.1510],
    [37.6200,127.1771],[37.5680,127.1771],[37.5300,127.1510],[37.4910,127.1270],
    [37.4590,127.0870],[37.4357,127.0200],[37.4420,126.9440],[37.4510,126.8700],
    [37.4670,126.8090],[37.5100,126.7764],[37.5700,126.7764],[37.6250,126.7860]
  ];

  // 한강 중심선을 단순화한 좌표. 강 위 임의 발생을 막기 위한 안전장치다.
  var HAN_RIVER_CENTERLINE = [
    [37.5860,126.7764],[37.5700,126.8200],[37.5550,126.8700],[37.5420,126.9200],
    [37.5250,126.9700],[37.5150,127.0200],[37.5190,127.0700],[37.5350,127.1200],
    [37.5550,127.1771]
  ];
  var HAN_RIVER_EXCLUSION_LAT_DEG = 0.0045;
  var MAX_LOCATION_SAMPLE_ATTEMPTS = 80;

  function pointInPolygon(lat, lng, polygon){
    var inside = false;
    for(var i=0, j=polygon.length-1; i<polygon.length; j=i++){
      var yi=polygon[i][0], xi=polygon[i][1];
      var yj=polygon[j][0], xj=polygon[j][1];
      var intersects = ((yi>lat)!==(yj>lat)) &&
        (lng < (xj-xi)*(lat-yi)/((yj-yi)||1e-12)+xi);
      if(intersects) inside = !inside;
    }
    return inside;
  }

  function hanRiverCenterLat(lng){
    for(var i=1;i<HAN_RIVER_CENTERLINE.length;i++){
      var a=HAN_RIVER_CENTERLINE[i-1], b=HAN_RIVER_CENTERLINE[i];
      if(lng>=a[1] && lng<=b[1]){
        var t=(lng-a[1])/((b[1]-a[1])||1e-12);
        return a[0]+(b[0]-a[0])*t;
      }
    }
    return null;
  }

  function isValidSeoulPoint(lat, lng){
    if(lat<SPAWN_BOUNDS.latMin || lat>SPAWN_BOUNDS.latMax ||
       lng<SPAWN_BOUNDS.lngMin || lng>SPAWN_BOUNDS.lngMax) return false;
    if(!pointInPolygon(lat,lng,SEOUL_APPROX_POLYGON)) return false;
    var riverLat=hanRiverCenterLat(lng);
    if(riverLat!==null && Math.abs(lat-riverLat)<HAN_RIVER_EXCLUSION_LAT_DEG) return false;
    return true;
  }

  function sampleDensityCell(simTime){
    // simTime은 향후 시간대별 생활인구 가중치 적용을 위해 인터페이스에 유지한다.
    var totalWeight=0;
    for(var i=0;i<POPULATION_DENSITY_CELLS.length;i++){
      totalWeight += Math.max(0, Number(POPULATION_DENSITY_CELLS[i].populationWeight)||0);
    }
    if(totalWeight<=0) throw new Error('POPULATION_DENSITY_CELLS의 populationWeight 합이 0입니다.');
    var target=spawnRandom()*totalWeight;
    for(var j=0;j<POPULATION_DENSITY_CELLS.length;j++){
      target -= Math.max(0, Number(POPULATION_DENSITY_CELLS[j].populationWeight)||0);
      if(target<=0) return POPULATION_DENSITY_CELLS[j];
    }
    return POPULATION_DENSITY_CELLS[POPULATION_DENSITY_CELLS.length-1];
  }

  function samplePointInsideCell(cell){
    for(var attempt=0;attempt<MAX_LOCATION_SAMPLE_ATTEMPTS;attempt++){
      var lat=spawnRand(cell.latMin,cell.latMax);
      var lng=spawnRand(cell.lngMin,cell.lngMax);
      if(isValidSeoulPoint(lat,lng)) return {lat:lat,lng:lng};
    }
    var origin=ROUTE_ORIGINS[cell.routeOriginIdx];
    return {lat:origin.lat,lng:origin.lng};
  }

  var WAIT_TIMEOUT_SEC = 600;
  // 2026-09-28, 9차 — 가정치: 구급대원이 병원 1곳과 통화해서 수용 가능 여부를
  // 확인하는 데 걸리는 시간(통화 연결·현장 상황 설명·병원 측 판단 포함). 이 프로젝트가
  // 가진 어떤 자료에도 실제 "병원 문의 소요시간" 실측치는 없어 30초로 가정했다 —
  // WAIT_TIMEOUT_SEC(600초) 안에 최대 20회 문의가 가능한 수준. 후보 병원 수(진료과별
  // 34~51곳, 아래 9차 섹션 참고)가 이보다 항상 많아서 실제로는 후보를 다 소진하고
  // 처음으로 되돌아가는 경우가 거의 없다.
  var CONTACT_ATTEMPT_SEC = 30;
  // 10차: 고정 치료시간(TREAT_MIN/MAX_SEC, 30–90분 균등)은 응급실 재실시간·수술실·ICU 분포로 대체되어 삭제
  var AVG_SPEED_KMH = 19.5;                      // 캐시에 없는 구간의 직선 근사용 평균 속도 (카카오 실측 128구간 평균 19.5km/h 기반)
  var CONGESTION_MIN = 0.85, CONGESTION_MAX = 1.25;
  var FAILED_LINGER_REAL_SEC = 2.5;
  // 10차: ICU 재실이 일 단위라 고배속 추가 (3600배속 = 실제 1초에 1시간)
  var SPEED_LEVELS = [20, 45, 90, 180, 360, 900, 1800, 3600];
  var DEFAULT_SPEED_INDEX = 2;

  var COLOR_WAITING = '#8B94A7';
  var COLOR_REQUEST = '#FBBF24'; // 2026-09-28, 9차: CONTACTING(순차 문의 중) 상태 마커 색으로 사용. 이전까지는 정의만 되고 실제로 쓰이진 않던 상수였음.
  var COLOR_TRANSIT = '#3ABEEA';
  var COLOR_FAILED = '#F87171';
  var COLOR_OK = '#4ADE80';
  var COLOR_BUSY = '#FBBF24';
  var COLOR_FULL = '#F87171';

  function rand(a,b){ return a + Math.random()*(b-a); }

  function haversineMeters(lat1,lng1,lat2,lng2){
    var R = 6371000;
    var dLat = (lat2-lat1) * Math.PI/180;
    var dLng = (lng2-lng1) * Math.PI/180;
    var a = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180) *
            Math.sin(dLng/2)*Math.sin(dLng/2);
    var c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R*c;
  }

  function computeCumulative(coords){
    var cum = [0];
    for(var i=1;i<coords.length;i++){
      var d = haversineMeters(coords[i-1][0],coords[i-1][1],coords[i][0],coords[i][1]);
      cum.push(cum[i-1]+d);
    }
    return cum;
  }

  function positionAtProgress(cum, coords, progress){
    var total = cum[cum.length-1];
    if(total<=0) return coords[0];
    var target = progress*total;
    if(target<=0) return coords[0];
    if(target>=total) return coords[coords.length-1];
    var lo=0, hi=cum.length-1;
    while(lo<hi){
      var mid=(lo+hi)>>1;
      if(cum[mid]<target) lo=mid+1; else hi=mid;
    }
    var i = lo;
    var segStart = cum[i-1], segEnd = cum[i];
    var segLen = (segEnd-segStart) || 1;
    var t = (target-segStart)/segLen;
    var p0 = coords[i-1], p1 = coords[i];
    return [p0[0]+(p1[0]-p0[0])*t, p0[1]+(p1[1]-p0[1])*t];
  }

  function nearestOriginIdx(lat, lng){
    var best=-1, bestDist=Infinity;
    for(var i=0;i<ROUTE_ORIGINS.length;i++){
      var o = ROUTE_ORIGINS[i];
      var d = haversineMeters(lat,lng,o.lat,o.lng);
      if(d<bestDist){ bestDist=d; best=i; }
    }
    return best;
  }

  // 환자 발생 지점 → 배정 병원 구간의 경로를 구한다.
  // 1) 사전 계산 캐시(실도로, 4x4 격자 기준)에 있으면 그대로 사용
  // 2) 없으면 직선거리 + 평균속도 근사로 대체 (approx:true, 점선 표시)
  function resolveRoute(lat1, lng1, hospitalIdx, hLat, hLng, routeOriginIdx){
    // 2026-09-21: 수연님이 samplePatientLocation()에서 발생 위치를 뽑을 때 이미
    // 어느 격자(routeOriginIdx)에서 뽑았는지 알고 있으므로, 그 값을 넘겨받으면
    // haversine으로 다시 최근접 지점을 찾을 필요가 없다. 안 넘어오면(과거 호출부
    // 호환용) 기존처럼 계산한다.
    var originIdx = Number.isInteger(routeOriginIdx) ? routeOriginIdx : nearestOriginIdx(lat1, lng1);
    var cached = ROUTE_CACHE[originIdx+'_'+hospitalIdx];
    if(cached){
      var coords = [[lat1,lng1]].concat(cached.c).concat([[hLat,hLng]]);
      return {coords: coords, durationSec: cached.d, distanceM: cached.m, approx:false};
    }
    var distM = haversineMeters(lat1,lng1,hLat,hLng);
    var congestion = rand(CONGESTION_MIN, CONGESTION_MAX);
    var durationSec = (distM / (AVG_SPEED_KMH*1000/3600)) * congestion;
    return {coords:[[lat1,lng1],[hLat,hLng]], durationSec:durationSec, distanceM:distM, approx:true};
  }

  var map = L.map('map', {zoomControl:true}).setView([37.5665,126.9780], 11);
  // CARTO의 무료 다크 타일(basemaps.cartocdn.com)은 2026년부터 API 키가 필요해져서
  // 키 없이 쓰면 타일에 "API KEY REQUIRED" 워터마크가 찍힌다. 대신 키가 필요 없는
  // Esri의 다크 캔버스 타일(World_Dark_Gray_Base + Reference 레이어)을 사용한다.
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    maxNativeZoom: 16,
    maxZoom: 19
  }).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 16,
    maxZoom: 19
  }).addTo(map);

  var hospitals = HOSPITALS_DATA.map(function(h){
    var radius = Math.max(4, Math.min(11, 3 + h.capacity*0.55));
    var marker = L.circleMarker([h.lat,h.lng], {
      radius: radius, color: COLOR_OK, fillColor: COLOR_OK, fillOpacity: 0.85, weight: 1.5
    }).addTo(map);
    marker.bindTooltip(h.shortName + ' (' + GRADE_LABEL[h.grade] + ') · 0/' + h.capacity, {direction:'top', offset:[0,-radius-2]});
    marker.bindPopup('');
    // 2026-10-07, 10차 — ICU는 9종 컬럼(hospital_icu_columns)으로, 진료계열(specialties)은
    // "그 ICU 병상이 있으면 표방" + 응급_성인(모든 병원) + 응급_소아(소아 응급실 병상이 있는
    // 병원만, 2026-10-07 결정)으로 다시 만든다. 응급실 capacity·수술실은 기존 값 그대로.
    var cols = HOSPITAL_ICU_COLUMNS[h.hpid];
    if(!cols) throw new Error('hospital_icu_columns에 '+h.hpid+' '+h.name+' 이 없습니다 — scripts/6d를 다시 실행하세요.');
    var icu = zeroIcuMap();
    ICU_TYPES.forEach(function(k){ icu[k] = Number(cols.icu[k])||0; });
    var specialties = ICU_TYPES.filter(function(k){ return icu[k] > 0; });
    specialties.push('응급_성인');
    if(cols.erPediatricBeds > 0) specialties.push('응급_소아');
    return {
      hpid:h.hpid, name:h.name, shortName:h.shortName, grade:h.grade, lat:h.lat, lng:h.lng,
      capacity:h.capacity, specialties:specialties, occupied:0, marker:marker, radius:radius,
      barEl:null, countEl:null,
      erPediatricBeds: cols.erPediatricBeds,
      resources: {icu: icu, surgery: (h.resources && h.resources.surgery) || 0},
      occupiedICU: zeroIcuMap(), occupiedOR: 0,
      resEl:null
    };
  });

  function icuTotal(hos){
    var t = 0;
    for(var k in hos.resources.icu){ t += hos.resources.icu[k]; }
    return t;
  }
  function occupiedICUTotal(hos){
    var t = 0;
    for(var k in hos.occupiedICU){ t += hos.occupiedICU[k]; }
    return t;
  }

  // ============================================================
  // 민성 담당 — 병원 선정 및 배치 모델링
  // (수연/민성 역할 분담 문서의 함수 시그니처를 그대로 따름. isHospitalEligible/
  // scoreHospital/selectHospital 세 함수만 이 파일의 나머지 "공동 연결 영역"에서
  // 호출되고, hospitals 배열 내부 구조는 여기서만 다룸.)
  // ============================================================

  function isHospitalEligible(patient, hospital){
    if(hospital.occupied >= hospital.capacity) return false;
    if(hospital.specialties.indexOf(patient.requiredSpecialty) === -1) return false;
    // 2026-09 반영: 응급똑똑 실측 중환자실/수술실 자원을 배정 제약으로 추가.
    // patient.needsICU/needsSurgery는 원래 공통 환자 객체 규격에 없던 필드라
    // 수연님께 samplePatientProfile() 반환값에 추가해달라고 요청해둔 상태 —
    // 아직 반영 전이라 지금은 임시 자리표시자 프로필에서 채워지고 있음.
    if(patient.needsICU && hospital.occupiedICU[patient.requiredSpecialty] >= hospital.resources.icu[patient.requiredSpecialty]) return false;
    if(patient.needsSurgery && hospital.occupiedOR >= hospital.resources.surgery) return false;
    return true;
  }

  function scoreHospital(patient, hospital){
    // 점수는 작을수록 좋은 병원 — 지금은 직선거리 하나만 본다(문서 3절과 동일).
    // 실제 배정 후 이동 경로(assignRoute/resolveRoute)는 이 점수와 무관하게
    // 별도로 캐시된 실도로 경로를 사용하므로 여기서 건드릴 필요 없음.
    return haversineMeters(patient.lat, patient.lng, hospital.lat, hospital.lng);
  }

  function selectHospital(patient, hospitals){
    var bestHospitalIdx = -1;
    var bestScore = Infinity;
    for(var i=0; i<hospitals.length; i++){
      if(!isHospitalEligible(patient, hospitals[i])) continue;
      var score = scoreHospital(patient, hospitals[i]);
      if(score < bestScore){ bestScore = score; bestHospitalIdx = i; }
    }
    return bestHospitalIdx; // -1 이면 배정 가능한 병원 없음
  }

  // 2026-09-28, 9차 — 순차 탐색 모드의 후보 병원 목록.
  // isHospitalEligible()은 그대로 두고(판정 조건 불변), 여기서는 "진료과를 표방하는가"
  // 라는 정적 조건만으로 후보를 추린다 — 병상/ICU/수술실 여유는 실시간으로 바뀌므로
  // 후보 목록 단계에서는 반영하지 않고, 실제 접촉(CONTACTING) 시점에 isHospitalEligible()
  // 로 즉석 판정한다. 범위는 "51곳 전체 중 해당 진료과 표방 병원"(진료과별 34~51곳,
  // README "9차" 섹션 참고) — 별도로 후보 수를 K개로 제한하지 않았다: 어차피 51곳
  // 자체가 "서울 권역"이라는 이미 좁은 전체 모집단이라, 여기서 또 줄이면 오히려
  // "가까운데 후보에서 빠져서 못 가는" 비현실적 상황을 만들 수 있기 때문이다.
  function buildContactCandidates(patient, hospitals){
    var candidates = [];
    for(var i=0; i<hospitals.length; i++){
      if(hospitals[i].specialties.indexOf(patient.requiredSpecialty) !== -1){
        candidates.push(i);
      }
    }
    candidates.sort(function(a,b){
      return scoreHospital(patient, hospitals[a]) - scoreHospital(patient, hospitals[b]);
    });
    return candidates;
  }

  // isHospitalEligible()과 완전히 같은 조건을 "왜 거절됐는지" 로그 문구로 풀어쓴 것.
  // 판정 순서·기준 자체는 바꾸지 않고 설명만 덧붙인다(이 함수는 배정 여부에 영향을
  // 주지 않음 — isHospitalEligible()의 리턴값만 실제 판정에 쓰인다).
  function hospitalRejectionReason(patient, hospital){
    if(hospital.occupied >= hospital.capacity) return '응급실 병상 부족';
    if(hospital.specialties.indexOf(patient.requiredSpecialty) === -1){
      return patient.requiredSpecialty === '응급_소아' ? '소아 응급실 없음' : (patient.requiredSpecialty+' 중환자실 없음');
    }
    if(patient.needsICU && hospital.occupiedICU[patient.requiredSpecialty] >= hospital.resources.icu[patient.requiredSpecialty]) return patient.requiredSpecialty+' 중환자실 부족';
    if(patient.needsSurgery && hospital.occupiedOR >= hospital.resources.surgery) return '수술실 부족';
    return '알 수 없음';
  }

  var bounds = L.latLngBounds(hospitals.map(function(h){ return [h.lat,h.lng]; }));
  map.fitBounds(bounds, {padding:[40,40]});

  // 2026-10-07, 10차 — 진료계열이 11종으로 늘어 목록에는 요약만 보여준다(전체는 팝업).
  function specSummary(hos){
    var icuKinds = ICU_TYPES.filter(function(k){ return hos.resources.icu[k] > 0; });
    return 'ICU '+icuKinds.length+'종'+(hos.erPediatricBeds>0 ? ' · 소아응급 '+hos.erPediatricBeds+'병상' : ' · 소아응급 없음');
  }
  function icuDetail(hos){
    return ICU_TYPES.filter(function(k){ return hos.resources.icu[k] > 0; }).map(function(k){
      return k+' '+hos.occupiedICU[k]+'/'+hos.resources.icu[k];
    }).join(', ');
  }

  var hospitalListEl = document.getElementById('hospitalList');
  hospitals.forEach(function(hos, idx){
    var item = document.createElement('div');
    item.className = 'hospital-item';
    var icuCap = icuTotal(hos), orCap = hos.resources.surgery;
    item.innerHTML =
      '<div class="hospital-top"><span class="hospital-name">'+hos.name+'</span>'+
      '<span class="hospital-count" id="hcount-'+idx+'">0/'+hos.capacity+'</span></div>'+
      '<div class="hospital-specs">'+GRADE_LABEL[hos.grade]+' · '+specSummary(hos)+'</div>'+
      '<div class="hospital-bar-track"><div class="hospital-bar-fill" id="hbar-'+idx+'" style="width:0%"></div></div>'+
      '<div class="hospital-resource" id="hres-'+idx+'">ICU 0/'+icuCap+' · 수술실 0/'+orCap+'</div>';
    hospitalListEl.appendChild(item);
    hos.barEl = item.querySelector('#hbar-'+idx);
    hos.countEl = item.querySelector('#hcount-'+idx);
    hos.resEl = item.querySelector('#hres-'+idx);
  });

  function updateHospitalVisual(idx){
    var hos = hospitals[idx];
    var ratio = hos.occupied / hos.capacity;
    var color = ratio >= 1 ? COLOR_FULL : (ratio >= 0.7 ? COLOR_BUSY : COLOR_OK);
    var icuCap = icuTotal(hos), icuOcc = occupiedICUTotal(hos), orCap = hos.resources.surgery, orOcc = hos.occupiedOR;
    hos.marker.setStyle({color:color, fillColor:color});
    hos.marker.setTooltipContent(hos.shortName + ' (' + GRADE_LABEL[hos.grade] + ') · ' + hos.occupied + '/' + hos.capacity);
    hos.marker.setPopupContent(hos.name+'<br>'+GRADE_LABEL[hos.grade]+' · '+specSummary(hos)+
      '<br>응급실 병상 '+hos.occupied+'/'+hos.capacity+
      '<br>중환자실(ICU) '+icuOcc+'/'+icuCap+' · 수술실 '+orOcc+'/'+orCap+
      '<br><span style="font-size:11px">'+icuDetail(hos)+'</span>');
    hos.barEl.style.width = Math.min(100, ratio*100) + '%';
    hos.barEl.style.background = color;
    hos.countEl.textContent = hos.occupied + '/' + hos.capacity;
    if(hos.resEl){ hos.resEl.textContent = 'ICU '+icuOcc+'/'+icuCap+' · 수술실 '+orOcc+'/'+orCap; }
  }
  hospitals.forEach(function(_, idx){ updateHospitalVisual(idx); });

  var eventLogEl = document.getElementById('eventLog');
  // 10차: 재실시간이 시간·일 단위가 되어 "N일 HH:MM:SS"로 표시
  function formatSimTime(sec){
    var d = Math.floor(sec/86400), rem = sec - d*86400;
    var h = Math.floor(rem/3600), m = Math.floor((rem%3600)/60), s = Math.floor(rem%60);
    function two(x){ return (x<10?'0':'')+x; }
    return (d>0 ? d+'일 ' : '')+two(h)+':'+two(m)+':'+two(s);
  }
  function logEvent(text){
    var line = document.createElement('div');
    line.textContent = '['+formatSimTime(simTime)+'] '+text;
    eventLogEl.insertBefore(line, eventLogEl.firstChild);
    while(eventLogEl.children.length > 30){ eventLogEl.removeChild(eventLogEl.lastChild); }
  }

  var patients = [];
  var patientIdCounter = 0;
  var spawnCount=0, treatedCount=0, failCount=0;
  // 2026-10-07, 10차 — 응급실 퇴실 수·평균 응급실 체류시간(대기 포함), 수술실 대기 발생 수
  var erDischargeCount=0, totalErStaySec=0, orWaitStartCount=0;
  // 검증·분석용 집계 (화면에는 안 보이고 window.SIM_DEBUG.getState()로 꺼내 봄)
  var debugCounts = {reject:{}, failBySpecialty:{}, spawnBySpecialty:{}};
  var totalTransitDurationSec=0, transitCountForAvg=0;
  // 2026-09-28, 9차 — 탐색(문의) 비용 통계: 배정 성공까지 걸린 시도 횟수와, 발생부터
  // 배정 확정까지 걸린 시간(=waitElapsed, WAITING+CONTACTING 합)을 이송 시간과 분리해서 본다.
  var totalContactAttempts=0, totalSearchDurationSec=0, searchCountForAvg=0;
  var simTime=0;
  applySeed(readSeedFromInput());
  var spawnTimer=getNextArrivalIntervalSec(0);
  var playing=false;

  // 2026-09-28, 9차 — 배정 확정 시 공통으로 필요한 부수효과(점유 갱신·시각화·통계)를
  // 모아둔 헬퍼. 기존에는 WAITING 분기 안에 인라인으로만 있던 코드를 GLOBAL/SEQUENTIAL
  // 두 경로가 같이 쓸 수 있게 뺐다 — 배정 여부 판정 로직(isHospitalEligible/
  // selectHospital)은 그대로이고, "배정이 확정된 다음"만 공통화한 것.
  function assignPatientToHospital(p, hospitalIdx, attempts){
    var hos = hospitals[hospitalIdx];
    hos.occupied++;
    // ICU는 배정 시점에 확보해서 응급실 체류·수술 동안에도 잡아 둔다(병상 예약).
    // 2026-10-07, 10차: 수술실은 배정 때 잡지 않고 응급실 퇴실 후 실제 수술 시간 동안만 점유한다.
    // isHospitalEligible()의 "수술실 여유" 판정은 그대로 "지금 수술 중이 아닌 방이 있는가"로 읽힌다.
    if(p.needsICU){ hos.occupiedICU[p.requiredSpecialty]++; }
    updateHospitalVisual(hospitalIdx);
    p.hospitalIdx = hospitalIdx;
    p.finalContactAttempts = attempts;
    totalContactAttempts += attempts;
    totalSearchDurationSec += p.waitElapsed;
    searchCountForAvg++;
    assignRoute(p, hos, hospitalIdx);
  }

  // 2026-09-28, 9차 — FAILED 전환 공통 헬퍼(기존에는 WAITING 분기에만 인라인으로 있었음).
  function failPatient(p, reasonText){
    p.status = PATIENT_STATUS.FAILED;
    p.removeInReal = FAILED_LINGER_REAL_SEC;
    p.marker.setStyle({color:COLOR_FAILED, fillColor:COLOR_FAILED});
    p.marker.setPopupContent('배정 실패 · '+reasonText);
    p.failReason = reasonText;
    failCount++;
    debugCounts.failBySpecialty[p.requiredSpecialty] = (debugCounts.failBySpecialty[p.requiredSpecialty]||0)+1;
    logEvent('환자 #'+p.id+' 배정 실패 - '+reasonText);
  }

  // 2026-10-07 — 이동 중인 환자 위에 마우스를 올리면 뜨는 툴팁. 열려 있는 동안 updatePatients()가
  // 매 프레임 다시 그려서 남은 시간·문의 병원이 실시간으로 바뀐다.
  var STATUS_LABEL = {waiting:'대기', contacting:'병원 문의 중', transit:'이송 중', failed:'배정 실패'};
  function minText(sec){ return Math.max(0, Math.round(sec/60))+'분'; }
  function patientTooltipHtml(p){
    var lines = [
      '<b>환자 #'+p.id+'</b> · '+(STATUS_LABEL[p.status]||p.status),
      'KTAS '+p.ktasLevel+' · '+AGE_LABEL[p.ageGroup],
      '필요 진료과: '+p.requiredSpecialty+(p.needsICU?' · ICU('+p.icuType+')':'')+(p.needsSurgery?' · 수술':'')
    ];
    if(p.status === PATIENT_STATUS.CONTACTING && p.candidateList && p.candidateList.length){
      var ch = hospitals[p.candidateList[p.candidateIdx % p.candidateList.length]];
      lines.push('문의: '+ch.shortName+' ('+(p.contactAttempts+1)+'번째 · 후보 '+p.candidateList.length+'곳)');
      lines.push('탐색 경과 '+minText(p.waitElapsed)+' / 한도 '+minText(WAIT_TIMEOUT_SEC));
    } else if(p.status === PATIENT_STATUS.TRANSIT && p.route){
      lines.push('→ '+hospitals[p.hospitalIdx].shortName+' · 남은 '+minText(p.route.durationSec - p.elapsed)+
        ' / '+minText(p.route.durationSec)+' · '+(p.route.distanceM/1000).toFixed(1)+'km'+(p.route.approx?' (직선 근사)':''));
      lines.push('문의 '+(p.finalContactAttempts||1)+'회 · 탐색 '+minText(p.waitElapsed));
    } else if(p.status === PATIENT_STATUS.FAILED){
      lines.push(p.failReason || '');
    } else {
      lines.push('대기 '+minText(p.waitElapsed));
    }
    return lines.join('<br>');
  }

  // 2026-09-28, 9차 — CONTACTING 상태에서 "지금 어느 병원에 문의 중인지" 팝업에 보여준다.
  function updateContactingPopup(p, hos){
    var needTag = (p.needsICU?' · 중환자실 필요':'') + (p.needsSurgery?' · 수술 필요':'');
    p.marker.setPopupContent(
      'KTAS '+p.ktasLevel+' · 필요 진료과: '+p.requiredSpecialty+needTag+
      '<br>'+hos.name+'에 문의 중 (시도 '+(p.contactAttempts+1)+'번째 · 후보 '+p.candidateList.length+'곳 중)'
    );
  }

  function assignRoute(p, hos, hospitalIdx){
    var route = resolveRoute(p.lat, p.lng, hospitalIdx, hos.lat, hos.lng, p.routeOriginIdx);
    p.route = route;
    p.cum = computeCumulative(route.coords);
    p.elapsed = 0;
    p.status = PATIENT_STATUS.TRANSIT;
    p.marker.setStyle({color:COLOR_TRANSIT, fillColor:COLOR_TRANSIT});
    // 2026-09-28, 9차: SEQUENTIAL 모드에서는 "문의 → 배정 확정" 서사와 시도 횟수를
    // 로그·팝업에 남긴다. GLOBAL(기존) 모드는 원래 문구를 그대로 유지해서 비교
    // 기준선(baseline)의 서술이 이번 변경으로 바뀌지 않게 했다.
    var isSequential = assignmentMode === ASSIGNMENT_MODE.SEQUENTIAL;
    var attemptsTag = isSequential ? ' · 문의 '+(p.finalContactAttempts||1)+'회 시도 후 배정' : '';
    var needTag = (p.needsICU?' · 중환자실 필요':'') + (p.needsSurgery?' · 수술 필요':'');
    p.marker.setPopupContent('KTAS '+p.ktasLevel+' · 필요 진료과: '+p.requiredSpecialty+needTag+attemptsTag+'<br>이송 중 → '+hos.name);
    var line = L.polyline(route.coords, {
      color: COLOR_TRANSIT, weight: 3, opacity: 0.8,
      dashArray: route.approx ? '6,6' : null
    }).addTo(map);
    p.routeLine = line;
    var etaMin = Math.max(1, Math.round(route.durationSec/60));
    var assignLogText = isSequential
      ? '환자 #'+p.id+' → '+hos.name+' 문의 → 배정 확정 (총 '+(p.finalContactAttempts||1)+'회 시도)'
      : '환자 #'+p.id+' → '+hos.name+' 배정';
    logEvent(assignLogText+(route.approx?' (직선 근사)':' (실도로)')+' · 예상 '+etaMin+'분');
    totalTransitDurationSec += route.durationSec;
    transitCountForAvg++;
  }

  // ============================================================
  // 수연 담당 — 환자 발생 에이전트 모델링 (2026-09-21, 수연 실제 구현 병합)
  // 통계 테이블은 파일 상단 "수연 담당" 섹션 참고.
  // ============================================================

  // 2026-10-07, 10차 — 확률표 구조 점검. 숫자 자체의 검증(합계·IPF 재현)은
  // scripts/6b_validate_patient_probabilities.py 에서 하고, 여기서는 "로드된 표가 이 코드와
  // 맞물리는지"(확률 합 1, 키 누락, 병원 쪽 진료계열 존재)만 본다.
  function validatePatientProbabilities(){
    var errors=[];
    var T=PATIENT_PROBABILITIES;
    function sumIs1(obj, name){
      var vals = Array.isArray(obj) ? obj : Object.keys(obj).map(function(k){ return obj[k]; });
      var s = vals.reduce(function(a,b){ return a+b; },0);
      if(Math.abs(s-1)>1e-6) errors.push(name+' 합계 '+s);
    }
    sumIs1(T.arrival.bands.map(function(b){ return b.share; }), '시간대 비중');
    T.ktasGroupByBand.bands.forEach(function(b,i){
      sumIs1(b.probs, '시간대'+i+' KTAS');
      Object.keys(b.probs).forEach(function(g){ sumIs1(T.ageByBandKtasGroup.bands[i].probs[g], '시간대'+i+' KTAS '+g+' 연령'); });
    });
    Object.keys(T.dispositionByKtasGroupAge.table).forEach(function(g){
      Object.keys(T.dispositionByKtasGroupAge.table[g]).forEach(function(a){
        sumIs1(T.dispositionByKtasGroupAge.table[g][a], '처치 '+g+'/'+a);
        sumIs1(T.ktasLevelByGroupAge.table[g][a], '레벨 '+g+'/'+a);
        Object.keys(T.erLosByKtasGroupAgeResult.table[g][a]).forEach(function(r){
          sumIs1(T.erLosByKtasGroupAgeResult.table[g][a][r], '재실 '+g+'/'+a+'/'+r);
        });
      });
    });
    Object.keys(T.icuTypeByAge.table).forEach(function(a){
      sumIs1(T.icuTypeByAge.table[a], 'ICU 종류 '+a);
      Object.keys(T.icuTypeByAge.table[a]).forEach(function(k){
        if(ICU_TYPES.indexOf(k)===-1) errors.push('알 수 없는 ICU 종류: '+k);
        var any = hospitalsHaveIcuType(k);
        if(!any) errors.push('ICU '+k+'를 가진 병원이 없음');
      });
    });
    sumIs1(T.icuLosDays.probs, 'ICU 재실일수');

    var locationWeightTotal=POPULATION_DENSITY_CELLS.reduce(function(sum,cell){
      if(!cell.densityCellId || !Number.isInteger(cell.routeOriginIdx) || cell.routeOriginIdx<0 || cell.routeOriginIdx>=ROUTE_ORIGINS.length){
        errors.push('인구밀도 격자 연결 오류: '+(cell.densityCellId||'ID 없음'));
      }
      return sum+(Math.max(0,Number(cell.populationWeight)||0));
    },0);
    if(locationWeightTotal<=0) errors.push('populationWeight 합은 0보다 커야 함');

    if(errors.length) console.error('[환자 발생 확률 검증 실패]',errors);
    return errors.length===0;
  }
  function hospitalsHaveIcuType(k){
    for(var i=0;i<hospitals.length;i++){ if(hospitals[i].resources.icu[k] > 0) return true; }
    return false;
  }

  if(!validatePatientProbabilities()) throw new Error('환자 발생 확률표 검증에 실패했습니다.');

  function clockText(t){
    var h = hourOfDay(t), hh = Math.floor(h), mm = Math.floor((h-hh)*60);
    return (hh<10?'0':'')+hh+':'+(mm<10?'0':'')+mm;
  }
  function hourOfDay(t){
    var abs = SIMULATION_START_HOUR*3600 + Math.max(0, t||0);
    return (((abs % 86400) + 86400) % 86400)/3600;
  }

  // 2026-10-07, 10차 — 확률표 기반 프로필. 사슬: 시간대 → KTAS → 연령 → KTAS 레벨 → 응급진료결과
  // (→ ICU/수술 필요) → ICU 종류 → 응급실 재실시간·수술실 시간·ICU 재실일수. 난수는 spawnRandom만
  // 쓰고 환자당 개수가 고정이다(patient_profile_sampler.js).
  function samplePatientProfile(t){
    return patientSampler.sampleProfile(spawnRandom, hourOfDay(t));
  }

  function samplePatientLocation(simTime){
    var cell=sampleDensityCell(simTime);
    var point=samplePointInsideCell(cell);
    return {
      densityCellId:cell.densityCellId,
      routeOriginIdx:cell.routeOriginIdx,
      lat:point.lat,
      lng:point.lng
    };
  }

  // 비균질 포아송 도착: 현재 시간대의 도착률로 지수분포 간격을 뽑는다.
  // 10차: 전체 내원 건수 기준(2026-10-07 결정), 요일 배율 제거.
  function getNextArrivalIntervalSec(t){
    var ratePerSec = patientSampler.arrivalRatePerSec(hourOfDay(t), {multiplier: PATIENT_DEMAND_MULTIPLIER});
    if(!(ratePerSec>0)) throw new Error('환자 도착률은 0보다 커야 합니다.');
    return Math.max(1,-Math.log(Math.max(Number.EPSILON,1-spawnRandom()))/ratePerSec);
  }

  var AGE_LABEL = {infant:'1세 미만', pediatric:'1–14세', adult:'15–64세', elderly:'65세 이상'};
  function spawnPatient(){
    var profile = samplePatientProfile(simTime);
    var location = samplePatientLocation(simTime);

    var marker = L.circleMarker([location.lat, location.lng], {
      radius:5, color:COLOR_WAITING, fillColor:COLOR_WAITING, fillOpacity:0.9, weight:1
    }).addTo(map);
    marker.bindPopup(
      '환자유형: '+profile.patientType+'<br>KTAS '+profile.ktasLevel+' · '+AGE_LABEL[profile.ageGroup]+
      '<br>필요 진료계열: '+profile.requiredSpecialty+
      '<br>ICU '+(profile.needsICU?'필요':'불필요')+' · 수술 '+(profile.needsSurgery?'필요':'불필요')+
      '<br>상태: 대기 중'
    );
    marker.bindTooltip('', {direction:'top', offset:[0,-6]});
    marker.on('tooltipopen', function(){ marker.setTooltipContent(patientTooltipHtml(patient)); });

    var patient = {
      id: ++patientIdCounter,

      patientType: profile.patientType,
      ageGroup: profile.ageGroup,
      ktasLevel: profile.ktasLevel,
      ktasGroup: profile.ktasGroup,
      severityGroup: profile.severityGroup,
      disposition: profile.disposition,
      requiredSpecialty: profile.requiredSpecialty,
      icuType: profile.icuType,
      needsICU: profile.needsICU,
      needsSurgery: profile.needsSurgery,
      erLosSec: profile.erLosSec,
      orSec: profile.orSec,
      icuLosSec: profile.icuLosSec,

      lat: location.lat, lng: location.lng,
      densityCellId: location.densityCellId, routeOriginIdx: location.routeOriginIdx,

      status: PATIENT_STATUS.WAITING, waitElapsed: 0, hospitalIdx: null,
      marker: marker, routeLine: null
    };
    patients.push(patient);
    spawnCount++;
    debugCounts.spawnBySpecialty[patient.requiredSpecialty] = (debugCounts.spawnBySpecialty[patient.requiredSpecialty]||0)+1;
    logEvent(
      '환자 #'+patient.id+' 발생 (KTAS '+patient.ktasLevel+' · '+patient.requiredSpecialty+
      (patient.needsICU?' · ICU':'')+(patient.needsSurgery?' · 수술':'')+')'
    );
  }

  // ============================================================
  // 시작 상태 (2026-10-07, 11차) — 시뮬레이션을 빈 병상에서 시작하지 않고, 실제로 차 있던 병상을
  // 반영해서 시작한다. 선택지(화면 "시작 상태"):
  //  - 실측 스냅샷: data/bed_snapshots.data.js (E-Gen 실시간 가용병상 조회 결과 또는 응급똑똑 캡처).
  //    병원·항목별 점유율 = (전체 − 가용) / 전체 를 시뮬레이션 병상 수에 곱해 "이미 있는 환자"를 만든다.
  //    가용이 음수(대기 환자)면 그 병상은 꽉 찬 것으로 본다. 스냅샷에 없는 ICU 종류는 가정 가동률 사용.
  //    시뮬레이션 시각은 스냅샷 시각에서 시작한다(도착률·환자 구성이 그 시간대 것으로 나옴).
  //  - 가정 가동률: ICU만 입력한 비율(기본 72.9%)로 채우고 응급실·수술실은 비움 (10차 방식)
  //  - 빈 병상: 모두 비우고 시작
  // 이미 있는 환자의 남은 시간은 정상상태 잔여시간 분포(patient_profile_sampler.js). 환자 발생열
  // (spawnRandom)과 섞이지 않게 시드에서 파생한 별도 난수열을 쓰므로 두 배정 모드가 같은 초기
  // 상태에서 시작한다.
  // ============================================================
  var BED_SNAPSHOTS = window.BED_SNAPSHOTS || [];
  var HOSPITAL_INDEX_BY_HPID = {};
  hospitals.forEach(function(h, i){ HOSPITAL_INDEX_BY_HPID[h.hpid] = i; });

  function stochasticRound(x, r){ var f = Math.floor(x); return f + (r() < x - f ? 1 : 0); }
  // 스냅샷 항목들의 점유율. cats: {"ER.일반": {avail,total}, ...}, keys: 합칠 항목 이름들
  function snapshotOccupancy(cats, keys){
    var occ = 0, tot = 0, waiting = 0, found = false;
    keys.forEach(function(k){
      var c = cats[k];
      if(!c || !(c.total > 0)) return;
      found = true;
      tot += c.total;
      occ += Math.min(c.total, Math.max(0, c.total - c.avail));
      if(c.avail < 0) waiting += -c.avail;
    });
    return found ? {ratio: occ/tot, waiting: waiting} : null;
  }
  var ER_SNAPSHOT_KEYS = ['ER.일반','ER.소아','ER.외상소생실','ER.일반격리','ER.음압격리','ER.소아일반격리','ER.소아음압격리','ER.코호트격리'];
  function icuSnapshotKeys(type){ return type === '소아' ? ['ICU.소아','EMG.소아중환자실'] : ['ICU.'+type]; }

  function readStartStateSel(){
    var el = document.getElementById('startStateSel');
    return el ? el.value : (BED_SNAPSHOTS.length ? 'snap:'+BED_SNAPSHOTS[0].id : 'assumed');
  }

  function addPreexisting(status, idx, extra){
    var p = { id: 'pre-'+(++preexistingCounter), status: status, hospitalIdx: idx, preexisting: true,
              needsICU: false, needsSurgery: false, marker: null, routeLine: null };
    for(var k in extra) p[k] = extra[k];
    patients.push(p);
  }
  var preexistingCounter = 0;

  // 반환: 화면 로그용 요약
  function seedInitialState(seed){
    var r = mulberry32(((seed>>>0) ^ 0x9E3779B9)>>>0);
    var mode = readStartStateSel();
    var icuRate = readIcuOccupancyInput();
    preexistingCounter = 0;
    var sum = {er:0, icu:0, or:0, icuFallbackBeds:0, waiting:0, mode:mode, label:''};
    var snap = null;
    if(mode.indexOf('snap:') === 0){
      var id = mode.slice(5);
      for(var i=0;i<BED_SNAPSHOTS.length;i++) if(BED_SNAPSHOTS[i].id === id) snap = BED_SNAPSHOTS[i];
    }
    SIMULATION_START_HOUR = snap ? (Number(snap.startHour)||0) : 0;
    if(mode === 'empty') { sum.label = '빈 병상'; return sum; }

    hospitals.forEach(function(hos, idx){
      var cats = (snap && snap.hospitals[hos.hpid]) ? snap.hospitals[hos.hpid].cats : null;
      // 응급실 (스냅샷일 때만)
      if(cats){
        var er = snapshotOccupancy(cats, ER_SNAPSHOT_KEYS);
        if(er){
          var nEr = Math.min(hos.capacity, stochasticRound(hos.capacity*er.ratio, r));
          sum.waiting += er.waiting;
          for(var j=0;j<nEr;j++){
            hos.occupied++; sum.er++;
            addPreexisting(PATIENT_STATUS.TREATING, idx, {treatRemaining: patientSampler.sampleErResidualSec(r, SIMULATION_START_HOUR)});
          }
        }
        var or = snapshotOccupancy(cats, ['OR.수술실']);
        if(or){
          var nOr = Math.min(hos.resources.surgery, stochasticRound(hos.resources.surgery*or.ratio, r));
          for(var q=0;q<nOr;q++){
            hos.occupiedOR++; sum.or++;
            addPreexisting(PATIENT_STATUS.SURGERY, idx, {orRemaining: patientSampler.sampleOrResidualSec(r)});
          }
        }
      }
      // ICU 9종: 스냅샷에 있으면 그 점유율, 없으면 가정 가동률
      ICU_TYPES.forEach(function(k){
        var cap = hos.resources.icu[k] || 0;
        if(!cap) return;
        var o = cats ? snapshotOccupancy(cats, icuSnapshotKeys(k)) : null;
        var ratio = o ? o.ratio : icuRate;
        if(!o && snap) sum.icuFallbackBeds += cap;
        var count = Math.min(cap, stochasticRound(cap*ratio, r));
        for(var j=0;j<count;j++){
          hos.occupiedICU[k]++; sum.icu++;
          addPreexisting(PATIENT_STATUS.ICU_STAY, idx, {requiredSpecialty: k, icuType: k, needsICU: true,
            icuRemaining: patientSampler.sampleIcuResidualSec(r)});
        }
      });
    });
    sum.label = snap ? snap.label : ('가정 가동률 ICU '+(icuRate*100).toFixed(1)+'%');
    return sum;
  }
  function logInitialState(sum){
    var hh = Math.floor(SIMULATION_START_HOUR), mm = Math.round((SIMULATION_START_HOUR-hh)*60);
    logEvent('시작 상태: '+sum.label+' · 시작 시각 '+(hh<10?'0':'')+hh+':'+(mm<10?'0':'')+mm+
      ' · 기존 환자 응급실 '+sum.er+' · 수술 '+sum.or+' · ICU '+sum.icu+
      (sum.waiting ? ' · 응급실 대기 '+sum.waiting+'명(스냅샷, 병상 만석 처리)' : '')+
      (sum.icuFallbackBeds ? ' · 스냅샷에 없는 ICU '+sum.icuFallbackBeds+'병상은 가정 가동률' : ''));
  }
  function readIcuOccupancyInput(){
    var el = document.getElementById('icuOccInput');
    var v = el ? parseFloat(el.value) : NaN;
    if(!Number.isFinite(v)) return DEFAULT_ICU_INITIAL_OCCUPANCY;
    return Math.max(0, Math.min(100, v))/100;
  }

  // ============================================================
  // 공동 연결 영역 — 수연의 환자 객체와 민성의 병원 선정 함수를 잇는 부분.
  // 한쪽이 단독으로 수정하지 않고, 병합 시 같이 확인할 것(문서 4절).
  // ============================================================
  function updatePatients(simDt, realDt){
    for(var i=patients.length-1; i>=0; i--){
      var p = patients[i];

      if(p.status === PATIENT_STATUS.WAITING){
        p.waitElapsed += simDt;

        if(assignmentMode === ASSIGNMENT_MODE.GLOBAL){
          // 기존 로직 그대로: 51곳 즉시 전역 스캔 후 최적 병원에 바로 배정.
          var selectedHospitalIdx = selectHospital(p, hospitals);
          if(selectedHospitalIdx !== -1){
            assignPatientToHospital(p, selectedHospitalIdx, 1);
          } else if(p.waitElapsed > WAIT_TIMEOUT_SEC){
            var failReason = (p.needsICU||p.needsSurgery) ? '가용 응급실/중환자실/수술실 없음' : '가용 응급실 없음';
            failPatient(p, failReason);
          }
        } else {
          // 2026-09-28, 9차 — SEQUENTIAL(기본) 모드: WAITING은 "아직 첫 문의를 시작하지
          // 않음"이라는 찰나의 상태다. 발생 직후 같은 틱에서 바로 후보 목록을 만들고
          // CONTACTING으로 넘어간다(첫 접촉 자체는 CONTACT_ATTEMPT_SEC 뒤에 이뤄짐).
          p.candidateList = buildContactCandidates(p, hospitals);
          p.candidateIdx = 0;
          p.contactAttempts = 0;
          p.contactElapsed = 0;
          if(p.candidateList.length === 0){
            // 51곳 중 이 진료과를 표방하는 병원이 하나도 없는 경우 — 현재 데이터로는
            // 사실상 발생하지 않지만(모든 진료과가 최소 34곳 이상에서 표방됨) 방어적으로 처리.
            failPatient(p, '해당 진료과를 표방하는 응급실 없음');
          } else {
            p.status = PATIENT_STATUS.CONTACTING;
            p.marker.setStyle({color:COLOR_REQUEST, fillColor:COLOR_REQUEST});
            updateContactingPopup(p, hospitals[p.candidateList[0]]);
          }
        }
      } else if(p.status === PATIENT_STATUS.CONTACTING){
        p.waitElapsed += simDt;
        if(p.waitElapsed > WAIT_TIMEOUT_SEC){
          failPatient(p, '가용 응급실 없음 (문의 '+p.contactAttempts+'회 시도)');
        } else {
          p.contactElapsed += simDt;
          // 배속이 높을 때 한 틱에 여러 번 접촉 주기가 지나갈 수 있어 while로 처리
          // (spawnTimer 누적과 같은 원칙, 위 tick() 주석 참고).
          while(p.contactElapsed >= CONTACT_ATTEMPT_SEC && p.status === PATIENT_STATUS.CONTACTING){
            p.contactElapsed -= CONTACT_ATTEMPT_SEC;
            var hIdx = p.candidateList[p.candidateIdx % p.candidateList.length];
            var hos = hospitals[hIdx];
            p.contactAttempts++;
            if(isHospitalEligible(p, hos)){
              assignPatientToHospital(p, hIdx, p.contactAttempts);
            } else {
              var rejectReason = hospitalRejectionReason(p, hos);
              debugCounts.reject[rejectReason] = (debugCounts.reject[rejectReason]||0)+1;
              logEvent('환자 #'+p.id+' → '+hos.name+' 문의 → 거절 ('+rejectReason+')');
              p.candidateIdx++;
              if(p.waitElapsed > WAIT_TIMEOUT_SEC){
                failPatient(p, '가용 응급실 없음 (문의 '+p.contactAttempts+'회 시도)');
              }
            }
          }
          if(p.status === PATIENT_STATUS.CONTACTING){
            updateContactingPopup(p, hospitals[p.candidateList[p.candidateIdx % p.candidateList.length]]);
          }
        }
      } else if(p.status === PATIENT_STATUS.TRANSIT){
        p.elapsed += simDt;
        var progress = Math.min(1, p.elapsed / p.route.durationSec);
        var pos = positionAtProgress(p.cum, p.route.coords, progress);
        p.lat = pos[0]; p.lng = pos[1];
        p.marker.setLatLng(pos);
        if(progress >= 1){
          p.status = PATIENT_STATUS.TREATING;
          // 2026-10-07, 10차: 응급실 재실시간은 표 11 기반 분포에서 발생 시점에 이미 뽑아 둔 값
          p.treatRemaining = p.erLosSec;
          p.arrivedAt = simTime;
          if(p.routeLine){ map.removeLayer(p.routeLine); p.routeLine = null; }
          map.removeLayer(p.marker);
          p.marker = null;
        }
      } else if(p.status === PATIENT_STATUS.TREATING){
        // 응급실 병상 점유 단계. 재실시간이 끝나면:
        //  - 수술 필요 → 수술실이 비어 있으면 응급실 병상 반납 후 SURGERY, 다 차 있으면 응급실에서 대기
        //  - ICU 필요(수술 없음) → 응급실 병상 반납 후 ICU_STAY (ICU는 배정 때 이미 확보)
        //  - 그 외 → 퇴실(귀가·일반병실 입원·전원 등, 이후는 모델 밖)
        p.treatRemaining -= simDt;
        if(p.treatRemaining <= 0){
          var dischargeHos = hospitals[p.hospitalIdx];
          if(p.needsSurgery && dischargeHos.occupiedOR >= dischargeHos.resources.surgery){
            if(!p.waitingOR){ p.waitingOR = true; orWaitStartCount++; logEvent('환자 #'+p.id+' 수술실 대기 · '+dischargeHos.name); }
            continue; // 응급실 병상을 잡은 채 대기 (다음 틱에 다시 확인)
          }
          dischargeHos.occupied--;
          if(p.preexisting){ updateHospitalVisual(p.hospitalIdx); patients.splice(i,1); continue; } // 시작 시점에 있던 환자: 퇴실만
          erDischargeCount++;
          totalErStaySec += simTime - p.arrivedAt;
          if(p.needsSurgery){
            dischargeHos.occupiedOR++;
            p.status = PATIENT_STATUS.SURGERY;
            p.orRemaining = p.orSec;
            logEvent('환자 #'+p.id+' 응급실 퇴실 → 수술 시작 · '+dischargeHos.name);
          } else if(p.needsICU){
            p.status = PATIENT_STATUS.ICU_STAY;
            p.icuRemaining = p.icuLosSec;
            logEvent('환자 #'+p.id+' 응급실 퇴실 → '+p.requiredSpecialty+' 중환자실 · '+dischargeHos.name);
          } else {
            treatedCount++;
            logEvent('환자 #'+p.id+' 응급실 퇴실 · '+dischargeHos.name+' 병상 반납');
            patients.splice(i,1);
          }
          updateHospitalVisual(p.hospitalIdx);
        }
      } else if(p.status === PATIENT_STATUS.SURGERY){
        p.orRemaining -= simDt;
        if(p.orRemaining <= 0){
          var orHos = hospitals[p.hospitalIdx];
          orHos.occupiedOR--;
          if(p.needsICU){
            p.status = PATIENT_STATUS.ICU_STAY;
            p.icuRemaining = p.icuLosSec;
          } else {
            if(!p.preexisting) treatedCount++;
            patients.splice(i,1);
          }
          updateHospitalVisual(p.hospitalIdx);
        }
      } else if(p.status === PATIENT_STATUS.ICU_STAY){
        p.icuRemaining -= simDt;
        if(p.icuRemaining <= 0){
          var icuHos = hospitals[p.hospitalIdx];
          icuHos.occupiedICU[p.requiredSpecialty]--;
          if(!p.preexisting) treatedCount++;
          updateHospitalVisual(p.hospitalIdx);
          patients.splice(i,1);
        }
      } else if(p.status === PATIENT_STATUS.FAILED){
        p.removeInReal -= realDt;
        p.marker.setStyle({fillOpacity: Math.max(0, p.removeInReal/FAILED_LINGER_REAL_SEC)});
        if(p.removeInReal <= 0){
          map.removeLayer(p.marker);
          patients.splice(i,1);
        }
      }
    }
    // 마우스를 올려 둔 환자의 툴팁은 매 프레임 위치·내용을 갱신한다(이송 중에는 마커가 움직이므로)
    for(var t=0; t<patients.length; t++){
      var tp = patients[t];
      if(tp.marker && tp.marker.isTooltipOpen()){
        tp.marker.getTooltip().setLatLng(tp.marker.getLatLng());
        tp.marker.setTooltipContent(patientTooltipHtml(tp));
      }
    }
  }

  function updateStatsDisplay(){
    document.getElementById('spawnStat').textContent = spawnCount;
    document.getElementById('treatedStat').textContent = treatedCount;
    document.getElementById('failStat').textContent = failCount;
    document.getElementById('etaStat').textContent = transitCountForAvg > 0
      ? Math.round(totalTransitDurationSec/transitCountForAvg/60) : '-';
    // 2026-09-28, 9차 — 탐색 비용 지표: 배정까지 평균 몇 번 문의했는지, 그 탐색에
    // 평균 얼마나 걸렸는지(이송 시간과 분리). GLOBAL 모드에서는 시도=1·탐색시간≈0으로
    // 나와서 SEQUENTIAL과의 대비가 그대로 숫자로 드러난다.
    var avgAttemptsEl = document.getElementById('avgAttemptsStat');
    var avgSearchEl = document.getElementById('avgSearchStat');
    if(avgAttemptsEl) avgAttemptsEl.textContent = searchCountForAvg > 0
      ? (totalContactAttempts/searchCountForAvg).toFixed(1) : '-';
    if(avgSearchEl) avgSearchEl.textContent = searchCountForAvg > 0
      ? (totalSearchDurationSec/searchCountForAvg/60).toFixed(1) : '-';
    var waitingCount = 0, contactingCount = 0, transitCount = 0, erCount = 0, orWaitCount = 0, surgeryCount = 0;
    for(var i=0;i<patients.length;i++){
      var st = patients[i].status;
      if(st===PATIENT_STATUS.WAITING) waitingCount++;
      else if(st===PATIENT_STATUS.CONTACTING) contactingCount++;
      else if(st===PATIENT_STATUS.TRANSIT) transitCount++;
      else if(st===PATIENT_STATUS.TREATING){ erCount++; if(patients[i].waitingOR) orWaitCount++; }
      else if(st===PATIENT_STATUS.SURGERY) surgeryCount++;
    }
    // 10차 — 병상 가동 지표
    var erOcc=0, erCap=0, icuOcc=0, icuCap=0;
    hospitals.forEach(function(h){ erOcc+=h.occupied; erCap+=h.capacity; icuOcc+=occupiedICUTotal(h); icuCap+=icuTotal(h); });
    var setText = function(id, v){ var el=document.getElementById(id); if(el) el.textContent=v; };
    setText('erOccStat', erCap>0 ? (erOcc/erCap*100).toFixed(0)+'%' : '-');
    setText('icuOccStat', icuCap>0 ? (icuOcc/icuCap*100).toFixed(1)+'%' : '-');
    setText('erStayStat', erDischargeCount>0 ? (totalErStaySec/erDischargeCount/3600).toFixed(1) : '-');
    setText('orWaitStat', orWaitCount+' / 누적 '+orWaitStartCount);
    setText('liveReadout', '대기 '+waitingCount+' · 문의중 '+contactingCount+' · 이송중 '+transitCount+
      ' · 응급실 '+erCount+' · 수술 '+surgeryCount+' · 경과 '+formatSimTime(simTime)+' · 시각 '+clockText(simTime));
  }

  function resetSim(){
    playing = false;
    updatePlayButton();
    patients.forEach(function(p){
      if(p.marker) map.removeLayer(p.marker);
      if(p.routeLine) map.removeLayer(p.routeLine);
    });
    patients = [];
    hospitals.forEach(function(hos, idx){
      hos.occupied = 0;
      hos.occupiedICU = zeroIcuMap();
      hos.occupiedOR = 0;
    });
    spawnCount=0; treatedCount=0; failCount=0;
    erDischargeCount=0; totalErStaySec=0; orWaitStartCount=0;
    debugCounts = {reject:{}, failBySpecialty:{}, spawnBySpecialty:{}};
    totalTransitDurationSec=0; transitCountForAvg=0;
    totalContactAttempts=0; totalSearchDurationSec=0; searchCountForAvg=0;
    // 2026-09-28, 9차 — 초기화할 때마다 시드 입력칸의 값으로 다시 시드를 건다. 시드값을
    // 그대로 두고 모드만 바꿔 초기화하면(아래 modeSel 변경 핸들러), 두 모드에 동일한
    // 환자 발생열이 재생된다.
    var seed = readSeedFromInput();
    applySeed(seed);
    simTime=0;
    var sum = seedInitialState(seed);   // 시작 시각(SIMULATION_START_HOUR)도 여기서 정해짐
    hospitals.forEach(function(_, idx){ updateHospitalVisual(idx); });
    spawnTimer = getNextArrivalIntervalSec(simTime);
    eventLogEl.innerHTML = '';
    logInitialState(sum);
    updateStatsDisplay();
  }

  // 시작 상태 초기화 (11차) — 아래 함수·스냅샷 변수가 모두 정의된 뒤에 실행해야 한다
  (function(){
    var icuOccEl = document.getElementById('icuOccInput');
    if(icuOccEl && !icuOccEl.value) icuOccEl.value = (DEFAULT_ICU_INITIAL_OCCUPANCY*100).toFixed(1);
    // 11차 — 시작 상태 선택칸 채우기 (스냅샷 최신순, 기본은 가장 최근 스냅샷)
    var sel = document.getElementById('startStateSel');
    if(sel){
      BED_SNAPSHOTS.forEach(function(sn){
        var o = document.createElement('option'); o.value = 'snap:'+sn.id; o.textContent = '실측: '+sn.label; sel.appendChild(o);
      });
      [['assumed','가정 가동률(ICU만)'],['empty','빈 병상']].forEach(function(x){
        var o = document.createElement('option'); o.value = x[0]; o.textContent = x[1]; sel.appendChild(o);
      });
      sel.value = BED_SNAPSHOTS.length ? 'snap:'+BED_SNAPSHOTS[0].id : 'assumed';
      sel.addEventListener('change', resetSim);
    }
    var sum = seedInitialState(readSeedFromInput());
    spawnTimer = getNextArrivalIntervalSec(0);
    hospitals.forEach(function(_, idx){ updateHospitalVisual(idx); });
    logInitialState(sum);
  })();

  var playBtn = document.getElementById('playBtn');
  function updatePlayButton(){
    playBtn.textContent = playing ? '일시정지' : '재생';
  }
  playBtn.addEventListener('click', function(){
    playing = !playing;
    updatePlayButton();
  });
  document.getElementById('burstBtn').addEventListener('click', function(){
    for(var i=0;i<8;i++) spawnPatient();
    updateStatsDisplay();
  });
  document.getElementById('resetBtn').addEventListener('click', resetSim);

  // 2026-09-28, 9차 — 배정 모드 토글. 모드를 바꾸면 진행 중이던 WAITING/CONTACTING
  // 환자의 상태 가정이 서로 달라 섞어 쓰기 어려우므로, 깨끗한 비교를 위해 전환 시
  // 항상 초기화한다(시드값은 유지되므로 같은 환자 발생열로 다시 재생됨).
  var modeSel = document.getElementById('modeSel');
  if(modeSel){
    modeSel.value = assignmentMode;
    modeSel.addEventListener('change', function(){
      assignmentMode = modeSel.value === ASSIGNMENT_MODE.GLOBAL ? ASSIGNMENT_MODE.GLOBAL : ASSIGNMENT_MODE.SEQUENTIAL;
      resetSim();
    });
  }
  var newSeedBtn = document.getElementById('newSeedBtn');
  if(newSeedBtn){
    newSeedBtn.addEventListener('click', function(){
      var seedInputEl = document.getElementById('seedInput');
      if(seedInputEl) seedInputEl.value = Math.floor(nativeRandom()*1e9);
      resetSim();
    });
  }

  var speedSel = document.getElementById('speedSel');
  SPEED_LEVELS.forEach(function(v, idx){
    var opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v + '배속';
    if(idx === DEFAULT_SPEED_INDEX) opt.selected = true;
    speedSel.appendChild(opt);
  });
  var speedFactor = SPEED_LEVELS[DEFAULT_SPEED_INDEX];
  speedSel.addEventListener('change', function(){
    speedFactor = parseInt(speedSel.value, 10);
  });

  var lastNow = performance.now();
  function tick(now){
    var realDt = Math.min(0.25, (now - lastNow) / 1000);
    lastNow = now;
    if(playing){
      var simDt = realDt * speedFactor;
      simTime += simDt;
      spawnTimer -= simDt;
      // 2026-09-21: 수연님 수정 반영 — 배속이 높거나 도착률이 순간적으로 높을 때
      // 한 틱에 여러 명이 발생할 수 있어 if 대신 while로, 다음 간격은 누적(+=)한다
      // (교체 대입은 프레임이 드롭될 때 도착 과정 특성을 왜곡시킬 수 있음).
      while(spawnTimer <= 0){
        spawnPatient();
        spawnTimer += getNextArrivalIntervalSec(simTime);
      }
      updatePatients(simDt, realDt);
      updateStatsDisplay();
    } else {
      updatePatients(0, realDt);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.addEventListener('resize', function(){ map.invalidateSize(); });

  // 2026-10-07, 10차 — 검증·발표 자료용 상태 조회(콘솔에서 SIM_DEBUG.getState()). 시뮬레이션 동작에는 영향 없음.
  window.SIM_DEBUG = {
    getState: function(){
      var icuByType = {};
      ICU_TYPES.forEach(function(k){
        var occ=0, cap=0;
        hospitals.forEach(function(h){ occ+=h.occupiedICU[k]; cap+=h.resources.icu[k]; });
        icuByType[k] = {occupied:occ, capacity:cap};
      });
      var er={occupied:0,capacity:0}, or={occupied:0,capacity:0};
      hospitals.forEach(function(h){ er.occupied+=h.occupied; er.capacity+=h.capacity; or.occupied+=h.occupiedOR; or.capacity+=h.resources.surgery; });
      return { simTime: simTime, spawn: spawnCount, treated: treatedCount, fail: failCount, er: er, or: or, icuByType: icuByType,
               erDischarge: erDischargeCount, avgErStayH: erDischargeCount ? totalErStaySec/erDischargeCount/3600 : null,
               orWaitStarts: orWaitStartCount, counts: debugCounts,
               avgAttempts: searchCountForAvg ? totalContactAttempts/searchCountForAvg : null,
               avgSearchMin: searchCountForAvg ? totalSearchDurationSec/searchCountForAvg/60 : null };
    }
  };

  updateStatsDisplay();
})();
