"""
6단계: 2024 응급의료 통계연보(제23호) 서울 편 NEDIS 표로 환자 발생 확률표를 만든다.

출력: data/patient_probabilities.json, data/patient_probabilities.data.js
      (window.PATIENT_PROBABILITIES — sim.js는 file://로 열리므로 fetch 대신 .data.js로 주입)
입력: 이 파일 안의 원시 건수(통계연보에서 옮김) + data/bed_detail_raw.json(읽기만 함)

이 스크립트는 1d→1e→1f 파이프라인과 독립적이다. hospitals.json은 읽지도 쓰지도 않는다.
모든 확률은 '건수'에서 다시 계산한다(표의 백분율은 쓰지 않음).

표 번호 정정: 인수인계 문서에서 '표 13(입원 후 결과)'로 적힌 일반병실/중환자실/수술 후 건수는
실제로는 '12) 서울 응급진료결과(계속)'의 입원 세부 열이다(PDF 19쪽 = 통계연보 283쪽).
'13) 서울 입원 후 결과'는 퇴원·사망 등 입원 이후 결과표라 여기서는 쓰지 않는다.

샘플링 사슬 (모집단 = 119구급차 내원, 2026-10-06 사용자 결정)
  ① 시간대 → 도착률 가중치            표 3 전체 내원  [119 시간대 분포의 대리변수: 가정]
  ② 시간대 → KTAS 그룹               ┐ 표3 시간×KTAS, 표3 시간×연령, 표9 KTAS×연령을 동시에 맞춘
  ③ (시간대, KTAS 그룹) → 연령군      ┘ 3원 IPF 결합표 → 표8 119 KTAS·연령 주변분포로 재보정
     (KTAS 그룹, 연령) → KTAS 레벨     표 9 실측
  ④ (KTAS 그룹, 연령) → 응급진료결과    표9 KTAS×결과 + 표12 입원 세부(KTAS 행·연령 행) 3원 IPF [전체 내원 기준]
  ⑤ ICU 필요 → 연령 분기 → ICU 종류     연령 분기 실측, 성인 7종 비율은 병상 공급 비례 [가정]
  ⑥ (KTAS 그룹, 연령, 결과) → 재실시간  표 11 KTAS×재실·연령×재실·결과×재실 + ④ 결합표를 4원 IPF
  ⑦ ICU 재실일수                        HIRA 4차 중환자실 적정성 평가 [표6] (성인, 48h 미만 제외)
"""
import json
import os
from datetime import date

import numpy as np
from scipy import optimize
from scipy.special import ndtr

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, '..', 'data')
BED_DETAIL_JSON = os.path.join(DATA_DIR, 'bed_detail_raw.json')
OUT_JSON = os.path.join(DATA_DIR, 'patient_probabilities.json')
OUT_JS = os.path.join(DATA_DIR, 'patient_probabilities.data.js')

KTAS_GROUPS = ['1+2', '3', '4+5']
LEVEL_TO_GROUP = {1: '1+2', 2: '1+2', 3: '3', 4: '4+5', 5: '4+5'}
AGES = ['infant', 'pediatric', 'adult', 'elderly']          # 1세 미만 / 1–14 / 15–64 / 65+
AGE_LABEL = {'infant': '1세 미만', 'pediatric': '1–14세', 'adult': '15–64세', 'elderly': '65세 이상'}
BANDS = [(0, 3), (3, 6), (6, 9), (9, 12), (12, 15), (15, 18), (18, 21), (21, 24)]

# ---------------------------------------------------------------------------
# 원시 건수 (통계연보 서울 편. 대상: 센터급 이상 서울 응급의료기관 31개소, 800,599건)
# ---------------------------------------------------------------------------
TOTAL_VISITS = 800599
DAYS_IN_YEAR = 366  # 2024년

# 표 3) 서울 내원시간별 응급실 이용 — 시간대 × (KTAS 그룹, 연령군)
T3_TOTAL = [69887, 47677, 69386, 133538, 125498, 120522, 121681, 112410]
T3_KTAS = {
    '1+2': [7376, 5444, 8841, 18394, 18032, 16505, 14500, 12195],
    '3':   [38057, 27246, 40047, 78792, 75589, 72355, 70302, 62403],
    '4+5': [24454, 14987, 20495, 36325, 31841, 31633, 36870, 37812],
}
T3_AGE = {
    'infant':    [1863, 1184, 982, 2078, 2390, 2355, 3182, 2919],
    'pediatric': [10059, 5728, 5268, 11954, 12980, 14788, 20622, 18939],
    'adult':     [42898, 28591, 33920, 54631, 53469, 53342, 59595, 62792],
    'elderly':   [15067, 12174, 29216, 64875, 56659, 50037, 38281, 27759],
}

