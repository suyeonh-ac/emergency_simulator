"""
1c단계: E-Gen(응급의료정보 Open API) 실측 데이터로 병상수·진료과 교체

배경
----
기존 1_generate_hospitals.py는 병상수(capacity)·진료과(specialties)를
"병원 등급별 규칙 + random.seed(42)"로 임의 생성했다 (완전 합성 데이터).

2026-09-17 피드백: "시뮬레이션이니까 현재 가용병상수 보다는 최대 병상수가
중요하지. 어차피 가상으로 환자 생성해서 배정하는걸 볼거니까. 또 중요한 건
응급실 별로 진료과목을 확정짓는거야."
→ (1) 현재-가용(hvec 등) 대신 최대/기준 병상수를 쓸 것
   (2) 진료과목을 장비 Y/N 플래그로 추론하지 말고 확정된 실측 자료로 정할 것

이 두 가지를 국립중앙의료원 응급의료정보 Open API 공식 가이드
(NIA-IFT-OpenAPI활용가이드-01, 사용자가 업로드한 HWP 문서, v6.0 2026.08.27)에서
찾아 반영한다.

입력
----
data/hospitals.json   : 1_generate_hospitals.py가 만든 74개 병원 (hpid/name/lat/lng/grade
                         + 지금까지는 합성 capacity/specialties)
data/egen_raw.json     : getEgytBassInfoInqire(응급의료기관 기본정보 조회) 오퍼레이션으로
                         74개 병원 전체를 조회한 원본 응답 (브라우저에서 직접 fetch,
                         scripts/1b_fetch_egen_capacity.js 참고 — 서비스 키가 필요해
                         재현 시 사용자가 직접 실행해야 함)

가이드에서 확인한 필드 의미 (모두 "실시간 가용병상"이 아니라 "기준/허가 병상수")
-------------------------------------------------------------------
  dutyHano : 병원 전체 병상수 (총계)
  hpbdn    : 병상수 (또 다른 총계 집계, 병원 자체 보고치)
  hperyn   : [응급실] 기준 병상수  ← 이번에 쓰는 핵심 필드 (응급실 최대 수용력)
  hpgryn   : [입원실] 기준 병상수
  hpicuyn  : [일반중환자실] 기준 병상수
  hpccuyn  : [흉부중환자실] 기준 병상수
  hpcuyn   : [신경중환자실] 기준 병상수
  hpnicuyn : [신생아중환자실] 기준 병상수
  hpopyn   : [수술실] 기준 병상수
  dgidIdName : 해당 병원이 실제로 운영 중인 진료과목 목록(전체 텍스트, 쉼표구분).
               ★ 가이드 부록의 진료과목 코드표(D001~D034, 예: D024=응급의학과)는
               이 필드가 코드가 아니라 과목명 원문을 그대로 준다는 것을 보여주는
               참고용이며, 실제 매칭은 이 텍스트 목록으로 확정한다.

capacity(병상수) 매핑
----------------------
hperyn(응급실 기준 병상수)을 그대로 사용한다. 74곳 중 58곳은 값이 있었고,
16곳은 API가 아직 이 필드를 보고하지 않아(null 또는 0) 값이 없었다.
→ 없는 경우에는 "hperyn/dutyHano" 비율의 표본 중앙값(약 4.3%, 58개 샘플 기준)을
  해당 병원의 dutyHano(병원 전체 병상수, 항상 보고됨)에 곱해서 추정하고
  최소 2병상으로 하한을 둔다. 이 fallback을 쓴 병원은 콘솔에 출력해 투명하게 표시한다.

specialties(진료과) 매핑
--------------------------
시뮬레이션은 여전히 4개 카테고리(외상/심장/소아/일반)만 쓰므로, 실제 진료과목
텍스트(dgidIdName)에 특정 과가 포함돼 있는지로 판정한다:
  일반 : 항상 포함 (모든 응급실운영기관의 기본 수용 능력으로 간주)
  외상 : "외과" 또는 "신경외과" 또는 "정형외과" 포함 시
  심장 : "흉부외과" 포함(흉부외과/심장혈관흉부외과 등 커버) 또는 "심장" 포함 시
  소아 : "소아청소년과" 포함 시
이전의 "장비 Y/N 플래그로 추론" 방식은 폐기한다.

출력
----
data/hospitals.json, data/hospitals.data.js  (capacity/specialties만 교체, 나머지는 그대로)
"""
import json
import os
import statistics

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, '..', 'data')

