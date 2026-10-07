"""
4단계: 3단계에서 받아온 경로 결과를 데이터 파일로 굳히기

입력: data/route_results.json  (3_fetch_routes.js 실행 결과를 저장한 파일 — 현재는 카카오모빌리티
      길찾기 API 결과. OSRM 버전은 data/route_results_osrm.json에 비교용으로 남겨둠)
출력: data/route_cache.data.js (index.html이 <script>로 바로 로드하는 형태)
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, '..', 'data')

with open(os.path.join(DATA_DIR, 'route_results.json'), encoding='utf-8') as f:
    routes = json.load(f)

errs = [r for r in routes if r.get('error')]
print(f'routes: {len(routes)}, errors: {len(errs)}')

with open(os.path.join(DATA_DIR, 'route_cache.data.js'), 'w', encoding='utf-8') as f:
    f.write("// origin x hospital 조합의 실도로+실시간교통 경로 사전 계산 캐시.\n")
    f.write("// o=origin 인덱스(ROUTE_ORIGINS), h=hospital 인덱스(HOSPITALS_DATA),\n")
    f.write("// d=소요시간(초, 실시간 교통 반영), m=거리(m), c=경로 좌표열(Douglas-Peucker로 단순화, [lat,lng] 배열).\n")
    f.write("// 카카오모빌리티 길찾기(Directions) API(priority=RECOMMEND)에서 1회 호출해 생성 (실시간 교통 반영).\n")
    f.write("// 생성 스크립트: scripts/3_fetch_routes.js (브라우저에서 실행) -> scripts/4_build_route_cache.py\n")
    f.write("// OSRM(교통 미반영) 버전은 scripts/3_fetch_routes_osrm.js / 4_build_route_cache_osrm.py 로 비교 재현 가능.\n")
    f.write("window.ROUTE_CACHE_RAW = " + json.dumps(routes, ensure_ascii=False) + ";\n")

print(f'-> data/route_cache.data.js')
