"""
6b단계: patient_probabilities.json 자체 검증.
원시 건수 합계 → 비율 재계산 → IPF 주변분포 재현 → 실측 목표치와 비교.
결과는 표준출력 + data/patient_probabilities_validation.json
"""
import json
import os
import importlib.util

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('gen', os.path.join(HERE, '6_build_patient_probabilities.py'))
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)
P = json.load(open(gen.OUT_JSON, encoding='utf-8'))
G, AGES = gen.KTAS_GROUPS, gen.AGES

checks = []


def check(name, ok, detail=''):
    checks.append({'check': name, 'ok': bool(ok), 'detail': detail})
    print(('OK  ' if ok else 'FAIL') + '  ' + name + ('  — ' + detail if detail else ''))


# 1. 원시 건수 합계 -------------------------------------------------------------
check('표3 시간대 합 = 800,599', sum(gen.T3_TOTAL) == gen.TOTAL_VISITS, str(sum(gen.T3_TOTAL)))
for b in range(8):
    a = sum(gen.T3_AGE[x][b] for x in AGES)
    k = sum(gen.T3_KTAS[g][b] for g in G)
    check(f'표3 구간{b} 연령합·KTAS합 ≈ 구간합 (미상·기타 ≤ 40)',
          abs(gen.T3_TOTAL[b] - a) <= 3 and abs(gen.T3_TOTAL[b] - k) <= 40,
          f'구간합 {gen.T3_TOTAL[b]}, 연령합 {a}, KTAS합 {k}')
check('표8 119 연령합 = 184,639', sum(gen.T8_119_AGE.values()) == gen.T8_119_TOTAL)
check('표8 119 KTAS합(+기타 29) = 184,639', sum(gen.T8_119_KTAS.values()) + gen.T8_119_KTAS_OTHER == gen.T8_119_TOTAL)
check('표8 119 결과합 = 184,639', sum(gen.T8_119_RESULT.values()) == gen.T8_119_TOTAL)
for l in range(1, 6):
    s = sum(gen.T9_AGE[a][l] for a in AGES)
    check(f'표9 레벨{l} 연령합 ≈ 전체 (미상 ≤ 2)', abs(s - gen.T9_TOTAL[l]) <= 2, f'{s} vs {gen.T9_TOTAL[l]}')
for g in G:
    a = gen.T12_ADMIT[g]
    check(f'표12(계속) KTAS {g} 입원 세부합 = 소계',
          a['일반병실'] + a['중환자실'] + a['수술후병실'] + a['수술후중환자실'] + a['기타'] == a['소계'])
# 표 간 교차 일치 (표9 결과합 = 표11 결과 행 합)
for r in ['귀가', '입원', '전원', '사망']:
    t9 = sum(gen.T9_RESULT[r].values())
    t11 = sum(gen.T11_RESULT[r])
    t9 += gen.T9_RESULT_OTHER_KTAS[r]  # 표9 'KTAS 기타' 열 포함
    check(f'표9 {r} 합(+KTAS 기타) = 표11 {r} 행 합', t9 == t11, f'{t9} vs {t11}')
check('표11 KTAS 3그룹 합 ≤ 전체 (차이 = KTAS 기타)',
      all(sum(gen.T11_KTAS[g][i] for g in G) <= gen.T11_TOTAL[i] for i in range(7)))
check('표11 전체 + 미상 90 = 800,599', sum(gen.T11_TOTAL) + 90 == gen.TOTAL_VISITS, str(sum(gen.T11_TOTAL)))
check('표10 합 = 800,599', sum(gen.T10.values()) == gen.TOTAL_VISITS)
check('HIRA [표6] 합 = 43,483', sum(gen.ICU_LOS_COUNTS) == 43483)
mid = [(a + b) / 2 for a, b in gen.ICU_LOS_BINS_D]
m = sum(c * x for c, x in zip(gen.ICU_LOS_COUNTS, mid)) / 43483
check('HIRA 구간 중앙값 기반 평균 ≈ 공표 평균 9.8일 (±1.5)', abs(m - 9.8) < 1.5, f'{m:.2f}일')