HOSPITALS_JSON = os.path.join(DATA_DIR, 'hospitals.json')
EGEN_RAW_JSON = os.path.join(DATA_DIR, 'egen_raw.json')
OUT_JSON = HOSPITALS_JSON
OUT_JS = os.path.join(DATA_DIR, 'hospitals.data.js')


def to_int(v):
    if v is None:
        return None
    v = str(v).strip()
    if v == '' or v.upper() == 'NULL':
        return None
    try:
        return int(v)
    except ValueError:
        return None


def classify_specialties(dept_text):
    depts = dept_text or ''
    specs = ['일반']  # 모든 응급실의 기본 수용 능력
    if '외과' in depts or '신경외과' in depts or '정형외과' in depts:
        specs.append('외상')
    if '흉부외과' in depts or '심장' in depts:
        specs.append('심장')
    if '소아청소년과' in depts:
        specs.append('소아')
    return specs


def main():
    hospitals = json.load(open(HOSPITALS_JSON, encoding='utf-8'))
    egen = json.load(open(EGEN_RAW_JSON, encoding='utf-8'))
    egen_by_hpid = {e['hpid']: e for e in egen}

    # hperyn/dutyHano 비율 중앙값 계산 (fallback용) — 두 값 모두 보고된 병원만 사용
    ratios = []
    for e in egen:
        hperyn = to_int(e.get('hperyn'))
        duty = to_int(e.get('dutyHano'))
        if hperyn and hperyn > 0 and duty and duty > 0:
            ratios.append(hperyn / duty)
    fallback_ratio = statistics.median(ratios)
    print(f'[정보] hperyn/dutyHano 비율 표본 {len(ratios)}개, fallback 비율(중앙값) = {fallback_ratio:.4f}')

    fallback_used = []
    changed = 0
    for h in hospitals:
        e = egen_by_hpid.get(h['hpid'])
        if e is None:
            print(f"[경고] {h['hpid']} {h['name']} : E-Gen 데이터 없음, 기존 합성값 유지")
            continue

        hperyn = to_int(e.get('hperyn'))
        duty = to_int(e.get('dutyHano'))
        if hperyn and hperyn > 0:
            capacity = hperyn
            source = 'hperyn(실측)'
        else:
            est = round((duty or 0) * fallback_ratio)
            capacity = max(2, est)
            source = f'fallback(dutyHano={duty} × {fallback_ratio:.4f})'
            fallback_used.append((h['hpid'], h['name'], capacity))

        specialties = classify_specialties(e.get('dgidIdName'))

        if h.get('capacity') != capacity or h.get('specialties') != specialties:
            changed += 1
        h['capacity'] = capacity
        h['specialties'] = specialties
        h['_egenSource'] = source  # 디버그용 메타데이터 (원하면 제거 가능)

    print(f'\n[요약] {len(hospitals)}개 병원 중 {changed}개 capacity/specialties 갱신')
    print(f'[요약] 기준병상 미보고로 fallback 추정치를 쓴 병원 {len(fallback_used)}곳:')
    for hpid, name, cap in fallback_used:
        print(f'   - {hpid} {name}: {cap}')

    with open(OUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(hospitals, f, ensure_ascii=False, indent=2)

    with open(OUT_JS, 'w', encoding='utf-8') as f:
        f.write("// 서울시 응급의료기관 74곳 기본 데이터\n")
        f.write("// 위치(lat/lng)·등급(grade)은 실측(data/ems_facilities_all.csv, 공공데이터 기반).\n")
        f.write("// capacity(병상수)·specialties(진료과)는 국립중앙의료원 응급의료정보 Open API\n")
        f.write("// (getEgytBassInfoInqire, 응급의료기관 기본정보 조회)의 실측치로 교체:\n")
        f.write("//   capacity    <- hperyn (응급실 기준/최대 병상수). 미보고 병원(16곳)은\n")
        f.write("//                  hperyn/dutyHano 비율 중앙값으로 추정(fallback).\n")
        f.write("//   specialties <- dgidIdName (실제 운영 진료과목 텍스트)를 파싱해 결정.\n")
        f.write("// 생성 스크립트: scripts/1_generate_hospitals.py (기본 골격) + scripts/1c_apply_egen_data.py (실측 덮어쓰기)\n")
        f.write("window.HOSPITALS_DATA = " + json.dumps(hospitals, ensure_ascii=False, indent=2) + ";\n")

    print(f'\n{OUT_JSON}, {OUT_JS} 갱신 완료')


if __name__ == '__main__':
    main()