# 표 8) 서울 내원수단별 응급실 이용 — 119구급차 열
T8_119_TOTAL = 184639
T8_119_AGE = {'infant': 1723, 'pediatric': 11283, 'adult': 79181, 'elderly': 92452}
T8_119_KTAS = {'1+2': 45587, '3': 109410, '4+5': 29613}   # + 기타 29
T8_119_KTAS_OTHER = 29
T8_119_RESULT = {'귀가': 110473, '입원': 63598, '전원': 6481, '가망 없는 퇴실': 20,
                 '사망': 3950, '기타': 98, '미상': 19}

# 표 9) 서울 최초 중증도 분류(KTAS) 결과 — 레벨 1..5 (+기타)
T9_TOTAL = {1: 15250, 2: 86037, 3: 464791, 4: 184327, 5: 50090}   # 기타 104
T9_AGE = {
    'infant':    {1: 112, 2: 3410, 3: 10366, 4: 2670, 5: 395},
    'pediatric': {1: 559, 2: 6084, 3: 61196, 4: 28707, 5: 3783},
    'adult':     {1: 4939, 2: 33522, 3: 217967, 4: 102988, 5: 29753},
    'elderly':   {1: 9640, 2: 43021, 3: 175260, 4: 49962, 5: 16159},
}
T9_RESULT_OTHER_KTAS = {'귀가': 15, '입원': 86, '전원': 0, '사망': 2}  # 표 9 '기타' KTAS 열
T9_RESULT = {
    '귀가': {1: 1517, 2: 36637, 3: 313004, 4: 165089, 5: 48176},
    '입원': {1: 7799, 2: 43964, 3: 139143, 4: 16985, 5: 1568},
    '전원': {1: 1355, 2: 4898, 3: 12256, 4: 2132, 5: 209},
    '사망': {1: 4567, 2: 492, 3: 216, 4: 10, 5: 105},
}

# 표 12) 서울 응급진료결과(계속) — 입원 세부, KTAS 그룹 행 (PDF 19쪽)
T12_ADMIT = {  # 소계, 일반병실, 중환자실, 수술(시술) 후 병실, 수술(시술) 후 중환자실, 기타
    '1+2': {'소계': 51763, '일반병실': 29561, '중환자실': 16544, '수술후병실': 992, '수술후중환자실': 4505, '기타': 161},
    '3':   {'소계': 139143, '일반병실': 120570, '중환자실': 11512, '수술후병실': 4199, '수술후중환자실': 2544, '기타': 318},
    '4+5': {'소계': 18553, '일반병실': 17039, '중환자실': 710, '수술후병실': 598, '수술후중환자실': 158, '기타': 48},
}
# 같은 표의 연령 행 (검증용)
T12_ADMIT_AGE = {
    'infant':    {'중환자실': 739, '수술후중환자실': 7},
    'pediatric': {'중환자실': 327, '수술후중환자실': 48},
    'adult':     {'중환자실': 9414, '수술후중환자실': 2960},
    'elderly':   {'중환자실': 18287, '수술후중환자실': 4192},
}

# 표 12) 응급진료결과 — 연령 행 (PDF 16·17·18·19쪽). 기타계 = 가망 없는 퇴실 + 기타 + 미상(연령합에서 역산)
T12_RESULT_AGE = {
    #             귀가     입원_일반 입원_ICU 수술후병실 수술후ICU 입원_기타  전원    사망  가망없는퇴실
    'infant':    [13432,   2580,    739,     22,       7,        0,       152,    14,   0],
    'pediatric': [87476,   11727,   327,     267,      48,       6,       443,    33,   1],
    'adult':     [297643,  66266,   9414,    3097,     2960,     508,     7690,   1427, 21],
    'elderly':   [165887,  86682,   18287,   2403,     4192,     13,      12565,  3918, 31],
}

AGE_TOTAL = {'infant': 16953, 'pediatric': 100338, 'adult': 389238, 'elderly': 294068}  # 표 11·12 연령 행 '계'

