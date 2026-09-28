// 서울 응급실 배정 시뮬레이션 — 로직 전체
// 데이터는 data/*.data.js 에서 window.HOSPITALS_DATA / ROUTE_ORIGINS / ROUTE_CACHE_RAW / SPAWN_BOUNDS 로 주입됨.
// index.html 에서 data/*.data.js 를 먼저 로드한 뒤 이 파일을 로드해야 함.

(function(){

  var SPECIALTIES = ['외상','심장','소아','일반','내과'];

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
  var PATIENT_STATUS = { WAITING: 'waiting', CONTACTING: 'contacting', TRANSIT: 'transit', TREATING: 'treating', FAILED: 'failed' };

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

  // 2026-09-28, 8차 — 질병군(소아·외상이 아닌 나머지) 환자를 내과/일반/심장 세
  // 버킷에 배분하는 가중치. 서울/전국 단위 "상병별 응급실 이용" 실측 통계가 없어서
  // (엑셀 두 개·응급의료 통계연보 모두 확인함, 진단명 분포 데이터 없음), 각 병원이
  // 신고한 중환자실 병상 규모(icu.내과/icu.일반/icu.심장 합계)에 비례해서 배분한다
  // — "실제 유병률"이 아니라 "병상 공급량을 대리변수로 쓴 가정"임을 분명히 밝혀둔다.
  // 병상 규모가 바뀌면(데이터 갱신 시) 이 가중치도 자동으로 같이 바뀐다.
  var DISEASE_SPECIALTY_WEIGHTS = (function(){
    var totals = {일반:0, 내과:0, 심장:0};
    HOSPITALS_DATA.forEach(function(h){
      var icu = (h.resources && h.resources.icu) || {};
      totals.일반 += Number(icu.일반)||0;
      totals.내과 += Number(icu.내과)||0;
      totals.심장 += Number(icu.심장)||0;
    });
    var sum = totals.일반 + totals.내과 + totals.심장;
    if(!(sum>0)) throw new Error('DISEASE_SPECIALTY_WEIGHTS 합이 0입니다 — hospitals.json의 resources.icu를 확인하세요.');
    return { 일반: totals.일반/sum, 내과: totals.내과/sum, 심장: totals.심장/sum };
  })();

  // ============================================================
  // 수연 담당 — 환자 발생 에이전트 모델링 (2026-09-21, 수연 실제 구현 반영)
  // 통계 확률·연령군·중증도·발생 위치·발생 간격은 전부 이 섹션에서 다룸.
  // 출처: 2024 응급의료 통계연보 서울 NEDIS 통계. 자세한 방법론은 수연님이
  // 공유한 원본 주석 참고.
  // ============================================================

  // 연령군×KTAS 결합빈도 — '기타/미상' 제외 후 재정규화.
  var AGE_KTAS_JOINT_COUNTS = [
    {ageGroup:'infant',ktasLevel:1,count:112},
    {ageGroup:'infant',ktasLevel:2,count:3410},
    {ageGroup:'infant',ktasLevel:3,count:10366},
    {ageGroup:'infant',ktasLevel:4,count:2670},
    {ageGroup:'infant',ktasLevel:5,count:395},
    {ageGroup:'pediatric',ktasLevel:1,count:559},
    {ageGroup:'pediatric',ktasLevel:2,count:6084},
    {ageGroup:'pediatric',ktasLevel:3,count:61196},
    {ageGroup:'pediatric',ktasLevel:4,count:28707},
    {ageGroup:'pediatric',ktasLevel:5,count:3783},
    {ageGroup:'adult',ktasLevel:1,count:4939},
    {ageGroup:'adult',ktasLevel:2,count:33522},
    {ageGroup:'adult',ktasLevel:3,count:217967},
    {ageGroup:'adult',ktasLevel:4,count:102988},
    {ageGroup:'adult',ktasLevel:5,count:29753},
    {ageGroup:'elderly',ktasLevel:1,count:9640},
    {ageGroup:'elderly',ktasLevel:2,count:43021},
    {ageGroup:'elderly',ktasLevel:3,count:175260},
    {ageGroup:'elderly',ktasLevel:4,count:49962},
    {ageGroup:'elderly',ktasLevel:5,count:16159}
  ];

  // 연령군별 질병/손상 빈도. 두 항목 외 기타/미상은 제외하고 재정규화.
  var CASE_TYPE_COUNTS_BY_AGE = {
    infant:{disease:14106,injury:2844},
    pediatric:{disease:76016,injury:24311},
    adult:{disease:314015,injury:75122},
    elderly:{disease:257051,injury:36900}
  };

  // 응급실 전체 내원자를 분모로 한 중환자실/수술·시술 후 입원 필요의 결합확률.
  // surgery는 통계연보의 '수술 또는 시술 후 병실/중환자실 입원'을 대리변수로 사용.
  var RESOURCE_NEED_PROBABILITIES_BY_KTAS = {
    critical:{icuOnly:16544/101287,surgeryOnly:992/101287,both:4506/101287,neither:79245/101287},
    urgent:{icuOnly:11512/464791,surgeryOnly:4199/464791,both:2544/464791,neither:446536/464791},
    less_urgent:{icuOnly:710/234417,surgeryOnly:598/234417,both:158/234417,neither:232951/234417}
  };

  // 시간대·요일별 내원 빈도 — 비균질 포아송 도착 간격 계산용.
  var ANNUAL_ED_VISIT_COUNT = 800599;
  var ANNUAL_DAY_COUNT = 366;
  var ARRIVAL_TIME_COUNTS = [
    {startHour:0,endHour:3,count:69887},
    {startHour:3,endHour:6,count:47677},
    {startHour:6,endHour:9,count:69386},
    {startHour:9,endHour:12,count:133538},
    {startHour:12,endHour:15,count:125498},
    {startHour:15,endHour:18,count:120522},
    {startHour:18,endHour:21,count:121681},
    {startHour:21,endHour:24,count:112410}
  ];
  // JavaScript Date 규칙: 0=일요일, 1=월요일, ... 6=토요일
  var ARRIVAL_DAY_COUNTS = [125623,123744,110524,107087,107471,110510,115640];
  var SIMULATION_START_HOUR = 0;
  var SIMULATION_START_DAY_OF_WEEK = 1;
  var PATIENT_DEMAND_MULTIPLIER = 1;

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
  var TREAT_MIN_SEC = 1800, TREAT_MAX_SEC = 5400;
  var AVG_SPEED_KMH = 19.5;                      // 캐시에 없는 구간의 직선 근사용 평균 속도 (카카오 실측 128구간 평균 19.5km/h 기반)
  var CONGESTION_MIN = 0.85, CONGESTION_MAX = 1.25;
  var FAILED_LINGER_REAL_SEC = 2.5;
  var SPEED_LEVELS = [20, 45, 90, 180, 360];
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
    return {
      name:h.name, shortName:h.shortName, grade:h.grade, lat:h.lat, lng:h.lng,
      capacity:h.capacity, specialties:h.specialties, occupied:0, marker:marker, radius:radius,
      barEl:null, countEl:null,
      resources: h.resources || {icu:{외상:0,심장:0,소아:0,일반:0,내과:0}, surgery:0},
      occupiedICU: {외상:0, 심장:0, 소아:0, 일반:0, 내과:0}, occupiedOR: 0,
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
    if(hospital.specialties.indexOf(patient.requiredSpecialty) === -1) return '진료과 미표방';
    if(patient.needsICU && hospital.occupiedICU[patient.requiredSpecialty] >= hospital.resources.icu[patient.requiredSpecialty]) return '중환자실 부족';
    if(patient.needsSurgery && hospital.occupiedOR >= hospital.resources.surgery) return '수술실 부족';
    return '알 수 없음';
  }

  var bounds = L.latLngBounds(hospitals.map(function(h){ return [h.lat,h.lng]; }));
  map.fitBounds(bounds, {padding:[40,40]});

  var hospitalListEl = document.getElementById('hospitalList');
  hospitals.forEach(function(hos, idx){
    var item = document.createElement('div');
    item.className = 'hospital-item';
    var icuCap = icuTotal(hos), orCap = hos.resources.surgery;
    item.innerHTML =
      '<div class="hospital-top"><span class="hospital-name">'+hos.name+'</span>'+
      '<span class="hospital-count" id="hcount-'+idx+'">0/'+hos.capacity+'</span></div>'+
      '<div class="hospital-specs">'+GRADE_LABEL[hos.grade]+' · '+hos.specialties.join(' · ')+'</div>'+
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
    hos.marker.setPopupContent(hos.name+'<br>'+GRADE_LABEL[hos.grade]+' · '+hos.specialties.join(', ')+
      '<br>응급실 병상 '+hos.occupied+'/'+hos.capacity+
      '<br>중환자실(ICU) '+icuOcc+'/'+icuCap+' · 수술실 '+orOcc+'/'+orCap);
    hos.barEl.style.width = Math.min(100, ratio*100) + '%';
    hos.barEl.style.background = color;
    hos.countEl.textContent = hos.occupied + '/' + hos.capacity;
    if(hos.resEl){ hos.resEl.textContent = 'ICU '+icuOcc+'/'+icuCap+' · 수술실 '+orOcc+'/'+orCap; }
  }
  hospitals.forEach(function(_, idx){ updateHospitalVisual(idx); });

  var eventLogEl = document.getElementById('eventLog');
  function formatSimTime(sec){
    var m = Math.floor(sec/60);
    var s = Math.floor(sec%60);
    return (m<10?'0':'')+m+':'+(s<10?'0':'')+s;
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
  var totalTransitDurationSec=0, transitCountForAvg=0;
  // 2026-09-28, 9차 — 탐색(문의) 비용 통계: 배정 성공까지 걸린 시도 횟수와, 발생부터
  // 배정 확정까지 걸린 시간(=waitElapsed, WAITING+CONTACTING 합)을 이송 시간과 분리해서 본다.
  var totalContactAttempts=0, totalSearchDurationSec=0, searchCountForAvg=0;
  applySeed(readSeedFromInput());
  var simTime=0, spawnTimer=getNextArrivalIntervalSec(0);
  var playing=false;

  // 2026-09-28, 9차 — 배정 확정 시 공통으로 필요한 부수효과(점유 갱신·시각화·통계)를
  // 모아둔 헬퍼. 기존에는 WAITING 분기 안에 인라인으로만 있던 코드를 GLOBAL/SEQUENTIAL
  // 두 경로가 같이 쓸 수 있게 뺐다 — 배정 여부 판정 로직(isHospitalEligible/
  // selectHospital)은 그대로이고, "배정이 확정된 다음"만 공통화한 것.
  function assignPatientToHospital(p, hospitalIdx, attempts){
    var hos = hospitals[hospitalIdx];
    hos.occupied++;
    if(p.needsICU){ hos.occupiedICU[p.requiredSpecialty]++; }
    if(p.needsSurgery){ hos.occupiedOR++; }
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
    failCount++;
    logEvent('환자 #'+p.id+' 배정 실패 - '+reasonText);
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

  function validatePatientProbabilities(){
    var errors=[];
    var jointTotal=0;
    AGE_KTAS_JOINT_COUNTS.forEach(function(row){
      if(!row.ageGroup || row.ktasLevel<1 || row.ktasLevel>5 || !(row.count>=0)) errors.push('AGE_KTAS_JOINT_COUNTS 항목 오류');
      jointTotal+=Number(row.count)||0;
    });
    if(jointTotal!==800493) errors.push('연령×KTAS 유효 표본 합계 불일치: '+jointTotal);

    Object.keys(CASE_TYPE_COUNTS_BY_AGE).forEach(function(ageGroup){
      var row=CASE_TYPE_COUNTS_BY_AGE[ageGroup];
      if(!(row.disease>=0) || !(row.injury>=0) || row.disease+row.injury<=0) errors.push('질병/손상 빈도 오류: '+ageGroup);
    });
    Object.keys(RESOURCE_NEED_PROBABILITIES_BY_KTAS).forEach(function(severity){
      var row=RESOURCE_NEED_PROBABILITIES_BY_KTAS[severity];
      var sum=row.icuOnly+row.surgeryOnly+row.both+row.neither;
      if(Math.abs(sum-1)>1e-9) errors.push('자원 필요 결합확률 합계 오류: '+severity+'='+sum);
    });

    var timeTotal=ARRIVAL_TIME_COUNTS.reduce(function(sum,row){ return sum+row.count; },0);
    var dayTotal=ARRIVAL_DAY_COUNTS.reduce(function(sum,count){ return sum+count; },0);
    if(timeTotal!==ANNUAL_ED_VISIT_COUNT) errors.push('시간대별 내원 합계 불일치: '+timeTotal);
    if(dayTotal!==ANNUAL_ED_VISIT_COUNT) errors.push('요일별 내원 합계 불일치: '+dayTotal);

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

  if(!validatePatientProbabilities()) throw new Error('환자 발생 확률표 검증에 실패했습니다.');

  function samplePatientProfile(){
    var totalJointCount=0;
    for(var i=0;i<AGE_KTAS_JOINT_COUNTS.length;i++) totalJointCount+=AGE_KTAS_JOINT_COUNTS[i].count;
    var jointTarget=spawnRandom()*totalJointCount;
    var jointRow=AGE_KTAS_JOINT_COUNTS[AGE_KTAS_JOINT_COUNTS.length-1];
    for(var j=0;j<AGE_KTAS_JOINT_COUNTS.length;j++){
      jointTarget-=AGE_KTAS_JOINT_COUNTS[j].count;
      if(jointTarget<=0){ jointRow=AGE_KTAS_JOINT_COUNTS[j]; break; }
    }

    var severityGroup=jointRow.ktasLevel<=2 ? 'critical' :
      (jointRow.ktasLevel===3 ? 'urgent' : 'less_urgent');
    var caseCounts=CASE_TYPE_COUNTS_BY_AGE[jointRow.ageGroup];
    var caseType=spawnRandom()*(caseCounts.disease+caseCounts.injury)<caseCounts.disease ?
      'disease' : 'injury';

    // 같은 난수 한 번으로 결합상태를 뽑아 needsICU/needsSurgery의 상관관계를 보존한다.
    var resourceProb=RESOURCE_NEED_PROBABILITIES_BY_KTAS[severityGroup];
    var resourceDraw=spawnRandom();
    var needsICU=false, needsSurgery=false;
    if(resourceDraw<resourceProb.both){
      needsICU=true; needsSurgery=true;
    } else if(resourceDraw<resourceProb.both+resourceProb.icuOnly){
      needsICU=true;
    } else if(resourceDraw<resourceProb.both+resourceProb.icuOnly+resourceProb.surgeryOnly){
      needsSurgery=true;
    }

    var isPediatric=jointRow.ageGroup==='infant' || jointRow.ageGroup==='pediatric';
    // 2026-09-28, 8차: 이전에는 아래 매핑이 소아/외상/일반 세 갈래뿐이라 requiredSpecialty가
    // '심장'으로 절대 나오지 않았다(SPECIALTIES는 4개인데 3개만 실제로 쓰임 — 병원 쪽
    // 심장 ICU 버킷이 전혀 소모되지 않는 죽은 자원이었음, 2026-09-21 TODO). 이번에
    // 질병군(소아·손상이 아닌 나머지) 환자를 DISEASE_SPECIALTY_WEIGHTS(파일 상단, 병상
    // 규모비례 가정)에 따라 내과/일반/심장 세 갈래로 나누도록 고쳤다 — 실제 상병 분포
    // 데이터가 없어 택한 가정이며, 실측 데이터가 확보되면 이 가중치 계산부만 교체하면 됨.
    var requiredSpecialty;
    if(isPediatric){
      requiredSpecialty='소아';
    } else if(caseType==='injury'){
      requiredSpecialty='외상';
    } else {
      var diseaseDraw=spawnRandom();
      if(diseaseDraw<DISEASE_SPECIALTY_WEIGHTS.내과) requiredSpecialty='내과';
      else if(diseaseDraw<DISEASE_SPECIALTY_WEIGHTS.내과+DISEASE_SPECIALTY_WEIGHTS.심장) requiredSpecialty='심장';
      else requiredSpecialty='일반';
    }
    var requiredCareType=isPediatric ?
      (severityGroup==='critical' ? 'pediatric_critical' : 'pediatric_general') :
      (caseType==='injury' ? (severityGroup==='critical' ? 'trauma_critical' : 'trauma_general') :
        (requiredSpecialty==='심장' ? (severityGroup==='critical' ? 'cardiac_critical' : 'cardiac_general') :
          (severityGroup==='critical' ? 'general_critical' : 'general')));

    return {
      patientType:jointRow.ageGroup+'_ktas_'+jointRow.ktasLevel,
      ageGroup:jointRow.ageGroup,
      ktasLevel:jointRow.ktasLevel,
      severityGroup:severityGroup,
      caseType:caseType,
      requiredCareType:requiredCareType,
      requiredSpecialty:requiredSpecialty,
      needsICU:needsICU,
      needsSurgery:needsSurgery
    };
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

  function getNextArrivalIntervalSec(simTime){
    var absoluteSimSec=SIMULATION_START_HOUR*3600+Math.max(0,simTime||0);
    var secOfDay=((absoluteSimSec%86400)+86400)%86400;
    var hour=secOfDay/3600;
    var timeRow=ARRIVAL_TIME_COUNTS[ARRIVAL_TIME_COUNTS.length-1];
    for(var i=0;i<ARRIVAL_TIME_COUNTS.length;i++){
      if(hour>=ARRIVAL_TIME_COUNTS[i].startHour && hour<ARRIVAL_TIME_COUNTS[i].endHour){
        timeRow=ARRIVAL_TIME_COUNTS[i]; break;
      }
    }
    var elapsedDay=Math.floor(absoluteSimSec/86400);
    var dayIdx=(SIMULATION_START_DAY_OF_WEEK+elapsedDay)%7;
    var dayMultiplier=(ARRIVAL_DAY_COUNTS[dayIdx]/ANNUAL_ED_VISIT_COUNT)*7;
    var bandShare=timeRow.count/ANNUAL_ED_VISIT_COUNT;
    var bandHours=timeRow.endHour-timeRow.startHour;
    var arrivalsPerHour=(ANNUAL_ED_VISIT_COUNT/ANNUAL_DAY_COUNT)*dayMultiplier*bandShare/bandHours;
    var ratePerSec=arrivalsPerHour/3600*PATIENT_DEMAND_MULTIPLIER;
    if(!(ratePerSec>0)) throw new Error('환자 도착률은 0보다 커야 합니다.');
    return Math.max(1,-Math.log(Math.max(Number.EPSILON,1-spawnRandom()))/ratePerSec);
  }

  function spawnPatient(){
    var profile = samplePatientProfile();
    var location = samplePatientLocation(simTime);

    var marker = L.circleMarker([location.lat, location.lng], {
      radius:5, color:COLOR_WAITING, fillColor:COLOR_WAITING, fillOpacity:0.9, weight:1
    }).addTo(map);
    marker.bindPopup(
      '환자유형: '+profile.patientType+'<br>KTAS '+profile.ktasLevel+
      ' · '+(profile.caseType==='disease'?'질병':'손상')+
      '<br>필요 진료과: '+profile.requiredSpecialty+
      '<br>ICU '+(profile.needsICU?'필요':'불필요')+' · 수술 '+(profile.needsSurgery?'필요':'불필요')+
      '<br>상태: 대기 중'
    );

    var patient = {
      id: ++patientIdCounter,

      patientType: profile.patientType,
      ageGroup: profile.ageGroup,
      ktasLevel: profile.ktasLevel,
      severityGroup: profile.severityGroup,
      caseType: profile.caseType,
      requiredCareType: profile.requiredCareType,
      requiredSpecialty: profile.requiredSpecialty,
      needsICU: profile.needsICU,
      needsSurgery: profile.needsSurgery,

      lat: location.lat, lng: location.lng,
      densityCellId: location.densityCellId, routeOriginIdx: location.routeOriginIdx,

      status: PATIENT_STATUS.WAITING, waitElapsed: 0, hospitalIdx: null,
      marker: marker, routeLine: null
    };
    patients.push(patient);
    spawnCount++;
    logEvent(
      '환자 #'+patient.id+' 발생 (KTAS '+patient.ktasLevel+' · '+patient.requiredSpecialty+
      (patient.needsICU?' · ICU':'')+(patient.needsSurgery?' · 수술':'')+')'
    );
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
              logEvent('환자 #'+p.id+' → '+hos.name+' 문의 → 거절 ('+hospitalRejectionReason(p, hos)+')');
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
          p.treatRemaining = rand(TREAT_MIN_SEC, TREAT_MAX_SEC);
          if(p.routeLine){ map.removeLayer(p.routeLine); p.routeLine = null; }
          map.removeLayer(p.marker);
          p.marker = null;
        }
      } else if(p.status === PATIENT_STATUS.TREATING){
        p.treatRemaining -= simDt;
        if(p.treatRemaining <= 0){
          var dischargeHos = hospitals[p.hospitalIdx];
          dischargeHos.occupied--;
          if(p.needsICU){ dischargeHos.occupiedICU[p.requiredSpecialty]--; }
          if(p.needsSurgery){ dischargeHos.occupiedOR--; }
          updateHospitalVisual(p.hospitalIdx);
          treatedCount++;
          logEvent('환자 #'+p.id+' 치료 완료 · '+dischargeHos.name+' 병상 반납');
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
    var waitingCount = 0, contactingCount = 0, transitCount = 0;
    for(var i=0;i<patients.length;i++){
      if(patients[i].status===PATIENT_STATUS.WAITING) waitingCount++;
      if(patients[i].status===PATIENT_STATUS.CONTACTING) contactingCount++;
      if(patients[i].status===PATIENT_STATUS.TRANSIT) transitCount++;
    }
    document.getElementById('liveReadout').textContent = '대기 '+waitingCount+' · 문의중 '+contactingCount+' · 이송중 '+transitCount;
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
      hos.occupiedICU = {외상:0, 심장:0, 소아:0, 일반:0, 내과:0};
      hos.occupiedOR = 0;
      updateHospitalVisual(idx);
    });
    spawnCount=0; treatedCount=0; failCount=0;
    totalTransitDurationSec=0; transitCountForAvg=0;
    totalContactAttempts=0; totalSearchDurationSec=0; searchCountForAvg=0;
    // 2026-09-28, 9차 — 초기화할 때마다 시드 입력칸의 값으로 다시 시드를 건다. 시드값을
    // 그대로 두고 모드만 바꿔 초기화하면(아래 modeSel 변경 핸들러), 두 모드에 동일한
    // 환자 발생열이 재생된다.
    applySeed(readSeedFromInput());
    simTime=0; spawnTimer = getNextArrivalIntervalSec(simTime);
    eventLogEl.innerHTML = '';
    updateStatsDisplay();
  }

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

  updateStatsDisplay();
})();
