"""
1f단계: 응급똑똑 실측 데이터가 있는 51곳으로 시뮬레이션 범위를 좁힌다

배경
----
2026-09-20: 사용자 요청 — "74개 말고 직전에 올려준 엑셀에 있는 51개로 하자".
scripts/1e가 만든 74곳 중, 응급똑똑 앱 실측 데이터(data/bed_detail_raw.json)가 있는
51곳(법정 응급의료기관: 권역응급의료센터 7 + 지역응급의료센터 24 + 지역응급의료기관 20)만
남기고, 세부 데이터가 없던 나머지 23곳(응급실운영신고기관)은 시뮬레이션에서 제외한다.
결과적으로 남는 51곳은 전부 capacity·resources가 응급똑똑 실측이라, "resources 전부 0"
fallback 케이스가 더 이상 없다.

이동 경로 캐시는 다시 받지 않는다
--------------------------------
data/route_results.json은 4x4 격자 16개 지점 x (당시) 병원 74곳 전체 = 1,184구간을
전부 사전계산해둔 것이라, 51곳으로 줄여도 필요한 조합(16 x 51 = 816구간)은 이미 다
들어있다. 그래서 카카오 API를 다시 호출하지 않고, 기존 결과에서 "h"(병원 인덱스) 값이
남기는 51곳에 해당하는 것만 골라 새 인덱스(0~50)로 다시 매긴다.
발생지점(ROUTE_ORIGINS, 4x4 격자 좌표 자체)은 그대로 둔다 — 이미 실도로 경로가 있는
지점들이라 바꾸면 오히려 캐시가 깨진다.

입력: data/hospitals.json, data/route_results.json, data/route_plan.json
출력: data/hospitals.json, data/hospitals.data.js       (51곳으로 필터)
      data/route_results.json, data/route_cache.data.js (필터 + 인덱스 재매핑)
      data/route_plan.json                              ('hospitals' 필드만 필터, 참고용)
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, '..', 'data')

HOSPITALS_JSON = os.path.join(DATA_DIR, 'hospitals.json')
ROUTE_RESULTS_JSON = os.path.join(DATA_DIR, 'route_results.json')
ROUTE_PLAN_JSON = os.path.join(DATA_DIR, 'route_plan.json')

OUT_HOSPITALS_JS = os.path.join(DATA_DIR, 'hospitals.data.js')
OUT_ROUTE_CACHE_JS = os.path.join(DATA_DIR, 'route_cache.data.js')


def main():
    hospitals = json.load(open(HOSPITALS_JSON, encoding='utf-8'))
    total_before = len(hospitals)

    kept = [h for h in hospitals if str(h.get('_bedDetailSource', '')).startswith('manual')]
    dropped = [h for h in hospitals if h not in kept]

    old_index_of = {id(h): i for i, h in enumerate(hospitals)}
    old_to_new = {old_index_of[id(h)]: new_i for new_i, h in enumerate(kept)}

    print(f'{total_before}곳 중 응급똑똑 실측 {len(kept)}곳만 유지, {len(dropped)}곳 제외')
    print('제외된 병원:', ', '.join(h['name'] for h in dropped))

    with open(HOSPITALS_JSON, 'w', encoding='utf-8') as f:
        json.dump(kept, f, ensure_ascii=False, indent=2)

    with open(OUT_HOSPITALS_JS, 'w', encoding='utf-8') as f:
        f.write("// 서울 응급실 51곳 데이터 (응급똑똑 앱 실측 병상 세부데이터가 있는 법정 응급의료기관만)\n")
        f.write("// 위치(lat/lng)·등급(grade)은 실측(data/ems_facilities_all.csv, 공공데이터 기반).\n")
        f.write("// capacity(응급실 병상수)·specialties(진료과)·resources(중환자실/수술실)는\n")
        f.write("// 국립중앙의료원 E-Gen API(scripts/1c) + 응급똑똑 앱 실측(scripts/1e)을 합친 값.\n")
        f.write("// 2026-09-20: 응급똑똑 세부데이터가 없던 23곳(응급실운영신고기관)은 제외하고 51곳만 남김.\n")
        f.write("// 생성: scripts/1_generate_hospitals.py -> 1c_apply_egen_data.py -> 1e_apply_manual_bed_detail.py -> 1f_filter_manual_hospitals.py\n")
        f.write("window.HOSPITALS_DATA = " + json.dumps(kept, ensure_ascii=False, indent=2) + ";\n")

    print(f'{HOSPITALS_JSON}, {OUT_HOSPITALS_JS} 갱신 완료')

    # --- 이동 경로 캐시 필터 + 인덱스 재매핑 ---
    routes = json.load(open(ROUTE_RESULTS_JSON, encoding='utf-8'))
    new_routes = []
    for r in routes:
        if r.get('error'):
            continue
        if r['h'] not in old_to_new:
            continue
        r2 = dict(r)
        r2['h'] = old_to_new[r['h']]
        new_routes.append(r2)

    with open(ROUTE_RESULTS_JSON, 'w', encoding='utf-8') as f:
        json.dump(new_routes, f, ensure_ascii=False)

    with open(OUT_ROUTE_CACHE_JS, 'w', encoding='utf-8') as f:
        f.write("// origin x hospital 조합의 실도로+실시간교통 경로 사전 계산 캐시.\n")
        f.write("// o=origin 인덱스(ROUTE_ORIGINS), h=hospital 인덱스(HOSPITALS_DATA, 2026-09-20부터 51곳 기준),\n")
        f.write("// d=소요시간(초, 실시간 교통 반영), m=거리(m), c=경로 좌표열(Douglas-Peucker로 단순화, [lat,lng] 배열).\n")
        f.write("// 카카오모빌리티 길찾기(Directions) API(priority=RECOMMEND)에서 74곳 기준으로 1회 호출해 생성한 뒤,\n")
        f.write("// scripts/1f_filter_manual_hospitals.py가 51곳만 남기고 인덱스를 재매핑함(API 재호출 없음).\n")
        f.write("window.ROUTE_CACHE_RAW = " + json.dumps(new_routes, ensure_ascii=False) + ";\n")

    print(f'경로 캐시: {len(routes)}개 -> {len(new_routes)}개 (51곳 x 16지점 = {51*16}개 기대)')
    print(f'{ROUTE_RESULTS_JSON}, {OUT_ROUTE_CACHE_JS} 갱신 완료')

    # --- route_plan.json: 'hospitals' 필드 필터 + 각 origin의 'candidates'를 새 인덱스로 재계산 ---
    # (origins 자체의 lat/lng는 손대지 않는다 — 캐시가 이미 그 좌표 기준으로 실도로 경로를
    #  갖고 있으므로 좌표를 바꾸면 캐시가 깨진다. candidates는 참고용 문서 필드라 실제
    #  sim.js 런타임에서는 쓰이지 않지만, 74곳 기준 인덱스가 그대로 남아 있으면 51곳
    #  기준인 hospitals.json 인덱스와 안 맞아 헷갈리므로 51곳 기준으로 다시 계산해둔다.)
    import math

    def haversine(lat1, lng1, lat2, lng2):
        R = 6371000
        dlat = math.radians(lat2 - lat1)
        dlng = math.radians(lng2 - lng1)
        a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng / 2) ** 2
        return 2 * R * math.asin(math.sqrt(a))

    plan = json.load(open(ROUTE_PLAN_JSON, encoding='utf-8'))
    plan['hospitals'] = [{'lat': h['lat'], 'lng': h['lng']} for h in kept]
    for o in plan['origins']:
        dists = sorted(range(len(kept)), key=lambda hi: haversine(o['lat'], o['lng'], kept[hi]['lat'], kept[hi]['lng']))
        o['candidates'] = dists  # K = 병원 전체(51) = 이미 다 캐시되어 있으므로 전체를 후보로 유지
    with open(ROUTE_PLAN_JSON, 'w', encoding='utf-8') as f:
        json.dump(plan, f, ensure_ascii=False)
    print(f'{ROUTE_PLAN_JSON} hospitals 필드 필터 + candidates 51곳 기준 재계산 완료 (origins 좌표는 캐시 보존을 위해 그대로 둠)')


if __name__ == '__main__':
    main()
