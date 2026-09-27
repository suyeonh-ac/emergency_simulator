"""
1단계: 서울 응급의료기관 74곳 + 합성 병상수/진료과 데이터 생성

입력: data/ems_facilities_all.csv (전국 응급의료기관, 공공데이터 기반 원본)
출력: data/hospitals.json         (평문 JSON, 다음 단계 스크립트가 읽음)
      data/hospitals.data.js      (index.html이 <script>로 바로 로드하는 형태)

capacity(병상수)·specialties(진료과)는 실측 데이터가 없어서, 병원 등급별 규칙 +
random.seed(42)로 생성한 합성 데이터입니다 (재현 가능하도록 시드 고정).
실제 병상수 데이터(예: 응급의료포털 E-Gen 실시간 병상정보 API)를 구하면
이 스크립트의 GRADE_CFG 대신 실측치로 교체하는 것을 권장합니다.
"""
import csv, random, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, '..', 'data')

SRC_CSV = os.path.join(DATA_DIR, 'ems_facilities_all.csv')
OUT_JSON = os.path.join(DATA_DIR, 'hospitals.json')
OUT_JS = os.path.join(DATA_DIR, 'hospitals.data.js')

with open(SRC_CSV, encoding='utf-8-sig') as f:
    reader = csv.DictReader(f)
    rows = [r for r in reader if r['sido_name'].strip() == '서울특별시']

level_order = {'권역응급의료센터': 0, '지역응급의료센터': 1, '지역응급의료기관': 2, '응급실운영신고기관': 3}
rows.sort(key=lambda r: (level_order.get(r['level_name_kr'].strip(), 9), r['facility_name']))

# 등급별 병상수 범위 / 진료과 구성 (가정치 — 법정 인력기준상 등급별 규모 차이를 반영)
GRADE_CFG = {
    '권역응급의료센터':   {'cap': (8, 14), 'specs': ['외상', '심장', '소아', '일반']},
    '지역응급의료센터':   {'cap': (5, 9),  'specs': ['외상', '심장', '일반']},
    '지역응급의료기관':   {'cap': (3, 6),  'specs': ['일반', '외상']},
    '응급실운영신고기관': {'cap': (2, 4),  'specs': ['일반']},
}

random.seed(42)  # 재현성 고정

def short_name(name):
    n = name
    for pfx in ['(의)', '(재)', '(학)', '학교법인', '재단법인', '의료법인']:
        n = n.replace(pfx, '')
    return n[:10]

data = []
for r in rows:
    grade = r['level_name_kr'].strip()
    cfg = GRADE_CFG.get(grade, GRADE_CFG['응급실운영신고기관'])
    lo, hi = cfg['cap']
    capacity = random.randint(lo, hi)
    data.append({
        'hpid': r['hpid'],
        'name': r['facility_name'],
        'shortName': short_name(r['facility_name']),
        'lat': round(float(r['latitude']), 6),
        'lng': round(float(r['longitude']), 6),
        'grade': grade,
        'capacity': capacity,
        'specialties': cfg['specs'],
    })

with open(OUT_JSON, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

with open(OUT_JS, 'w', encoding='utf-8') as f:
    f.write("// 서울시 응급의료기관 74곳 기본 데이터\n")
    f.write("// 위치(lat/lng)·등급(grade)은 실측(data/ems_facilities_all.csv, 공공데이터 기반).\n")
    f.write("// capacity(병상수)·specialties(진료과)는 등급별 규칙 + random.seed(42)로 생성한 합성 데이터입니다.\n")
    f.write("// 생성 스크립트: scripts/1_generate_hospitals.py\n")
    f.write("window.HOSPITALS_DATA = " + json.dumps(data, ensure_ascii=False, indent=2) + ";\n")

print(f'{len(data)}개 병원 → {OUT_JSON}, {OUT_JS}')