# 2. 확률 합 = 1 ------------------------------------------------------------------
def s1(v):
    return abs(sum(v) - 1) < 1e-6
check('도착 비중 합 = 1', s1([b['share'] for b in P['arrival']['bands']]))
check('시간대별 KTAS 확률 합 = 1', all(s1(b['probs'].values()) for b in P['ktasGroupByBand']['bands']))
check('(시간대,KTAS)별 연령 확률 합 = 1', all(s1(v.values()) for b in P['ageByBandKtasGroup']['bands'] for v in b['probs'].values()))
check('(KTAS,연령)별 레벨 확률 합 = 1', all(s1(v.values()) for g in P['ktasLevelByGroupAge']['table'].values() for v in g.values()))
check('(KTAS,연령)별 처치 확률 합 = 1', all(s1(v.values()) for g in P['dispositionByKtasGroupAge']['table'].values() for v in g.values()))
check('ICU 종류 확률 합 = 1', all(s1(v.values()) for v in P['icuTypeByAge']['table'].values()))
check('응급실 재실 분포 합 = 1', all(s1(r) for g in P['erLosByKtasGroupAgeResult']['table'].values() for a in g.values() for r in a.values()))
check('ICU 재실일수 분포 합 = 1', s1(P['icuLosDays']['probs']))
diag = P['ipfMaxRelativeMarginDeviation']
check('IPF 시간×KTAS×연령: 실측 2원표 재현 (100건 이상 칸 상대오차 < 0.1%)', diag['joint_all_time_ktas_age']['maxRelDev_cells>=100'] < 1e-3, str(diag['joint_all_time_ktas_age']))
check('IPF 119 1원 주변분포 재현', diag['joint_119_1d_margins']['maxRelDev_cells>=100'] < 1e-9)
check('IPF 처치: 실측 2원표 재현 (상대오차 < 0.5%)', diag['disposition_ktas_age']['maxRelDev_cells>=100'] < 5e-3, str(diag['disposition_ktas_age']))
check('IPF 재실 4원: 절대오차 < 50건 (소수 칸 표 간 불일치 허용)', diag['er_los_4d']['maxAbsDev_count'] < 50, str(diag['er_los_4d']))

# 3. 인수인계 문서 8-5장 비율 재계산 (표 12(계속) 입원 세부 ÷ 표 9 KTAS 그룹 분모) ----------
den = {'1+2': 101287, '3': 464791, '4+5': 234417}
exp_icu = {'1+2': 20.8, '3': 3.0, '4+5': 0.4}
exp_surg = {'1+2': 5.4, '3': 1.5, '4+5': 0.3}
for g in G:
    a = gen.T12_ADMIT[g]
    d = sum(gen.T9_TOTAL[l] for l in range(1, 6) if gen.LEVEL_TO_GROUP[l] == g)
    check(f'KTAS {g} 분모 = {den[g]:,}', d == den[g], str(d))
    icu = (a['중환자실'] + a['수술후중환자실']) / d * 100
    sur = (a['수술후병실'] + a['수술후중환자실']) / d * 100
    check(f'KTAS {g} ICU {exp_icu[g]}% / 수술 후 {exp_surg[g]}% 재현',
          round(icu, 1) == exp_icu[g] and round(sur, 1) == exp_surg[g], f'{icu:.2f}% / {sur:.2f}%')
for a in AGES:
    r = gen.T12_RESULT_AGE[a]
    adm = sum(r[1:6])
    check(f'표12 연령 {gen.AGE_LABEL[a]}: 행 합 ≤ 연령 계 (차이 = 가망없는퇴실 외 기타·미상)',
          0 <= gen.AGE_TOTAL[a] - sum(r) <= 300, f'계 {gen.AGE_TOTAL[a]} − 합 {sum(r)} = {gen.AGE_TOTAL[a]-sum(r)}')
