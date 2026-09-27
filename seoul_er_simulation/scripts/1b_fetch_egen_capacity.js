/*
1b단계: E-Gen(국립중앙의료원 응급의료정보 Open API) 실측 병상수·진료과 조회
============================================================

이 스크립트는 브라우저 개발자 콘솔(F12 → Console)에서 실행한다. 이 프로젝트는
브라우저에서 실행 중인 페이지의 콘솔을 통해서만 이 API를 호출했다 — 서버사이드
환경에서 apis.data.go.kr로의 직접 네트워크 요청이 막혀 있었기 때문이다. 같은
환경 제약이 없다면 Node의 fetch나 Python의 requests로도 동일하게 호출 가능하다.

사용 오퍼레이션: getEgytBassInfoInqire (응급의료기관 기본정보 조회)
  http://apis.data.go.kr/B552657/ErmctInfoInqireService/getEgytBassInfoInqire
  요청 파라미터: serviceKey, HPID(선택), pageNo, numOfRows

왜 이 오퍼레이션인가?
  getEmrrmRltmUsefulSckbdInfoInqire(응급실 실시간 가용병상정보 조회)는 hvec/hv2~hv61
  등 "지금 당장 남은 병상 수"(실시간 가용, 마이너스도 나올 수 있음)만 준다.
  이번 시뮬레이션은 가상 환자를 생성해 배정하는 구조라 "지금 몇 병상이 비어
  있는가"가 아니라 "이 응급실이 최대 몇 명까지 수용 가능한가"가 필요하다.
  getEgytBassInfoInqire의 hperyn 필드가 바로 그 "응급실 기준(허가) 병상수"이고,
  dgidIdName 필드가 그 병원이 실제로 운영 중인 진료과목 전체 목록이다.
  (공식 가이드: NIA-IFT-OpenAPI활용가이드-01.국립중앙의료원-응급의료정보조회서비스,
   버전 6.0, 2026.08.27)

사용법
------
1. 아래 SERVICE_KEY에 data.go.kr에서 발급받은 일반 인증키(Encoding)를 넣는다.
   (본인의 키를 콘솔에 붙여넣게 될 뿐, 이 파일 자체에 실제 키를 저장해 커밋하지 말 것)
2. 이 시뮬레이션이 쓰는 서울 74개 병원의 hpid 목록(HPIDS)은 data/hospitals.json의
   hpid 값들과 동일하다 — 병원 목록을 바꾼다면 이 배열도 같이 바꿔야 한다.
3. 브라우저에서 아무 페이지(예: about:blank)를 열고 콘솔에 이 스크립트 전체를
   붙여넣고 실행한다. 74건을 동시성 6으로 순차 조회하며 약 10~20초 걸린다.
4. 완료되면 `window.__EGEN_RESULTS__`에 74개 결과가 쌓인다.
   `JSON.stringify(window.__EGEN_RESULTS__)`를 복사해 data/egen_raw.json에 붙여넣고,
   scripts/1c_apply_egen_data.py를 실행해 data/hospitals.json에 반영한다.
*/

const SERVICE_KEY = "<본인의_data.go.kr_일반인증키(Encoding)를_여기에>";

const HPIDS = [
  "A1100043","A1100014","A1100017","A1100035","A1100005","A1100008","A1100013",
  "A1100011","A1121013","A1100006","A1100002","A1100001","A1100052","A1100048",
  "A1100010","A1100021","A1100040","A1100028","A1100054","A1100004","A1100015",
  "A1100007","A1100041","A1100020","A1120796","A1100016","A1100009","A1100003",
  "A1100012","A1100053","A1100055","A1100039","A1100026","A1122033","A1100044",
  "A1100037","A1100024","A1100036","A1100050","A1100029","A1100022","A1100223",
  "A1100032","A1100045","A1100025","A1100023","A1100075","A1100027","A1100051",
  "A1100019","A1100049","A1100047","A1100141","A1100076","A1121842","A1117285",
  "A1125429","A1126226","A1123234","A1100046","A1100148","A1107402","A1100172",
  "A1100063","A1120432","A1100042","A1100152","A1100030","A1100255","A1122381",
  "A1100057","A1117070","A1100163","A1100038"
];

function parseTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}

async function fetchOne(hpid) {
  const url = `https://apis.data.go.kr/B552657/ErmctInfoInqireService/getEgytBassInfoInqire?serviceKey=${SERVICE_KEY}&HPID=${hpid}&pageNo=1&numOfRows=10`;
  try {
    const res = await fetch(url);
    const text = await res.text();
    const resultCode = parseTag(text, 'resultCode');
    if (resultCode !== '00') {
      return { hpid, error: 'resultCode=' + resultCode, resultMsg: parseTag(text, 'resultMsg') };
    }
    return {
      hpid,
      dutyName: parseTag(text, 'dutyName'),
      dgidIdName: parseTag(text, 'dgidIdName'),   // 실제 운영 진료과목 전체 (쉼표구분 텍스트)
      dutyHano: parseTag(text, 'dutyHano'),        // 병원 전체 병상수
      hpbdn: parseTag(text, 'hpbdn'),              // 병상수(총계, 병원 자체 보고)
      hperyn: parseTag(text, 'hperyn'),            // [응급실] 기준 병상수 ← 핵심
      hpgryn: parseTag(text, 'hpgryn'),            // [입원실] 기준 병상수
      hpicuyn: parseTag(text, 'hpicuyn'),          // [일반중환자실] 기준 병상수
      hpccuyn: parseTag(text, 'hpccuyn'),          // [흉부중환자실] 기준 병상수
      hpcuyn: parseTag(text, 'hpcuyn'),            // [신경중환자실] 기준 병상수
      hpnicuyn: parseTag(text, 'hpnicuyn'),        // [신생아중환자실] 기준 병상수
      hpopyn: parseTag(text, 'hpopyn'),            // [수술실] 기준 병상수
    };
  } catch (e) {
    return { hpid, error: String(e) };
  }
}

window.__EGEN_RESULTS__ = [];
const CONCURRENCY = 6;
let idx = 0;
async function worker() {
  while (idx < HPIDS.length) {
    const i = idx++;
    const r = await fetchOne(HPIDS[i]);
    window.__EGEN_RESULTS__.push(r);
    await new Promise((res) => setTimeout(res, 80));
  }
}
Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => {
  console.log(`완료: ${window.__EGEN_RESULTS__.length}건`);
  console.log('JSON.stringify(window.__EGEN_RESULTS__)를 복사해 data/egen_raw.json에 저장하세요.');
});
