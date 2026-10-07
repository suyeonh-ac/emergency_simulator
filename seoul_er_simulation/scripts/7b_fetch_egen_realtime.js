// 7b단계 (11차): E-Gen "응급실 실시간 가용병상정보 조회"로 서울 응급의료기관의 지금 가용 병상을 받아
// 시뮬레이션 시작 상태 스냅샷의 원본(raw)으로 저장한다.
//
//   오퍼레이션: getEmrrmRltmUsefulSckbdInfoInqire (STAGE1=서울특별시 한 번에 조회)
//   http://apis.data.go.kr/B552657/ErmctInfoInqireService/getEmrrmRltmUsefulSckbdInfoInqire
//
// 사용법 (seoul_er_simulation 폴더에서, Node 18 이상):
//   Windows PowerShell:  $env:EGEN_SERVICE_KEY="<일반 인증키(Encoding)>"; node scripts/7b_fetch_egen_realtime.js
//   macOS/Linux:         EGEN_SERVICE_KEY="<일반 인증키(Encoding)>" node scripts/7b_fetch_egen_realtime.js
//   그다음:              python scripts/7c_build_bed_snapshots.py
//
// 인증키는 환경변수로만 받고 어떤 파일에도 쓰지 않는다. 이 파일에 키를 직접 적어 커밋하지 말 것.
// Encoding 키(%2B 등이 들어 있는 키)와 Decoding 키 모두 받는다(Decoding 키면 여기서 인코딩).
//
// 출력: data/bed_snapshots/raw/egen_YYYYMMDD_HHMM.json
//   응답 <item>의 모든 태그를 그대로 저장한다(필드 해석은 7c에서 하므로, 필드 매핑을 고쳐도 다시
//   호출할 필요가 없다).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'bed_snapshots', 'raw');
const BASE = process.env.EGEN_BASE_URL || 'https://apis.data.go.kr/B552657/ErmctInfoInqireService/getEmrrmRltmUsefulSckbdInfoInqire';

function getKey() {
  const k = (process.env.EGEN_SERVICE_KEY || '').trim();
  if (!k) {
    console.error('EGEN_SERVICE_KEY 환경변수에 data.go.kr 일반 인증키를 넣어 주세요 (파일에 적지 마세요).');
    process.exit(1);
  }
  return /%[0-9A-Fa-f]{2}/.test(k) ? k : encodeURIComponent(k);
}

function parseItems(xml) {
  const code = (xml.match(/<resultCode>([^<]*)<\/resultCode>/) || [])[1];
  const msg = (xml.match(/<resultMsg>([^<]*)<\/resultMsg>/) || [])[1];
  if (code !== '00') {
    throw new Error(`API 오류 resultCode=${code} resultMsg=${msg}\n응답 앞부분: ${xml.slice(0, 300)}`);
  }
  const total = Number((xml.match(/<totalCount>(\d+)<\/totalCount>/) || [])[1] || 0);
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const it = {};
    const tre = /<([A-Za-z0-9_]+)>([^<]*)<\/\1>/g;
    let t;
    while ((t = tre.exec(m[1]))) it[t[1]] = t[2].trim();
    items.push(it);
  }
  return { total, items };
}

async function main() {
  const key = getKey();
  const all = [];
  let page = 1, total = Infinity;
  while (all.length < total && page <= 5) {
    const url = `${BASE}?serviceKey=${key}&STAGE1=${encodeURIComponent('서울특별시')}&pageNo=${page}&numOfRows=100`;
    const res = await fetch(url);
    const xml = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${xml.slice(0, 300)}`);
    const r = parseItems(xml);
    total = r.total;
    all.push(...r.items);
    if (r.items.length === 0) break;
    page++;
  }
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  // 한국 시각 기준 파일명
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const stamp = `${kst.getUTCFullYear()}${pad(kst.getUTCMonth() + 1)}${pad(kst.getUTCDate())}_${pad(kst.getUTCHours())}${pad(kst.getUTCMinutes())}`;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `egen_${stamp}.json`);
  fs.writeFileSync(out, JSON.stringify({
    source: 'egen_realtime',
    operation: 'getEmrrmRltmUsefulSckbdInfoInqire',
    fetchedAtKST: kst.toISOString().replace('Z', '+09:00'),
    totalCount: total,
    items: all,
  }, null, 1), 'utf8');
  console.log(`${all.length}건 저장: ${path.relative(ROOT, out)}`);
  console.log('다음: python scripts/7c_build_bed_snapshots.py');
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
