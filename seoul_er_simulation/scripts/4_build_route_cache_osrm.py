"""
[레거시/비교용] OSRM 경로 결과를 데이터 파일로 굳히기 (교통 미반영, 참고/비교용)

입력: data/route_results_osrm.json  (scripts/3_fetch_routes_osrm.js 실행 결과)
출력: data/route_cache_osrm.data.js  (index.html은 이 파일을 로드하지 않음 - 비교 분석용)

이 프로젝트가 실제로 쓰는 기본 경로 캐시는 scripts/4_build_route_cache.py(카카오모빌리티,
실시간 교통 반영) -> data/route_cache.data.js 쪽입니다.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, '..', 'data')

with open(os.path.join(DATA_DIR, 'route_results_osrm.json'), encoding='utf-8') as f:
    routes = json.load(f)

errs = [r for r in routes if r.get('error')]
print(f'routes: {len(routes)}, errors: {len(errs)}')

with open(os.path.join(DATA_DIR, 'route_cache_osrm.data.js'), 'w', encoding='utf-8') as f:
    f.write("// origin x hospital 조합의 실제 도로 경로 사전 계산 캐시.\n")
    f.write("// o=origin 인덱스(ROUTE_ORIGINS), h=hospital 인덱스(HOSPITALS_DATA),\n")
    f.write("// d=소요시간(초), m=거리(m), c=경로 좌표열(Douglas-Peucker로 단순화, [lat,lng] 배열).\n")
    f.write("// OSRM(router.project-osrm.org) 공개 라우팅 서버에서 1회 호출해 생성.\n")
    f.write("// 생성 스크립트: scripts/3_fetch_routes.js (브라우저에서 실행) -> scripts/4_build_route_cache.py\n")
    f.write("window.ROUTE_CACHE_RAW = " + json.dumps(routes, ensure_ascii=False) + ";\n")

print(f'-> data/route_cache_osrm.data.js')
