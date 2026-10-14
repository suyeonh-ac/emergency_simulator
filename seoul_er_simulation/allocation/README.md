# 메타휴리스틱 결합 배정 (15차, 2026-10-14)

메인 파일 `seoul_er_dispatch_map_9.html`(Vercel `/`·`8_live_server.js` 기본 페이지)의 병원·경로·확률표·
스냅샷을 그대로 읽어, 배정(allocation) 방법을 바꿔 끼우며 계산 시간과 결과를 비교하는 벤치마크.
아직 HTML 화면에는 연결하지 않았다 — `allocation_core.js`는 브라우저(`window.ErAllocation`)에서도
쓸 수 있게 만들어 두었다.

## 문제 정의 (배치 배정)

한 결정 시점에 대기 환자 n명을 51개 병원에 동시에 배정한다(다자원 일반화 할당 문제 + 혼잡 비용).

- 제약: 병원별 응급실 잔여 병상, ICU 필요 환자는 해당 진료계열 ICU 잔여 병상. 진료계열 미표방·
  (수술 필요 시) 빈 수술실 없음 → 후보 제외 (화면 `isHospitalEligible()`과 같은 조건)
- 목적(초, 최소화): KTAS 가중(1:8, 2:4, 3:2, 4·5:1) × 카카오 실도로 이송시간
  + 응급실·ICU 볼록 혼잡 비용 300·(점유율)² + 배정 보류 벌점 2시간 × 가중치

## 해법 (`allocation_core.js`)

| 분류 | 해법 |
|---|---|
| 구성형 | 현재 GLOBAL(직선거리 최근접), 도로시간 최근접, 한계비용 greedy, 우선순위(중증·희소 먼저), Regret-2 |
| 단일해 개선 | 국소탐색(LS), 담금질(SA), 타부(TS), 반복 국소탐색(ILS), 가변 이웃(VNS), LNS, 적응형 LNS(ALNS) |
| 개체군 | GA, 메메틱(GA+LS), 개미 집락(ACO·MMAS), 입자 군집(PSO·랜덤키), GRASP |

개선형·개체군 해법은 우선순위 greedy 해를 초기해로 쓰고 시간 한도(`timeLimitMs`)까지 돈다.
모든 해는 `solve()`에서 실행 가능성·목적값을 다시 계산해 검증한다.

## 실행

```
node bench_static.js            # 정적 배치 4개 시나리오 × 인스턴스 5개 × 시간한도 20/100/500ms
python exact_cpsat.py 60        # OR-Tools CP-SAT 정확해(최적성 격차 기준)
node bench_online.js            # 24시간/재난 시나리오 × 정책 18개 × 시드 3개 (병렬 워커)
node analyze.js > results/summary.md
```

| 파일 | 역할 |
|---|---|
| `main_html_data.js` | 메인 HTML에서 데이터·샘플러 추출 |
| `sim_world.js` | 병원 구성·환자 위치·시작 상태(E-Gen 스냅샷)를 화면과 같은 규칙으로 생성 |
| `allocation_core.js` | 문제 정의 + 해법 17종 |
| `bench_static.js` / `exact_cpsat.py` | 한 시점 배치 비교 / 정확해 |
| `bench_online.js` | 시간 흐름 시뮬레이션에서 정책 비교 (현재 순차 문의·GLOBAL 포함) |
| `analyze.js` | 결과 표 생성 |
