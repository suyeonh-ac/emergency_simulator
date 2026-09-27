"""
2단계: 이동경로 사전계산을 위한 격자 발생지점 + 병원 후보 목록 생성

입력: data/hospitals.json (1_generate_hospitals.py 출력)
출력: data/route_plan.json       (평문 JSON, 3단계 브라우저 스크립트에 붙여넣을 PLAN)
      data/route_origins.data.js (index.html이 <script>로 바로 로드하는 형태)

서울 권역을 GRID x GRID 격자로 나눠 각 셀 중심을 "환자 발생 대표 지점"으로 삼고,
각 지점에서 병원 전체(K=병원 수)를 후보로 남긴다.

[2026-09-17 변경] 원래는 지점당 가장 가까운 8곳만 후보로 좁혔는데, 배정 로직이
"거리만"이 아니라 병상 여유·진료과 일치까지 보기 때문에, 가까운 8곳이 전부 만실이거나
필요 진료과가 없으면(특히 권역응급의료센터는 74곳 중 7곳뿐) 캐시에 없는 조합으로
빠져서 지도에 실도로가 아닌 직선 근사(점선)가 너무 자주 나오는 문제가 있었다.
K를 병원 전체 수로 늘려서 "어떤 지점에서 어떤 병원으로 배정되어도" 반드시 캐시에
실도로 경로가 있도록 했다 (16개 지점 x 74개 병원 = 1,184구간 전부 사전계산).
"""
import json, math, os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, '..', 'data')

with open(os.path.join(DATA_DIR, 'hospitals.json'), encoding='utf-8') as f:
    hospitals = json.load(f)

lats = [h['lat'] for h in hospitals]
lngs = [h['lng'] for h in hospitals]
PAD = 0.02
lat_min, lat_max = min(lats) - PAD, max(lats) + PAD
lng_min, lng_max = min(lngs) - PAD, max(lngs) + PAD

GRID = 4              # 4x4 = 16개 발생 대표 지점
K = len(hospitals)    # 지점당 후보 병원 수 (전체 병원 수 = 완전 커버리지)

origins = []
for i in range(GRID):
    for j in range(GRID):
        lat = lat_min + (lat_max - lat_min) * (i + 0.5) / GRID
        lng = lng_min + (lng_max - lng_min) * (j + 0.5) / GRID
        origins.append({'lat': round(lat, 5), 'lng': round(lng, 5)})

def haversine(lat1, lng1, lat2, lng2):
    R = 6371000
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlng/2)**2
    return 2*R*math.asin(math.sqrt(a))

for o in origins:
    dists = sorted(range(len(hospitals)),
                    key=lambda hi: haversine(o['lat'], o['lng'], hospitals[hi]['lat'], hospitals[hi]['lng']))
    o['candidates'] = dists[:K]

spawn_bounds = {
    'latMin': round(lat_min, 4), 'latMax': round(lat_max, 4),
    'lngMin': round(lng_min, 4), 'lngMax': round(lng_max, 4),
}

plan = {'origins': origins, 'hospitals': [{'lat': h['lat'], 'lng': h['lng']} for h in hospitals]}

with open(os.path.join(DATA_DIR, 'route_plan.json'), 'w', encoding='utf-8') as f:
    json.dump(plan, f, ensure_ascii=False)

with open(os.path.join(DATA_DIR, 'route_origins.data.js'), 'w', encoding='utf-8') as f:
    f.write("// 4x4 격자(16개) 대표 발생 지점과, 각 지점에서 가까운 병원 8곳(candidates)의 인덱스\n")
    f.write("// (HOSPITALS_DATA 배열 순서 기준 인덱스). 생성 스크립트: scripts/2_generate_route_plan.py\n")
    f.write("window.ROUTE_ORIGINS = " + json.dumps(origins, ensure_ascii=False, indent=2) + ";\n")
    f.write("window.SPAWN_BOUNDS = " + json.dumps(spawn_bounds) + ";\n")

total_pairs = sum(len(o['candidates']) for o in origins)
print(f'origins: {len(origins)}, total route pairs to fetch next step: {total_pairs}')
print(f'-> data/route_plan.json (3단계 스크립트에 붙여넣을 PLAN), data/route_origins.data.js')
