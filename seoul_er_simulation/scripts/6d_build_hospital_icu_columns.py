"""
6d단계: 병원별 ICU 9종 진료계열 병상과 소아 응급실 병상을 따로 싣는다 (10차).

1e의 icu_buckets()(외상/심장/소아/일반/내과 묶음)는 그대로 두고, sim.js가 새 진료계열 9종을
병원 ICU 컬럼과 1:1로 매칭할 수 있게 같은 원본(data/bed_detail_raw.json)에서 컬럼을 직접 뽑는다.
hospitals.json / hospitals.data.js 는 읽지도 쓰지도 않는다 (키는 hpid).

  신생아   = 중환자실병상.신생아
  소아     = 중환자실병상.소아 + 응급전용병상.소아중환자실      (2026-10-07 결정: 응급전용 소아중환자실 포함)
  일반·내과·외과·신경외과·심장내과·흉부외과·신경과 = 중환자실병상 같은 이름 컬럼
  범위 밖(환자가 요구하지 않음): 중환자실 음압격리·화상, 외상전용병상 중환자실, 응급전용병상 중환자실(+격리)
  erPediatricBeds = 응급실병상.소아 + 소아일반격리 + 소아음압격리   (소아 응급 환자 허용 병원 판정용)

출력: data/hospital_icu_columns.data.js  (window.HOSPITAL_ICU_COLUMNS = {hpid: {...}})
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, '..', 'data')
SRC = os.path.join(DATA_DIR, 'bed_detail_raw.json')
OUT_JS = os.path.join(DATA_DIR, 'hospital_icu_columns.data.js')

ICU_TYPES = ['신생아', '소아', '일반', '내과', '외과', '신경외과', '심장내과', '흉부외과', '신경과']


def n(v):
    return v if isinstance(v, (int, float)) else 0


def main():
    bd = json.load(open(SRC, encoding='utf-8'))
    out, tot = {}, {k: 0 for k in ICU_TYPES}
    tot_ped_er = 0
    for hpid, h in bd.items():
        g = h['groups']
        icu, emg, er = g.get('중환자실병상(최대)', {}), g.get('응급전용병상(최대)', {}), g.get('응급실병상(최대)', {})
        cols = {k: n(icu.get(k)) for k in ICU_TYPES}
        cols['소아'] += n(emg.get('소아중환자실'))
        ped_er = n(er.get('소아')) + n(er.get('소아일반격리')) + n(er.get('소아음압격리'))
        out[hpid] = {'name': h.get('name'), 'icu': cols, 'erPediatricBeds': ped_er}
        for k in ICU_TYPES:
            tot[k] += cols[k]
        tot_ped_er += ped_er
    with open(OUT_JS, 'w', encoding='utf-8') as f:
        f.write('// 병원별 ICU 9종 진료계열 병상 + 소아 응급실 병상 (10차) — scripts/6d_build_hospital_icu_columns.py 생성\n')
        f.write('// 원본: data/bed_detail_raw.json (응급똑똑 실측, 최대 수용치). 키 = hpid\n')
        f.write('window.HOSPITAL_ICU_COLUMNS = ' + json.dumps(out, ensure_ascii=False, indent=1) + ';\n')
    print('병원', len(out), '· ICU 합계', tot, '· 소아 응급실 병상', tot_ped_er,
          '· 소아 응급실 보유 병원', sum(1 for v in out.values() if v['erPediatricBeds'] > 0))
    for k in ICU_TYPES:
        print(f'  {k}: 보유 병원 {sum(1 for v in out.values() if v["icu"][k] > 0)}곳')


if __name__ == '__main__':
    main()