# 표 11) 서울 응급실 재실시간 — 구간: <2h, 2–4, 4–6, 6–8, 8–12, 12–24, 24h+ (미상 열 90건 제외)
LOS_BINS_H = [[0, 2], [2, 4], [4, 6], [6, 8], [8, 12], [12, 24], [24, 48]]  # 24h+ 상한 48h는 가정
T11_TOTAL = [282672, 280838, 114290, 46341, 33886, 30881, 11601]
T11_KTAS = {
    '1+2': [19540, 33868, 19425, 9072, 7576, 8140, 3652],
    '3':   [124142, 186100, 76431, 30160, 21542, 19419, 6964],
    '4+5': [138889, 60868, 18434, 7109, 4768, 3322, 985],
}
T11_AGE = {
    'infant':    [8838, 4493, 2075, 713, 423, 367, 41],
    'pediatric': [55226, 29333, 9285, 3013, 1759, 1437, 278],
    'adult':     [149438, 141847, 47857, 18709, 14141, 12422, 4779],
    'elderly':   [69170, 105165, 55073, 23906, 17563, 16655, 6503],
}
T11_RESULT = {
    '귀가':  [252703, 201300, 62534, 22205, 14825, 8722, 2149],
    '입원':  [25490, 74609, 48051, 21529, 16003, 16852, 7011],
    '전원':  [1191, 3697, 3363, 2405, 2858, 5073, 2263],
    '사망':  [3153, 1169, 309, 189, 185, 222, 165],
    '기타계': [3 + 132, 10 + 53, 11 + 22, 4 + 9, 5 + 10, 9 + 3, 11 + 2],  # 가망 없는 퇴실 + 기타 (미상 결과는 재실 미상 열에만 있음)
}

# 표 10) 발병 후 응급실 도착 소요시간 (검증용, 느슨한 상한 점검만)
T10 = {'<30m': 37987, '30m–2h': 179879, '2–4h': 94682, '4–6h': 53016, '6–8h': 36151,
       '8–12h': 47013, '12–24h': 78623, '24h+': 271200, '미상': 2048}

# HIRA 2023년(4차) 중환자실 적정성 평가 결과 [표6] 중환자실 입원일수 현황 (2023.1–3월, 43,483건)
# 대상: 만 18세 이상 성인 중환자실, 입실 48시간 미만·신생아/소아 중환자실·화상 제외.
ICU_LOS_BINS_D = [[2, 3], [3, 5], [5, 7], [7, 9], [9, 11], [11, 16], [16, 21], [21, 26], [26, 31], [31, 61], [61, 91]]
ICU_LOS_COUNTS = [887, 12611, 8843, 5527, 3347, 5078, 2773, 1568, 963, 1691, 195]  # 61일+ 상한 90일은 가정

# 성인 ICU 7종 (병원 ICU 컬럼과 1:1 매칭). 신생아·소아·음압격리·화상 제외.
ADULT_ICU_COLUMNS = ['일반', '내과', '외과', '신경외과', '심장내과', '흉부외과', '신경과']
OUT_OF_SCOPE_ICU_COLUMNS = ['음압격리', '화상']


# ---------------------------------------------------------------------------
def ipf(seed, margins, max_iter=1000, tol=1e-10):
    """seed: ndarray. margins: list of (axes_tuple, target ndarray). 반복 비례 조정."""
    x = seed.astype(float).copy()
    for _ in range(max_iter):
        max_dev = 0.0
        for axes, target in margins:
            other = tuple(a for a in range(x.ndim) if a not in axes)
            cur = x.sum(axis=other)
            with np.errstate(divide='ignore', invalid='ignore'):
                f = np.where(cur > 0, target / cur, 0.0)
            shape = [x.shape[a] if a in axes else 1 for a in range(x.ndim)]
            x *= f.reshape(shape)
            max_dev = max(max_dev, float(np.max(np.abs(cur - target) / np.maximum(target, 1))))
        if max_dev < tol:
            break
    return x


def margin_dev(x, margins):
    devs = []
    for axes, target in margins:
        other = tuple(a for a in range(x.ndim) if a not in axes)
        cur = x.sum(axis=other)
        big = target >= 100  # 100건 미만 소수 칸은 상대오차가 의미 없어 절대오차로 따로 봄
        devs.append((float(np.max(np.abs(cur - target)[big] / target[big])) if big.any() else 0.0,
                     float(np.max(np.abs(cur - target)))))
    return {'maxRelDev_cells>=100': max(d[0] for d in devs), 'maxAbsDev_count': max(d[1] for d in devs)}


DIAG = {}


# ---- 응급실 재실시간 연속분포: 2성분 로그정규 혼합 (주 성분 = 진료 후 퇴실, 장기 성분 = 병상 대기 등) ----
LOS_EDGES = np.array([0, 2, 4, 6, 8, 12, 24, np.inf])
_LOGE = np.log(np.where(LOS_EDGES > 0, LOS_EDGES, 1e-300))


