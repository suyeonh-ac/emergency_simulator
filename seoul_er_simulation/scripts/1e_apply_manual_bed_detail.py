"""
1e단계: 응급똑똑 실측 데이터(data/bed_detail_raw.json)를 hospitals.json에 반영
        + 시뮬레이션이 쓸 중환자실(ICU)/수술실 자원(resources)을 새로 추가

배경
----
2026-09-19: 사용자가 응급똑똑 앱에서 서울 법정 응급의료기관 51곳(권역응급의료센터 7 +
지역응급의료센터 24 + 지역응급의료기관 20)의 응급실/중환자실/감염병상/응급전용병상/
외상전용병상/입원실/기타병상/보유장비 "전체(최대 수용치)"를 직접 확인해 정리한 엑셀을
제공. 이를 반영해 (1) capacity를 더 정확한 실측치로 교체하고, (2) 시뮬레이션에
중환자실·수술실을 새로운 배정 제약 자원으로 추가한다(교수님 피드백 "시뮬레이션을 더
현실성 있게"에 대응 — 환자가 중증/수술이 필요하면 응급실 병상뿐 아니라 해당 병원의
ICU/수술실 여유도 있어야 배정 성공).

capacity 갱신
-------------
51곳: 응급실병상(최대) 그룹의 8개 세부항목(일반/소아/외상소생실/일반격리/음압격리/
      소아일반격리/소아음압격리/코호트격리) 합계로 교체. scripts/1c가 만든 hperyn
      기반 값보다 우선한다(더 세부적이고 최근 실측).
나머지 23곳(응급실운영신고기관): 응급똑똑에 세부 병상 정보가 없는 소규모 병원이 많아
      이번 수집 대상에서 제외됨. scripts/1c의 hperyn/fallback 값을 그대로 유지.

resources(신규) — 중환자실/수술실을 시뮬레이션 배정 자원으로
--------------------------------------------------------------
sim.js의 SPECIALTIES(외상/심장/소아/일반) 체계에 맞춰 중환자실 세부 항목을 다음과
같이 묶었다(공식 분류가 아니라 이번 시뮬레이션을 위한 모델링 가정 — 팀에서 가중치를
조정하고 싶으면 아래 ICU_BUCKET_FORMULA만 고치면 됨):
  icu.외상 = 중환자실.외과 + 중환자실.신경외과 + 중환자실.화상 + 외상전용병상.중환자실
  icu.심장 = 중환자실.심장내과 + 중환자실.흉부외과
  icu.소아 = 중환자실.소아 + 중환자실.신생아 + 응급전용병상.소아중환자실
  icu.일반 = 중환자실.일반 + 중환자실.내과 + 중환자실.신경과 + 중환자실.음압격리
  surgery  = 기타병상.수술실 + 외상전용병상.수술실   (진료과 구분 없이 병원 전체 풀로 취급)
(2026-09-21 수정: 중환자실병상(최대) 그룹에 있던 화상/신생아/음압격리 3개 세부항목이
그동안 어느 버킷에도 안 들어가고 조용히 누락되어 있었음 — 엑셀에 있는 값인데 계산에서
빠진 것. 화상은 외상(외과 계열) 버킷에, 신생아는 소아 버킷에 합쳤고(이미 응급전용병상.
소아중환자실을 소아에 합치던 것과 같은 원칙), 특정 진료과에 매이지 않는 음압격리는
일반 버킷(원래도 내과/신경과처럼 비특이적 항목을 모으던 곳)에 합쳤다. 이제 중환자실병상
(최대) 그룹의 11개 세부항목 전부가 resources.icu 어딘가에 반영된다.)
51곳 밖의 23곳은 resources 전부 0 — 응급똑똑에 세부 데이터가 없어 "이 병원엔 ICU/
수술실이 없다"는 뜻이 아니라 "이번에 확인하지 못했다"는 뜻이며, README에 명시한다.

specialties 안전망
-------------------
기존 specialties(scripts/1c, dgidIdName 기반)를 그대로 두되, 혹시 위 icu 버킷이
0보다 큰데 해당 카테고리가 specialties에 빠져 있으면 추가한다(장비/진료과목 텍스트
누락 보정용 안전장치 — 실제로는 거의 발생하지 않을 것으로 예상).

입력: data/hospitals.json (scripts/1c 실행 후 상태), data/bed_detail_raw.json
출력: data/hospitals.json, data/hospitals.data.js (capacity/specialties/resources 갱신)
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, '..', 'data')

HOSPITALS_JSON = os.path.join(DATA_DIR, 'hospitals.json')
BED_DETAIL_JSON = os.path.join(DATA_DIR, 'bed_detail_raw.json')
OUT_JS = os.path.join(DATA_DIR, 'hospitals.data.js')

SPEC_ORDER = ['일반', '외상', '심장', '소아']


def n(v):
    """None -> 0"""
    return v if isinstance(v, (int, float)) else 0


def er_total(groups):
    er = groups.get('응급실병상(최대)', {})
    return sum(n(v) for v in er.values())


def icu_buckets(groups):
    icu = groups.get('중환자실병상(최대)', {})
    emg = groups.get('응급전용병상(최대)', {})
    trauma_only = groups.get('외상전용병상(최대)', {})
    return {
        '외상': n(icu.get('외과')) + n(icu.get('신경외과')) + n(icu.get('화상')) + n(trauma_only.get('중환자실')),
        '심장': n(icu.get('심장내과')) + n(icu.get('흉부외과')),
        '소아': n(icu.get('소아')) + n(icu.get('신생아')) + n(emg.get('소아중환자실')),
        '일반': n(icu.get('일반')) + n(icu.get('내과')) + n(icu.get('신경과')) + n(icu.get('음압격리')),
    }


def surgery_total(groups):
    etc = groups.get('기타병상(최대)', {})
    trauma_only = groups.get('외상전용병상(최대)', {})
    return n(etc.get('수술실')) + n(trauma_only.get('수술실'))


def main():
    hospitals = json.load(open(HOSPITALS_JSON, encoding='utf-8'))
    bed_detail = json.load(open(BED_DETAIL_JSON, encoding='utf-8'))

    updated_capacity = 0
    added_specialty = []

    for h in hospitals:
        bd = bed_detail.get(h['hpid'])
        if bd is None:
            # 응급똑똑 세부 데이터 없음 (주로 응급실운영신고기관) — 기존 capacity 유지, resources는 0
            h['resources'] = {'icu': {k: 0 for k in SPEC_ORDER}, 'surgery': 0}
            h['_bedDetailSource'] = 'no_manual_data(응급실운영신고기관 등, 응급똑똑 세부데이터 없음)'
            continue

        groups = bd['groups']
        new_capacity = er_total(groups)
        if new_capacity > 0:
            if h['capacity'] != new_capacity:
                updated_capacity += 1
            h['capacity'] = new_capacity
        h['resources'] = {'icu': icu_buckets(groups), 'surgery': surgery_total(groups)}
        h['_bedDetailSource'] = 'manual(응급똑똑 실측, 2026-09)'

        for spec, val in h['resources']['icu'].items():
            if val > 0 and spec not in h['specialties']:
                h['specialties'].append(spec)
                added_specialty.append((h['hpid'], h['name'], spec))

    print(f'{updated_capacity}개 병원 capacity를 응급똑똑 실측 ER 총합으로 교체')
    if added_specialty:
        print(f'ICU 자료 기반으로 specialties 보정된 병원 {len(added_specialty)}곳:')
        for hpid, name, spec in added_specialty:
            print(f'   - {hpid} {name}: +{spec}')

    with open(HOSPITALS_JSON, 'w', encoding='utf-8') as f:
        json.dump(hospitals, f, ensure_ascii=False, indent=2)

    with open(OUT_JS, 'w', encoding='utf-8') as f:
        f.write("// 서울시 응급의료기관 74곳 기본 데이터\n")
        f.write("// 위치(lat/lng)·등급(grade)은 실측(data/ems_facilities_all.csv, 공공데이터 기반).\n")
        f.write("// capacity(응급실 병상수)·specialties(진료과)·resources(중환자실/수술실)는\n")
        f.write("// 국립중앙의료원 E-Gen API(scripts/1c) + 응급똑똑 앱 실측(scripts/1e, 51/74곳)을 합친 값.\n")
        f.write("// 생성: scripts/1_generate_hospitals.py -> 1c_apply_egen_data.py -> 1e_apply_manual_bed_detail.py\n")
        f.write("window.HOSPITALS_DATA = " + json.dumps(hospitals, ensure_ascii=False, indent=2) + ";\n")

    print(f'{HOSPITALS_JSON}, {OUT_JS} 갱신 완료')


if __name__ == '__main__':
    main()