check('표12 연령별 입원 합 = 209,545', sum(sum(gen.T12_RESULT_AGE[a][1:6]) for a in AGES) == 209545)

# 4. 모델 결합분포 재구성 → 119 주변분포 재현 ---------------------------------------
J = np.array(P['_joint119']['counts'])  # 시간×KTAS×연령
w = np.array([b['share'] for b in P['arrival']['bands']])
pk_b = np.array([[b['probs'][g] for g in G] for b in P['ktasGroupByBand']['bands']])
pa_bg = np.array([[[b['probs'][g][a] for a in AGES] for g in G] for b in P['ageByBandKtasGroup']['bands']])
joint = w[:, None, None] * pk_b[:, :, None] * pa_bg
pk, pa = joint.sum(axis=(0, 2)), joint.sum(axis=(0, 1))
t8k = np.array([gen.T8_119_KTAS[g] for g in G], float); t8k /= t8k.sum()
t8a = np.array([gen.T8_119_AGE[a] for a in AGES], float); t8a /= t8a.sum()
check('사슬(시간→KTAS→연령) 재구성 = 결합표', np.max(np.abs(joint - J / J.sum())) < 1e-6)
check('모델 KTAS 그룹 주변분포 = 표8 119', np.max(np.abs(pk - t8k)) < 1e-6, f'{np.round(pk*100,2)} vs {np.round(t8k*100,2)}')
check('모델 연령 주변분포 = 표8 119', np.max(np.abs(pa - t8a)) < 1e-6, f'{np.round(pa*100,2)} vs {np.round(t8a*100,2)}')

# 5. 실측 목표치와 비교 (가정이 얼마나 맞는지 — 통과/실패가 아니라 차이 보고) ---------------
report = {}
DT = P['dispositionByKtasGroupAge']['table']
pga = joint.sum(axis=0)  # KTAS×연령 (119)
res = {'귀가': 0, '입원': 0, '전원': 0, '사망': 0, '기타계': 0}
icu_rate = 0
for i, g in enumerate(G):
    for j, a in enumerate(AGES):
        for k, v in DT[g][a].items():
            res['입원' if k.startswith('입원') else k] += pga[i, j] * v
        icu_rate += pga[i, j] * (DT[g][a]['입원_중환자실'] + DT[g][a]['입원_수술후중환자실'])
tgt = {k: v / gen.T8_119_TOTAL for k, v in gen.T8_119_RESULT.items()}
tgt['기타계'] = (gen.T8_119_RESULT['가망 없는 퇴실'] + gen.T8_119_RESULT['기타'] + gen.T8_119_RESULT['미상']) / gen.T8_119_TOTAL
report['119_결과_모델_vs_표8실측(%)'] = {k: [round(res[k] * 100, 2), round(tgt[k] * 100, 2)] for k in res}
report['119_ICU입원율_모델(%)'] = round(icu_rate * 100, 2)
print('\n[참고] 119 응급진료결과: 모델 vs 표8 실측 (%):')
for k, (a, b) in report['119_결과_모델_vs_표8실측(%)'].items():
    print(f'   {k:6s} 모델 {a:6.2f}  실측 {b:6.2f}  차이 {a-b:+.2f}')
print(f'   모델 119 ICU 입원율 {icu_rate*100:.2f}% (119 실측 없음)')

# 연령별 ICU율: 전체 내원 KTAS×연령 가중으로 재구성 → 표12 연령 행과 일치해야 함
print('\n[참고] 연령별 ICU 입원율 (전체 내원): 모델 재구성 vs 표12 실측 (%):')
report['연령별_ICU율_모델_vs_실측(%)'] = {}
ga = np.zeros((3, 4))
for l in range(1, 6):
    for j, a in enumerate(AGES):
        ga[G.index(gen.LEVEL_TO_GROUP[l]), j] += gen.T9_AGE[a][l]