def _unpack(th):
    m1, ls1, d, ls2, lw = np.clip(th, -30, 30)
    s1 = 0.25 + 1.0 / (1 + np.exp(-ls1))   # σ ∈ (0.25, 1.25): 한 성분이 한 점에 몰리는 과적합 방지
    s2 = 0.25 + 1.0 / (1 + np.exp(-ls2))
    m2 = m1 + np.exp(d)                    # 장기 성분 중앙값 > 주 성분 중앙값
    w = 0.5 + 0.5 / (1 + np.exp(-lw))      # 주 성분 비중 ≥ 0.5
    return m1, s1, m2, s2, w


def _mixcdf(th):
    m1, s1, m2, s2, w = _unpack(th)
    c = w * ndtr((_LOGE - m1) / s1) + (1 - w) * ndtr((_LOGE - m2) / s2)
    c[0], c[-1] = 0.0, 1.0
    return c


def fit_los_mixture(probs):
    """구간 확률(7개)에 대한 구간 최대우도 적합. 반환: 파라미터, 구간별 최대 절대오차."""
    c = np.asarray(probs, float)
    c = c / c.sum()

    def nll(th):
        return -(c * np.log(np.clip(np.diff(_mixcdf(th)), 1e-15, 1))).sum()
    best = None
    for init in ([0.8, 0, 2.0, 0, 1.5], [1.0, 0, 1.0, 0, 0.5], [0.5, 0.5, 1.5, -0.5, 2.5], [1.2, -0.5, 0.5, 0.5, 0]):
        r = optimize.minimize(nll, init, method='Nelder-Mead', options={'xatol': 1e-7, 'fatol': 1e-10, 'maxiter': 4000})
        if best is None or r.fun < best.fun:
            best = r
    m1, s1, m2, s2, w = _unpack(best.x)
    err = float(np.max(np.abs(np.diff(_mixcdf(best.x)) - c)))
    return {'w': rnd(w, 6), 'mu1': rnd(m1, 6), 'sigma1': rnd(s1, 6), 'mu2': rnd(m2, 6), 'sigma2': rnd(s2, 6)}, err


def rnd(p, k=8):
    return round(float(p), k)


def norm(d):
    s = sum(d.values())
    return {k: rnd(v / s) for k, v in d.items()}


