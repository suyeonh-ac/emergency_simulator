// 2026-09-28, 9차 — index.html + sim.js + data/*.data.js 를 단일 HTML 파일로 묶는다.
// seoul_er_dispatch_map_5.html까지는 이 작업을 수작업(복사/붙여넣기)으로 했던 것으로
// 보이는데, 9차부터는 실수를 줄이기 위해 스크립트로 만든다. index.html/sim.js를
// 고치고 나서 이 스크립트만 다시 실행하면 최신 번들이 나온다.
//
// 사용법 (seoul_er_simulation 폴더에서): node scripts/5_bundle_standalone_html.js <출력경로>
// 출력경로를 생략하면 ../seoul_er_dispatch_map_6.html 에 씁니다.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const outPath = process.argv[2] || path.join(ROOT, '..', 'seoul_er_dispatch_map_6.html');

// 1) data/*.data.js를 가짜 window 객체에 로드해서 실제 값(JS 객체)을 뽑아낸다.
//    (문자열 정규식으로 파싱하지 않는 이유: 포맷이 바뀌어도 안전하게 동작하도록.)
const sandbox = { window: {}, console };
vm.createContext(sandbox);
['data/hospitals.data.js', 'data/route_origins.data.js', 'data/route_cache.data.js'].forEach(rel => {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
});
const HOSPITALS_DATA = sandbox.window.HOSPITALS_DATA;
const ROUTE_ORIGINS = sandbox.window.ROUTE_ORIGINS;
const ROUTE_CACHE_RAW = sandbox.window.ROUTE_CACHE_RAW;
const SPAWN_BOUNDS = sandbox.window.SPAWN_BOUNDS;
if (!HOSPITALS_DATA || !ROUTE_ORIGINS || !ROUTE_CACHE_RAW || !SPAWN_BOUNDS) {
  throw new Error('data/*.data.js에서 필요한 전역 변수 중 일부를 찾지 못했습니다.');
}

// 2) sim.js에서 "window.X를 그대로 대입하는" 4줄을 실제 데이터 리터럴로 치환한다.
let simJs = fs.readFileSync(path.join(ROOT, 'sim.js'), 'utf8');
const marker =
`  var HOSPITALS_DATA = window.HOSPITALS_DATA;\n` +
`  var ROUTE_ORIGINS = window.ROUTE_ORIGINS;\n` +
`  var ROUTE_CACHE_RAW = window.ROUTE_CACHE_RAW;\n` +
`  var SPAWN_BOUNDS = window.SPAWN_BOUNDS;\n`;
if (!simJs.includes(marker)) {
  throw new Error('sim.js 상단의 window.* 대입 4줄을 찾지 못했습니다 — sim.js 구조가 바뀌었는지 확인하세요.');
}
const injection =
`  var HOSPITALS_DATA = ${JSON.stringify(HOSPITALS_DATA)};\n` +
`  var ROUTE_ORIGINS = ${JSON.stringify(ROUTE_ORIGINS)};\n` +
`  var ROUTE_CACHE_RAW = ${JSON.stringify(ROUTE_CACHE_RAW)};\n` +
`  var SPAWN_BOUNDS = ${JSON.stringify(SPAWN_BOUNDS)};\n`;
simJs = simJs.replace(marker, injection);

// 3) index.html의 4개 <script src> 줄(+안내 주석)을 인라인 <script> 하나로 치환한다.
let indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scriptBlockRegex =
  /<!-- 데이터 파일들을[\s\S]*?-->\s*\n<script src="data\/hospitals\.data\.js"><\/script>\s*\n<script src="data\/route_origins\.data\.js"><\/script>\s*\n<script src="data\/route_cache\.data\.js"><\/script>\s*\n<script src="sim\.js"><\/script>/;
if (!scriptBlockRegex.test(indexHtml)) {
  throw new Error('index.html에서 4개 <script src> 블록을 찾지 못했습니다 — index.html 구조가 바뀌었는지 확인하세요.');
}
indexHtml = indexHtml.replace(scriptBlockRegex, `<script>\n${simJs}\n</script>`);

fs.writeFileSync(outPath, indexHtml, 'utf8');
console.log('번들 작성 완료:', outPath, `(${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