for j, a in enumerate(AGES):
    mdl = sum(ga[i, j] * (DT[g][a]['입원_중환자실'] + DT[g][a]['입원_수술후중환자실']) for i, g in enumerate(G)) / ga[:, j].sum()
    obs = (gen.T12_ADMIT_AGE[a]['중환자실'] + gen.T12_ADMIT_AGE[a]['수술후중환자실']) / gen.AGE_TOTAL[a]
    report['연령별_ICU율_모델_vs_실측(%)'][a] = [round(mdl * 100, 2), round(obs * 100, 2)]
    print(f'   {gen.AGE_LABEL[a]:8s} 모델 {mdl*100:5.2f}  실측 {obs*100:5.2f}')
    check(f'연령 {gen.AGE_LABEL[a]} ICU율 재현 (±0.1%p)', abs(mdl - obs) < 1e-3)

# 65세 이상 비중 시간대별 — 전체 내원 결합표가 표3 시간×연령을 재현하는지
print('\n[참고] 시간대별 65세 이상 비중 (%): 119 모델 / 전체 내원 표3 실측')
report['65세이상_시간대별_119모델_vs_전체실측(%)'] = []
for b in range(8):
    m119 = joint[b, :, 3].sum() / joint[b].sum()
    obs = gen.T3_AGE['elderly'][b] / sum(gen.T3_AGE[a][b] for a in AGES)
    report['65세이상_시간대별_119모델_vs_전체실측(%)'].append([f'{gen.BANDS[b][0]}–{gen.BANDS[b][1]}', round(m119*100, 1), round(obs*100, 1)])
    print(f'   {gen.BANDS[b][0]:2d}–{gen.BANDS[b][1]:2d}시  119 모델 {m119*100:5.1f}  전체 실측 {obs*100:5.1f}')

# 재실 8시간 이상 (전체 내원 가중으로 표11 재현 확인)
LT = P['erLosByKtasGroupAgeResult']['table']
toR = P['erLosByKtasGroupAgeResult']['resultKeyFromDisposition']
mk = P['dispositionByKtasGroupAge']['marginalByKtasGroup']
tot = p8 = adm = p8a = 0
for i, g in enumerate(G):
    for j, a in enumerate(AGES):
        for d, pd in DT[g][a].items():
            n = ga[i, j] * pd
            r = toR[d]
            share = sum(LT[g][a][r][4:])
            tot += n; p8 += n * share
            if r == '입원':
                adm += n; p8a += n * share
report['재실8h이상_모델_vs_표11(%)'] = {'전체': [round(p8/tot*100, 2), P['validationTargets']['er_los_8h_plus_share_all']*100],
                                      '입원': [round(p8a/adm*100, 2), P['validationTargets']['er_los_8h_plus_share_admitted_all']*100]}
print(f"\n[참고] 재실 8h 이상: 전체 {p8/tot*100:.2f}% (표11 {P['validationTargets']['er_los_8h_plus_share_all']*100:.2f}%) · 입원 {p8a/adm*100:.2f}% (표11 {P['validationTargets']['er_los_8h_plus_share_admitted_all']*100:.2f}%)")
check('재실 8h 이상 비율 표11 재현 (±0.1%p)', abs(p8/tot - P['validationTargets']['er_los_8h_plus_share_all']) < 1e-3 and abs(p8a/adm - P['validationTargets']['er_los_8h_plus_share_admitted_all']) < 1e-3)

out = {'checks': checks, 'allPassed': all(c['ok'] for c in checks), 'comparisons': report}
with open(os.path.join(gen.DATA_DIR, 'patient_probabilities_validation.json'), 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print('\n전체 통과' if out['allPassed'] else '\n실패 항목 있음')