def main():
    out = {
        'version': '10차 초안',
        'generated': date.today().isoformat(),
        'generator': 'scripts/6_build_patient_probabilities.py',
        'population': '119구급차 내원 (통계연보 표 8). 서울 센터급 이상 31개소 기준 — 시뮬레이션 51개소와 모집단이 다름',
        'notes': [],
    }

    # ① 도착률 -------------------------------------------------------------
    assert sum(T3_TOTAL) == TOTAL_VISITS
    out['arrival'] = {
        'kind': '가정(대리변수)',
        'source': '표 3 전체 내원 시간대 분포를 119 도착 시간대 분포로 사용 (119 열의 시간대 분포는 통계연보에 없음)',
        'annualCount119': T8_119_TOTAL,
        'annualCountAll': TOTAL_VISITS,
        'daysInYear': DAYS_IN_YEAR,
        'bands': [{'startHour': s, 'endHour': e, 'count': c, 'share': rnd(c / TOTAL_VISITS)}
                  for (s, e), c in zip(BANDS, T3_TOTAL)],
    }

    # ②③ 시간대 × KTAS 그룹 × 연령 결합 (전체 내원 → 119로 보정) ---------------------
    # 전체 내원: 실측 2원표 3개(표3 시간×KTAS, 표3 시간×연령, 표9 KTAS×연령)를 동시에 맞추는 IPF.
    # 3원 상호작용이 없다는(최대엔트로피) 가정만 들어가고, 조건부 독립 가정은 쓰지 않는다.
    nb, ng, na = 8, 3, 4
    bg = np.array([[T3_KTAS[g][b] for g in KTAS_GROUPS] for b in range(nb)], float)
    ba = np.array([[T3_AGE[a][b] for a in AGES] for b in range(nb)], float)
    ga = np.zeros((ng, na))
    for l in [1, 2, 3, 4, 5]:
        for j, a in enumerate(AGES):
            ga[KTAS_GROUPS.index(LEVEL_TO_GROUP[l]), j] += T9_AGE[a][l]
    N = float(TOTAL_VISITS)
    bg_t, ba_t, ga_t = bg / bg.sum() * N, ba / ba.sum() * N, ga / ga.sum() * N
    X_all = ipf(np.ones((nb, ng, na)), [((0, 1), bg_t), ((0, 2), ba_t), ((1, 2), ga_t)], max_iter=5000, tol=1e-9)
    # 119: 전체 내원 결합표의 상호작용 구조(교차비)를 유지한 채 1원 주변분포만 119로 맞춘다.
    n119 = float(sum(T8_119_KTAS.values()))
    b_t = np.array(T3_TOTAL, float) / TOTAL_VISITS * n119                    # 시간대: 표3 대리(가정)
    g_t = np.array([T8_119_KTAS[g] for g in KTAS_GROUPS], float)             # 표8 실측
    a_t = np.array([T8_119_AGE[a] for a in AGES], float); a_t = a_t / a_t.sum() * n119  # 표8 실측
    X = ipf(X_all, [((0,), b_t), ((1,), g_t), ((2,), a_t)], max_iter=5000, tol=1e-11)
    DIAG['joint_all_time_ktas_age'] = margin_dev(X_all, [((0, 1), bg_t), ((0, 2), ba_t), ((1, 2), ga_t)])
    DIAG['joint_119_1d_margins'] = margin_dev(X, [((0,), b_t), ((1,), g_t), ((2,), a_t)])
    out['ktasGroupByBand'] = {
        'kind': 'IPF 결합(가정) — 상관구조는 실측(표3·표9), 주변분포는 실측(표8 119) + 대리(표3 시간대)',
        'method': '전체 내원 시간×KTAS×연령을 표3 시간×KTAS·표3 시간×연령·표9 KTAS×연령에 맞춰 IPF로 만들고, '
                  '그 표를 seed로 시간대(표3 비중)·KTAS(표8 119)·연령(표8 119) 1원 주변분포에 다시 IPF',
        'bands': [{'startHour': s, 'endHour': e,
                   'probs': {g: rnd(X[b, i].sum() / X[b].sum()) for i, g in enumerate(KTAS_GROUPS)}}
                  for b, (s, e) in enumerate(BANDS)],
    }
    out['ageByBandKtasGroup'] = {
        'kind': '위 결합표의 조건부 확률 P(연령 | 시간대, KTAS 그룹)',
        'bands': [{'startHour': s, 'endHour': e,
                   'probs': {g: {a: rnd(X[b, i, j] / X[b, i].sum()) for j, a in enumerate(AGES)}
                             for i, g in enumerate(KTAS_GROUPS)}}
                  for b, (s, e) in enumerate(BANDS)],
    }
    lvl = {}
    for g in KTAS_GROUPS:
        ls = [l for l in [1, 2, 3, 4, 5] if LEVEL_TO_GROUP[l] == g]
        lvl[g] = {a: {str(l): rnd(T9_AGE[a][l] / sum(T9_AGE[a][m] for m in ls)) for l in ls} for a in AGES}
    out['ktasLevelByGroupAge'] = {
        'kind': '실측(표9, 전체 내원) — 119에도 같은 그룹 내 분할 적용(가정)',
        'table': lvl,
    }
    out['_joint119'] = {'note': '검증용: 119 시간대×KTAS그룹×연령 기대 건수(연간)', 'counts': np.round(X, 3).tolist()}

    # ④ (KTAS 그룹, 연령) → 처치(응급진료결과) ----------------------------------------
    # 실측 2원표 3개(표9 KTAS×연령, 표9+표12 KTAS×처치, 표12 연령×처치)를 IPF로 동시에 맞춤.
    DISP = ['귀가', '입원_일반병실', '입원_중환자실', '입원_수술후병실', '입원_수술후중환자실', '입원_기타', '전원', '사망', '기타계']
    gd = np.zeros((ng, len(DISP)))
    for i, g in enumerate(KTAS_GROUPS):
        ls = [l for l in [1, 2, 3, 4, 5] if LEVEL_TO_GROUP[l] == g]
        total = sum(T9_TOTAL[l] for l in ls)
        home = sum(T9_RESULT['귀가'][l] for l in ls)
        adm = sum(T9_RESULT['입원'][l] for l in ls)
        trans = sum(T9_RESULT['전원'][l] for l in ls)
        death = sum(T9_RESULT['사망'][l] for l in ls)
        a = T12_ADMIT[g]
        assert adm == a['소계'], (g, adm, a['소계'])
        gd[i] = [home, a['일반병실'], a['중환자실'], a['수술후병실'], a['수술후중환자실'], a['기타'],
                 trans, death, total - home - adm - trans - death]
    ad = np.zeros((na, len(DISP)))
    for j, a in enumerate(AGES):
        r = T12_RESULT_AGE[a]
        ad[j, :8] = r[:8]
        ad[j, 8] = AGE_TOTAL[a] - sum(r[:8])  # 가망없는퇴실+기타+미상 (연령 행 총합에서 역산)
    # 연령 행 총합은 표 9 연령 합(KTAS 기타 제외)과 미세하게 다르므로 공통 총합으로 정규화
    Ng = ga.sum()
    gd_t, ad_t = gd / gd.sum() * Ng, ad / ad.sum() * Ng
    D = ipf(np.ones((ng, na, len(DISP))), [((0, 1), ga), ((0, 2), gd_t), ((1, 2), ad_t)], max_iter=5000, tol=1e-9)
    DIAG['disposition_ktas_age'] = margin_dev(D, [((0, 1), ga), ((0, 2), gd_t), ((1, 2), ad_t)])
    disp_ga = {g: {a: {d: rnd(D[i, j, k] / D[i, j].sum()) for k, d in enumerate(DISP)}
                   for j, a in enumerate(AGES)} for i, g in enumerate(KTAS_GROUPS)}
    out['dispositionByKtasGroupAge'] = {
        'kind': '실측 2원표 3개(표9 KTAS×연령, 표9+표12 KTAS×처치, 표12 연령×처치)를 맞춘 IPF(가정: 3원 상호작용 없음). '
                '전체 내원 기준 → 119 환자에도 같은 조건부 확률 적용(가정)',
        'categories': DISP,
        'flags': {
            '귀가': {'needsICU': False, 'needsSurgery': False},
            '입원_일반병실': {'needsICU': False, 'needsSurgery': False},
            '입원_중환자실': {'needsICU': True, 'needsSurgery': False},
            '입원_수술후병실': {'needsICU': False, 'needsSurgery': True},
            '입원_수술후중환자실': {'needsICU': True, 'needsSurgery': True},
            '입원_기타': {'needsICU': False, 'needsSurgery': False},
            '전원': {'needsICU': False, 'needsSurgery': False},
            '사망': {'needsICU': False, 'needsSurgery': False},
            '기타계': {'needsICU': False, 'needsSurgery': False},
        },
        'table': disp_ga,
        'marginalByKtasGroup': {g: {'denominator': int(gd[i].sum()),
                                    'counts': {d: int(gd[i, k]) for k, d in enumerate(DISP)}}
                                for i, g in enumerate(KTAS_GROUPS)},
        'marginalByAge': {a: {'counts': {d: int(ad[j, k]) for k, d in enumerate(DISP)}} for j, a in enumerate(AGES)},
    }

    # ⑤ ICU 종류 -------------------------------------------------------------
    bd = json.load(open(BED_DETAIL_JSON, encoding='utf-8'))
    icu_tot = {}
    for h in bd.values():
        for k, v in h['groups'].get('중환자실병상(최대)', {}).items():
            if isinstance(v, (int, float)):
                icu_tot[k] = icu_tot.get(k, 0) + v
    adult_beds = {c: icu_tot.get(c, 0) for c in ADULT_ICU_COLUMNS}
    out['icuTypeByAge'] = {
        'kind': '연령 분기는 실측 연령군 사용, 성인 7종 비율은 병상 공급 비례(가정 — 실제 수요 근거 아님)',
        'source': 'data/bed_detail_raw.json 중환자실병상(최대) 51개소 합계',
        'hospitalColumn': '환자 진료계열 = 병원 중환자실병상(최대) 컬럼 이름과 1:1',
        'table': {
            'infant': {'신생아': 1.0},
            'pediatric': {'소아': 1.0},
            'adult': norm(adult_beds),
            'elderly': norm(adult_beds),
        },
        'adultBeds': adult_beds,
        'allIcuColumnTotals': icu_tot,
        'outOfScope': {c: icu_tot.get(c, 0) for c in OUT_OF_SCOPE_ICU_COLUMNS} | {'외상전용병상.중환자실': sum(
            (h['groups'].get('외상전용병상(최대)', {}).get('중환자실') or 0) for h in bd.values())},
        'caveats': [
            '수요를 공급에 맞춰 만들었으므로 종류별 병상 부족이 구조적으로 나오기 어렵다 — 종류별 부족 순위는 참고용',
            '외과/신경외과/흉부외과 구분은 현장 대원이 하기 어려운 병원 쪽 분류',
            '병상 컬럼은 최대 수용치이며 실제 점유가 아님',
            "'1세 미만'은 신생아(생후 28일 미만)의 대리값",
        ],
    }

    # ⑥ 응급실 재실시간 | (KTAS 그룹, 연령, 결과) — 4차원 IPF ----------------------
    R = ['귀가', '입원', '전원', '사망', '기타계']
    to_r = [0, 1, 1, 1, 1, 1, 2, 3, 4]  # DISP → R
    gar = np.zeros((ng, na, len(R)))
    for k, rr in enumerate(to_r):
        gar[:, :, rr] += D[:, :, k]
    nl = len(LOS_BINS_H)
    gl = np.array([T11_KTAS[g] for g in KTAS_GROUPS], float)
    al = np.array([T11_AGE[a] for a in AGES], float)
    rl = np.array([T11_RESULT[r] for r in R], float)
    T = gar.sum()
    gl_t, al_t, rl_t = gl / gl.sum() * T, al / al.sum() * T, rl / rl.sum() * T
    Y = ipf(np.ones((ng, na, len(R), nl)),
            [((0, 1, 2), gar), ((0, 3), gl_t), ((1, 3), al_t), ((2, 3), rl_t)], max_iter=5000, tol=1e-9)
    DIAG['er_los_4d'] = margin_dev(Y, [((0, 1, 2), gar), ((0, 3), gl_t), ((1, 3), al_t), ((2, 3), rl_t)])
    los = {g: {a: {r: [rnd(p) for p in Y[i, j, k] / Y[i, j, k].sum()] for k, r in enumerate(R)}
               for j, a in enumerate(AGES)} for i, g in enumerate(KTAS_GROUPS)}
    mix, mix_err = {}, {}
    for g in los:
        mix[g], mix_err[g] = {}, {}
        for a in los[g]:
            mix[g][a], mix_err[g][a] = {}, {}
            for r in los[g][a]:
                mix[g][a][r], e = fit_los_mixture(los[g][a][r])
                mix_err[g][a][r] = rnd(e, 5)
    out['erLosByKtasGroupAgeResult'] = {
        'kind': '실측 주변표(④의 KTAS×연령×결과, 표11 KTAS×재실·연령×재실·결과×재실)를 동시에 맞춘 IPF — 고차 결합은 가정',
        'binsHours': [[0, 2], [2, 4], [4, 6], [6, 8], [8, 12], [12, 24], [24, None]],
        'binSampling': '구간은 표 확률(table)로 뽑아 실측 구간 비율을 정확히 유지하고, 구간 안의 값은 칸별로 적합한 '
                       '2성분 로그정규 혼합(mixture)의 조건부 분포에서 뽑는다. 24h 이상 꼬리도 혼합분포를 따르며 168h에서 자름',
        'mixtureModel': 'F(t) = w·Φ((ln t − mu1)/sigma1) + (1−w)·Φ((ln t − mu2)/sigma2), t 단위 시간',
        'maxHours': 168,
        'resultKeyFromDisposition': {d: R[to_r[k]] for k, d in enumerate(DISP)},
        'table': los,
        'mixture': mix,
        'mixtureFitMaxBinError': mix_err,
        'note': '응급실 체류시간이다. 응급실 병상 점유시간으로 쓴다(ICU 재실과 별개)',
    }

    # ⑦ ICU 재실일수 ----------------------------------------------------------
    s = sum(ICU_LOS_COUNTS)
    out['icuLosDays'] = {
        'kind': '외부 실측(HIRA, 성인 중환자실 전국) → 서울 119 환자·신생아·소아에 적용하는 것은 가정',
        'source': '건강보험심사평가원, 2023년(4차) 중환자실 적정성 평가 결과(2024.7) [표6] 중환자실 입원일수 현황. 평가기간 2023.1–3월, 43,483건, 평균 9.8일',
        'url': 'https://www.hira.or.kr/cms/open/04/04/12/2024_10.pdf',
        'binsDays': ICU_LOS_BINS_D,
        'counts': ICU_LOS_COUNTS,
        'probs': [rnd(c / s) for c in ICU_LOS_COUNTS],
        'binSampling': '구간 안에서 균등(정수 일 구간 [a, b)). 61일 이상은 61–90일 균등으로 가정',
        'caveats': [
            '입실 48시간 미만 환자가 평가에서 제외됨 → 단기 재실이 빠져 분포가 길게 치우침(과대추정 방향)',
            '신생아·소아 중환자실은 평가 대상이 아님 → 같은 분포를 쓰는 것은 가정',
            '시뮬레이션 시간 단위(초)로 쓰면 수일 단위 점유가 되므로 초기 점유율(워밍업) 처리가 필요',
        ],
    }

    # ⑧ 수술실 점유시간 ------------------------------------------------------
    out['orDurationMin'] = {
        'kind': '외부 실측 평균 + 분포 모양은 가정',
        'distribution': 'lognormal',
        'mean': 191.05,
        'sigma': 0.5,
        'mu': rnd(np.log(191.05) - 0.5 ** 2 / 2, 6),
        'maxMin': 600,
        'source': 'Yu H, Yuan Y, Zhang Y, et al. Operating room performance metrics of anesthesia and surgery duration: '
                  'a descriptive analysis of emergency surgical cases. BMC Med Inform Decis Mak (2026). '
                  '중국 충칭 응급의료센터 응급수술 3,419건(2020.10–2022.9) 마취시간 평균 191.05분',
        'url': 'https://link.springer.com/article/10.1186/s12911-026-03429-w',
        'caveats': ['수술실 점유 ≈ 마취시간으로 봄(입·퇴실 정리 시간 제외)', '국외 단일기관 자료',
                    '분산(sigma=0.5)은 자료가 없어 가정', '응급실 퇴실 직후 수술실에 들어간다고 가정'],
    }

    # ⑨ ICU 초기 가동률 -------------------------------------------------------
    out['icuInitialOccupancy'] = {
        'kind': '외부 실측(전국, 2019) → 서울 51개소 시작 상태에 적용은 가정. 화면에서 조절 가능',
        'default': 0.729,
        'source': 'Cho et al., Discrepancy between the Demand and Supply of Intensive Care Unit Beds in South Korea '
                  'from 2011 to 2019, Yonsei Med J 2021;62(12):1098. 전국 ICU 병상 점유율 2011년 58.7% → 2019년 72.9%',
        'url': 'https://eymj.org/DOIx.php?id=10.3349%2Fymj.2021.62.12.1098',
        'residualSampling': '시작 시 이미 입원 중인 환자의 남은 재실일수는 정상상태 잔여시간 분포(길이 편향: 재실일수 L을 '
                            'L에 비례하는 확률로 뽑고, 그중 균등한 비율이 남았다고 봄)에서 뽑는다',
        'caveats': ['시작 후에는 응급실 경유 환자만 ICU에 들어오므로(예정 수술 등 다른 경로 없음) 장시간 실행하면 가동률이 '
                    '응급실 경유 수요만의 정상상태로 서서히 옮겨감'],
    }

    # 검증 목표치 (출력과 비교할 실측값) --------------------------------------
    out['validationTargets'] = {
        '119_result_share': {k: rnd(v / T8_119_TOTAL, 4) for k, v in T8_119_RESULT.items()},
        '119_ktas_share': {k: rnd(v / T8_119_TOTAL, 4) for k, v in T8_119_KTAS.items()},
        '119_age_share': {k: rnd(v / T8_119_TOTAL, 4) for k, v in T8_119_AGE.items()},
        'icu_admit_rate_by_age_all': {
            a: rnd((T12_ADMIT_AGE[a]['중환자실'] + T12_ADMIT_AGE[a]['수술후중환자실']) /
                   sum(T9_AGE[a].values()), 4) for a in AGES},
        'er_los_8h_plus_share_all': rnd(sum(T11_TOTAL[4:]) / sum(T11_TOTAL), 4),
        'er_los_8h_plus_share_admitted_all': rnd(sum(T11_RESULT['입원'][4:]) / sum(T11_RESULT['입원']), 4),
        'onset_to_arrival_loose_upper_bound_all': {k: rnd(v / TOTAL_VISITS, 4) for k, v in T10.items()},
    }

    out['ipfMaxRelativeMarginDeviation'] = DIAG
    with open(OUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    with open(OUT_JS, 'w', encoding='utf-8') as f:
        f.write('// 환자 발생 확률표 (10차 초안) — scripts/6_build_patient_probabilities.py 생성\n')
        f.write('// 출처·실측/가정 구분은 patient_probabilities.json 및 문서 참고\n')
        f.write('window.PATIENT_PROBABILITIES = ' + json.dumps(out, ensure_ascii=False, indent=2) + ';\n')
    print('written', OUT_JSON, OUT_JS)
    return out


if __name__ == '__main__':
    main()
