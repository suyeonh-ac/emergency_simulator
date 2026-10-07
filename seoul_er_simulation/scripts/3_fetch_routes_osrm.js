// [레거시/비교용] 격자 지점 -> 후보 병원 128개 구간의 경로를 OSRM 공개 라우팅 서버에서 1회 조회.
// 이 프로젝트의 기본 경로 데이터는 scripts/3_fetch_routes.js(카카오모빌리티, 실시간 교통 반영)로
// 교체되었음. OSRM은 도로망 기준 정적 소요시간만 계산해 실제보다 훨씬 빨리 나온다(교통 미반영).
// data/route_results_osrm.json / data/route_cache_osrm.data.js 와 짝을 이루는 비교용 스크립트.
//
// 실행 방법: 인터넷 접속이 되는 아무 페이지에서나(또는 ../index.html에서) 개발자도구 콘솔을
// 열고 이 파일 전체를 붙여넣어 실행한다. 완료되면 window.__ROUTE_RESULTS__ 에 결과가 담기고,
// 콘솔에서 JSON.stringify(window.__ROUTE_RESULTS__) 로 꺼내 data/route_results.json으로 저장한 뒤
// scripts/4_build_route_cache.py 로 data/route_cache.data.js를 생성한다.
//
// 아래 PLAN은 2_generate_route_plan.py가 실제로 생성했던 route_plan.json 내용을 그대로 붙여넣은 것.
// 격자를 바꿔서 다시 만들었다면 새로 생성된 data/route_plan.json 내용으로 교체할 것.
(async function(){
  const PLAN = {"origins": [{"lat": 37.46478, "lng": 126.82645, "candidates": [32, 41, 1, 50, 36, 35, 53, 49]}, {"lat": 37.46478, "lng": 126.92663, "candidates": [22, 53, 50, 60, 16, 35, 51, 30]}, {"lat": 37.46478, "lng": 127.02681, "candidates": [33, 52, 64, 20, 57, 28, 58, 70]}, {"lat": 37.46478, "lng": 127.12699, "candidates": [31, 14, 56, 26, 29, 20, 58, 17]}, {"lat": 37.52301, "lng": 126.82645, "candidates": [41, 55, 49, 59, 24, 37, 32, 65]}, {"lat": 37.52301, "lng": 126.92663, "candidates": [7, 18, 73, 43, 68, 72, 16, 63]}, {"lat": 37.52301, "lng": 127.02681, "candidates": [70, 19, 28, 58, 20, 52, 6, 10]}, {"lat": 37.52301, "lng": 127.12699, "candidates": [17, 26, 29, 31, 56, 48, 0, 10]}, {"lat": 37.58124, "lng": 126.82645, "candidates": [24, 59, 65, 37, 55, 49, 4, 41]}, {"lat": 37.58124, "lng": 126.92663, "candidates": [44, 21, 71, 42, 63, 66, 39, 9]}, {"lat": 37.58124, "lng": 127.02681, "candidates": [5, 40, 69, 38, 12, 2, 61, 11]}, {"lat": 37.58124, "lng": 127.12699, "candidates": [46, 34, 0, 3, 17, 15, 29, 26]}, {"lat": 37.63947, "lng": 126.82645, "candidates": [8, 45, 66, 65, 24, 71, 37, 59]}, {"lat": 37.63947, "lng": 126.92663, "candidates": [8, 45, 66, 71, 44, 42, 67, 9]}, {"lat": 37.63947, "lng": 127.02681, "candidates": [62, 67, 23, 54, 25, 13, 47, 11]}, {"lat": 37.63947, "lng": 127.12699, "candidates": [3, 47, 46, 13, 25, 34, 15, 11]}], "hospitals": [{"lat": 37.552046, "lng": 127.157085}, {"lat": 37.492111, "lng": 126.884745}, {"lat": 37.579666, "lng": 126.998963}, {"lat": 37.612869, "lng": 127.098091}, {"lat": 37.536543, "lng": 126.886216}, {"lat": 37.587156, "lng": 127.026471}, {"lat": 37.559945, "lng": 127.044883}, {"lat": 37.518272, "lng": 126.936731}, {"lat": 37.633608, "lng": 126.91615}, {"lat": 37.568498, "lng": 126.967938}, {"lat": 37.540845, "lng": 127.072123}, {"lat": 37.593877, "lng": 127.051832}, {"lat": 37.56734, "lng": 127.005795}, {"lat": 37.636443, "lng": 127.070003}, {"lat": 37.488516, "lng": 127.086682}, {"lat": 37.587992, "lng": 127.065329}, {"lat": 37.493718, "lng": 126.924049}, {"lat": 37.535984, "lng": 127.135264}, {"lat": 37.51205, "lng": 126.922367}, {"lat": 37.533842, "lng": 127.004418}, {"lat": 37.492807, "lng": 127.046313}, {"lat": 37.562117, "lng": 126.940828}, {"lat": 37.484275, "lng": 126.932539}, {"lat": 37.646116, "lng": 127.029024}, {"lat": 37.557261, "lng": 126.836266}, {"lat": 37.648581, "lng": 127.063116}, {"lat": 37.526564, "lng": 127.108238}, {"lat": 37.507074, "lng": 126.960794}, {"lat": 37.501801, "lng": 127.004727}, {"lat": 37.528221, "lng": 127.146719}, {"lat": 37.493249, "lng": 126.908673}, {"lat": 37.496413, "lng": 127.123488}, {"lat": 37.499646, "lng": 126.86636}, {"lat": 37.482713, "lng": 127.018063}, {"lat": 37.583621, "lng": 127.086055}, {"lat": 37.490689, "lng": 126.907169}, {"lat": 37.493851, "lng": 126.899254}, {"lat": 37.556941, "lng": 126.85095}, {"lat": 37.584191, "lng": 127.049838}, {"lat": 37.567155, "lng": 126.966999}, {"lat": 37.575399, "lng": 127.031403}, {"lat": 37.512019, "lng": 126.83313}, {"lat": 37.57534, "lng": 126.957707}, {"lat": 37.518848, "lng": 126.90368}, {"lat": 37.581104, "lng": 126.936583}, {"lat": 37.620792, "lng": 126.919554}, {"lat": 37.600676, "lng": 127.109029}, {"lat": 37.628816, "lng": 127.082693}, {"lat": 37.535316, "lng": 127.083601}, {"lat": 37.528441, "lng": 126.863664}, {"lat": 37.455671, "lng": 126.900563}, {"lat": 37.485619, "lng": 126.956782}, {"lat": 37.485612, "lng": 127.039587}, {"lat": 37.481651, "lng": 126.911648}, {"lat": 37.625421, "lng": 127.026185}, {"lat": 37.537358, "lng": 126.836699}, {"lat": 37.502346, "lng": 127.094297}, {"lat": 37.482547, "lng": 126.981481}, {"lat": 37.50099, "lng": 127.050967}, {"lat": 37.552254, "lng": 126.836025}, {"lat": 37.479625, "lng": 126.956286}, {"lat": 37.580452, "lng": 126.997196}, {"lat": 37.640256, "lng": 127.028504}, {"lat": 37.552589, "lng": 126.933735}, {"lat": 37.486229, "lng": 127.004386}, {"lat": 37.561996, "lng": 126.796365}, {"lat": 37.614692, "lng": 126.917472}, {"lat": 37.63547, "lng": 127.022673}, {"lat": 37.526858, "lng": 126.895614}, {"lat": 37.56511, "lng": 127.02802}, {"lat": 37.5068, "lng": 127.034669}, {"lat": 37.60477, "lng": 126.923856}, {"lat": 37.522405, "lng": 126.890914}, {"lat": 37.523467, "lng": 126.91033}]};
  const origins = PLAN.origins;
  const hospitals = PLAN.hospitals;

  function rdp(points, epsilon){
    if(points.length < 3) return points.slice();
    function perpDist(p, a, b){
      const dx=b[0]-a[0], dy=b[1]-a[1];
      const len = Math.hypot(dx,dy) || 1e-12;
      const t = ((p[0]-a[0])*dx + (p[1]-a[1])*dy)/(len*len);
      const px = a[0]+t*dx, py = a[1]+t*dy;
      return Math.hypot(p[0]-px, p[1]-py);
    }
    function rec(pts){
      if(pts.length < 3) return pts;
      let maxD=0, idx=0;
      for(let i=1;i<pts.length-1;i++){
        const d = perpDist(pts[i], pts[0], pts[pts.length-1]);
        if(d>maxD){ maxD=d; idx=i; }
      }
      if(maxD > epsilon){
        const left = rec(pts.slice(0, idx+1));
        const right = rec(pts.slice(idx));
        return left.slice(0,-1).concat(right);
      }
      return [pts[0], pts[pts.length-1]];
    }
    return rec(points);
  }

  function simplifyToMax(points, maxPts){
    let eps = 0.00005;
    let out = rdp(points, eps);
    let guard = 0;
    while(out.length > maxPts && guard < 25){
      eps *= 1.6;
      out = rdp(points, eps);
      guard++;
    }
    return out;
  }

  const queue = [];
  origins.forEach((o, oi) => o.candidates.forEach(hi => queue.push([oi, hi])));

  const results = [];
  let idx = 0;
  async function worker(){
    while(idx < queue.length){
      const my = idx++;
      const [oi, hi] = queue[my];
      const o = origins[oi], h = hospitals[hi];
      const url = 'https://router.project-osrm.org/route/v1/driving/'+o.lng+','+o.lat+';'+h.lng+','+h.lat+'?overview=full&geometries=geojson';
      try{
        const res = await fetch(url);
        const data = await res.json();
        const r = data.routes[0];
        const coords = r.geometry.coordinates.map(c => [c[1], c[0]]);
        const simp = simplifyToMax(coords, 22);
        results.push({o: oi, h: hi, d: Math.round(r.duration), m: Math.round(r.distance),
          c: simp.map(p => [Math.round(p[0]*100000)/100000, Math.round(p[1]*100000)/100000])});
      }catch(e){
        results.push({o: oi, h: hi, error: String(e)});
      }
    }
  }
  await Promise.all(Array.from({length:6}, worker));
  const okCount = results.filter(r=>!r.error).length;
  window.__ROUTE_RESULTS__ = results;
  return {done:true, total: results.length, ok: okCount, failed: results.length-okCount};
})()
