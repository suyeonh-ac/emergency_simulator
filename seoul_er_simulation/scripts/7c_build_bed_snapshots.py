"""
7c단계 (11차): 시작 상태 스냅샷들을 시뮬레이션이 읽는 data/bed_snapshots.data.js 로 묶는다.

입력
  data/bed_snapshots/screenshots_20260917.json   (7a, 응급똑똑 캡처 전사 — 이미 공통 형식)
  data/bed_snapshots/raw/egen_*.json              (7b, E-Gen 실시간 가용병상 원본 응답)
  data/bed_detail_raw.json                        (병상 "전체" 수 — API 응답에는 가용 수만 해석해 씀)
출력
  data/bed_snapshots/egen_*.json                  (E-Gen 원본을 공통 형식으로 바꾼 것)
  data/bed_snapshots.data.js                      (window.BED_SNAPSHOTS = [최신순 스냅샷 목록])

공통 형식: hospitals[hpid].cats["그룹.항목"] = {avail: 가용(음수면 대기환자), total: 전체}
그룹: ER(응급실), ICU(중환자실), EMG(응급전용), OR(기타-수술실)

E-Gen 필드 매핑 (EGEN_FIELD_MAP)
  응급똑똑 앱의 항목 이름과 국립중앙의료원 응급의료정보조회서비스 활용가이드의 hv 필드 설명을 맞춘 것.
  **가이드 원문과 한 번 대조할 것** — 필드를 잘못 짚으면 가용 수가 전체보다 크게 나오는 경우가 많아지므로,
  아래 checks.implausible 에 그런 사례를 자동으로 모아 둔다. 매핑을 고친 뒤에는 이 스크립트만 다시 돌리면
  된다(원본에 모든 태그가 저장돼 있어 API를 다시 부를 필요 없음).
"""
import glob
import json
import os
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
SNAP_DIR = os.path.join(DATA, 'bed_snapshots')
RAW_DIR = os.path.join(SNAP_DIR, 'raw')
BED = os.path.join(DATA, 'bed_detail_raw.json')
OUT_JS = os.path.join(DATA, 'bed_snapshots.data.js')

GROUP = {'ER': '응급실병상(최대)', 'ICU': '중환자실병상(최대)', 'EMG': '응급전용병상(최대)', 'OR': '기타병상(최대)'}

EGEN_FIELD_MAP = {
    'ER.일반': 'hvec',
    'ER.소아': 'hv28',
    'ER.음압격리': 'hv29',
    'ER.일반격리': 'hv30',
    'ER.소아음압격리': 'hv15',
    'ER.소아일반격리': 'hv16',
    'ER.코호트격리': 'hv27',
    'ICU.일반': 'hvicc',
    'ICU.내과': 'hv2',
    'ICU.외과': 'hv3',
    'ICU.신경외과': 'hv6',
    'ICU.신생아': 'hvncc',
    'ICU.흉부외과': 'hvccc',
    'ICU.신경과': 'hvcc',
    'ICU.심장내과': 'hv34',
    'ICU.소아': 'hv32',
    'ICU.음압격리': 'hv35',
    'EMG.중환자실': 'hv31',
    'EMG.소아중환자실': 'hv33',
    'OR.수술실': 'hvoc',
}


def num(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def build_egen(raw_path, bd):
    raw = json.load(open(raw_path, encoding='utf-8'))
    hospitals, implausible, no_total, unmatched = {}, [], [], []
    for it in raw['items']:
        hp = it.get('hpid')
        if hp not in bd:
            unmatched.append(f"{hp} {it.get('dutyName')}")
            continue
        cats = {}
        for cat, field in EGEN_FIELD_MAP.items():
            a = num(it.get(field))
            if a is None:
                continue
            g, lab = cat.split('.', 1)
            t = bd[hp]['groups'].get(GROUP[g], {}).get(lab)
            if not isinstance(t, (int, float)) or t <= 0:
                if a != 0:
                    no_total.append(f"{bd[hp]['name']} {cat}({field})={a}")
                continue
            if a > t:
                implausible.append(f"{bd[hp]['name']} {cat}({field}) 가용 {a} > 전체 {t}")
            cats[cat] = {'avail': a, 'total': int(t)}
        hospitals[hp] = {'name': bd[hp]['name'], 'updatedAt': it.get('hvidate'), 'cats': cats}
    fetched = raw.get('fetchedAtKST', '')
    try:
        dt = datetime.fromisoformat(fetched)
        start_hour = round(dt.hour + dt.minute / 60, 2)
    except ValueError:
        start_hour = 0
    stem = os.path.splitext(os.path.basename(raw_path))[0]
    return {
        'id': stem,
        'source': 'egen_realtime',
        'label': f'E-Gen 실시간 {fetched[:16].replace("T", " ")}',
        'capturedAt': fetched,
        'startHour': start_hour,
        'note': '가용 수는 E-Gen 실시간 응답, 전체 수는 bed_detail_raw.json(응급똑똑 최대 수용치). 필드 매핑은 7c의 EGEN_FIELD_MAP',
        'hospitals': hospitals,
        'checks': {'implausible': implausible, 'availWithoutTotal': no_total, 'unmatchedHospitals': unmatched,
                   'hospitalsMissing': sorted(set(bd) - set(hospitals))},
    }


def main():
    bd = json.load(open(BED, encoding='utf-8'))
    snaps = []
    for raw_path in sorted(glob.glob(os.path.join(RAW_DIR, 'egen_*.json'))):
        s = build_egen(raw_path, bd)
        json.dump(s, open(os.path.join(SNAP_DIR, s['id'] + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        c = s['checks']
        print(f"{s['id']}: 병원 {len(s['hospitals'])}곳 · 가용>전체 {len(c['implausible'])}건 · 전체 없음 {len(c['availWithoutTotal'])}건 · 미매칭 {len(c['unmatchedHospitals'])}곳 · 누락 {len(c['hospitalsMissing'])}곳")
        for x in c['implausible'][:15]:
            print('   가용>전체:', x)
    for p in sorted(glob.glob(os.path.join(SNAP_DIR, 'screenshots_*.json'))):
        s = json.load(open(p, encoding='utf-8'))
        s['id'] = os.path.splitext(os.path.basename(p))[0]
        s.setdefault('capturedAt', '2026-09-17T21:00')
        snaps.append(s)
    for p in sorted(glob.glob(os.path.join(SNAP_DIR, 'egen_*.json'))):
        snaps.append(json.load(open(p, encoding='utf-8')))
    snaps.sort(key=lambda s: s.get('capturedAt', ''), reverse=True)
    slim = [{k: s[k] for k in ('id', 'source', 'label', 'capturedAt', 'startHour', 'note', 'hospitals') if k in s} for s in snaps]
    with open(OUT_JS, 'w', encoding='utf-8') as f:
        f.write('// 시뮬레이션 시작 상태 스냅샷 (11차) — scripts/7c_build_bed_snapshots.py 생성. 최신순.\n')
        f.write('window.BED_SNAPSHOTS = ' + json.dumps(slim, ensure_ascii=False) + ';\n')
    print(f'{len(slim)}개 스냅샷 → {os.path.relpath(OUT_JS, os.path.join(HERE, ".."))}')


if __name__ == '__main__':
    main()
