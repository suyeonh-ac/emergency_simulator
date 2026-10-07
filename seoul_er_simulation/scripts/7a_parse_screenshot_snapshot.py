"""
7a단계: 응급똑똑 캡처(응급실 병상정보.zip, 2026-09-17 16:15 ~ 09-18 01:07, 51장)에서 옮겨 적은
"가용/전체" 병상을 시작 상태 스냅샷으로 만든다 (11차).

입력: data/raw/eungeup_screenshots_20260917.txt  (사람이 캡처를 보고 옮긴 원문, '?'는 가림 표시에 일부
      가려져 읽기 불확실한 값), data/bed_detail_raw.json (분모 대조용, 읽기만 함)
출력: data/bed_snapshots/screenshots_20260917.json  (공통 스냅샷 형식, 7c가 .data.js로 묶음)

검증: 캡처의 분모(전체)가 bed_detail_raw.json(같은 앱의 최대 수용치를 엑셀로 옮긴 값)과 일치하는지
      전부 대조한다. 불일치는 출력 JSON의 checks에 남긴다.
"""
import json
import os
import difflib

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, '..', 'data')
SRC = os.path.join(DATA, 'raw', 'eungeup_screenshots_20260917.txt')
BED = os.path.join(DATA, 'bed_detail_raw.json')
OUT_DIR = os.path.join(DATA, 'bed_snapshots')
OUT = os.path.join(OUT_DIR, 'screenshots_20260917.json')

GROUP = {'ER': '응급실병상(최대)', 'ICU': '중환자실병상(최대)', 'EMG': '응급전용병상(최대)',
         'TRAUMA': '외상전용병상(최대)', 'OR': '기타병상(최대)'}
ALIAS = {'가톨릭대학교서울성모병원': '학교법인가톨릭학원가톨릭대학교서울성모병원'}


def main():
    bd = json.load(open(BED, encoding='utf-8'))
    by_name = {v['name']: k for k, v in bd.items()}
    by_name_ns = {v['name'].replace(' ', ''): k for k, v in bd.items()}
    txt = open(SRC, encoding='utf-8').read()
    hospitals, mismatch, not_shown, uncertain = {}, [], [], []
    for blk in txt.split('## ')[1:]:
        lines = blk.strip().split('\n')
        img, tm, name = lines[0].split(' ', 2)
        key = ALIAS.get(name, name)
        hp = by_name.get(key) or by_name_ns.get(key.replace(' ', ''))
        if not hp:
            raise SystemExit('병원 이름 매칭 실패: ' + name)
        if hp in hospitals:
            raise SystemExit('같은 병원이 두 번 나옴: ' + name)
        cats = {}
        for l in lines[1:]:
            g, rest = l.split(' ', 1)
            for it in rest.split('|'):
                it = it.strip()
                unc = it.endswith('?')
                lab, v = it.rstrip('?').rsplit(' ', 1)
                a, t = (int(x) for x in v.split('/'))
                cats[g + '.' + lab] = {'avail': a, 'total': t}
                if unc:
                    cats[g + '.' + lab]['uncertain'] = True
                    uncertain.append(f'{name} {g}.{lab}')
                ref = bd[hp]['groups'].get(GROUP[g], {}).get(lab)
                if ref != t:
                    mismatch.append(f'{name} {g}.{lab}: 캡처 {t} / 엑셀 {ref}')
        # 엑셀에는 병상이 있는데 캡처(실시간 화면)에 안 나온 항목
        for g, grp in GROUP.items():
            if g == 'TRAUMA':
                continue
            for lab, v in bd[hp]['groups'].get(grp, {}).items():
                if isinstance(v, (int, float)) and v > 0 and (g + '.' + lab) not in cats \
                        and (g != 'EMG' or lab in ('중환자실', '소아중환자실')) and (g != 'OR' or lab == '수술실'):
                    not_shown.append(f'{name} {g}.{lab} (엑셀 {v})')
        hospitals[hp] = {'name': bd[hp]['name'], 'capturedAt': '2026-09-' + ('17' if tm >= '12' else '18') + 'T' + tm,
                         'image': img, 'cats': cats}
    missing = sorted(set(bd) - set(hospitals))
    out = {
        'source': 'eungeup_screenshots',
        'label': '응급똑똑 캡처 2026-09-17 16:15 ~ 09-18 01:07',
        'note': '캡처 51장을 사람이 옮겨 적은 값. 한 시점이 아니라 약 9시간에 걸쳐 찍었다. avail이 음수면 대기 환자 수.',
        'startHour': 21,
        'startHourNote': '캡처 시각 중앙값 부근(00:41 전후)이 아니라 전체 구간 중간인 21시로 둠 — 시뮬레이션 시작 시각',
        'hospitals': hospitals,
        'checks': {'denominatorMismatch': mismatch, 'excelCategoryNotShownInApp': not_shown,
                   'uncertainReadings': uncertain, 'missingHospitals': missing},
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    json.dump(out, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'병원 {len(hospitals)}곳 · 분모 불일치 {len(mismatch)}건 · 캡처에 없는 엑셀 항목 {len(not_shown)}건 · '
          f'가림 불확실 {len(uncertain)}건 · 누락 병원 {missing}')
    for m in mismatch:
        print('  불일치:', m)
    for m in not_shown:
        print('  캡처 없음:', m)


if __name__ == '__main__':
    main()
