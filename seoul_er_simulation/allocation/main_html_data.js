// 15차(2026-10-14) — 메인 파일(seoul_er_dispatch_map_9.html)에 들어 있는 데이터·샘플러를 node에서 그대로 읽는다.
// 벤치마크가 화면과 "같은 병원·경로·확률표·스냅샷"을 쓰게 하려는 것(별도 사본을 두면 어긋나기 쉬움).
// 사용: const D = require('./main_html_data')();  // 기본 경로 = ../../seoul_er_dispatch_map_9.html
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DEFAULT_HTML = path.join(__dirname, '..', '..', 'seoul_er_dispatch_map_9.html');

module.exports = function loadMainHtml(htmlPath){
  const html = fs.readFileSync(htmlPath || DEFAULT_HTML, 'utf8');

  // 1) window.* 로 데이터를 넣는 인라인 스크립트(확률표·ICU 컬럼·스냅샷·샘플러)를 가짜 window에서 실행
  const blocks = [];
  html.replace(/<script>([\s\S]*?)<\/script>/g, function(_, body){ blocks.push(body); return ''; });
  const ctx = { window: {}, console };
  ctx.window.window = ctx.window;
  vm.createContext(ctx);
  blocks.forEach(function(b){
    if(/var ASSIGNMENT_MODE/.test(b)) return; // 본 시뮬레이션 블록은 DOM이 필요해서 실행하지 않음
    if(/window\.(PATIENT_PROBABILITIES|HOSPITAL_ICU_COLUMNS|BED_SNAPSHOTS)\s*=/.test(b) || /function createPatientProfileSampler/.test(b)){
      vm.runInContext('(function(){ var module; ' + b + '\n})();', ctx);
    }
  });
  const W = ctx.window;
  if(!W.PATIENT_PROBABILITIES || !W.HOSPITAL_ICU_COLUMNS || !W.BED_SNAPSHOTS || typeof W.createPatientProfileSampler !== 'function'){
    throw new Error('메인 HTML에서 확률표/ICU 컬럼/스냅샷/샘플러를 찾지 못했습니다.');
  }

  // 2) 본 시뮬레이션 블록 안의 한 줄짜리 JSON 상수
  function grabVar(name){
    const m = html.match(new RegExp('^\\s*var ' + name + ' = (.*);\\s*$', 'm'));
    if(!m) throw new Error('메인 HTML에서 var ' + name + ' 를 찾지 못했습니다.');
    return JSON.parse(m[1]);
  }
  return {
    htmlPath: htmlPath || DEFAULT_HTML,
    HOSPITALS_DATA: grabVar('HOSPITALS_DATA'),
    ROUTE_ORIGINS: grabVar('ROUTE_ORIGINS'),
    ROUTE_CACHE_RAW: grabVar('ROUTE_CACHE_RAW'),
    SPAWN_BOUNDS: grabVar('SPAWN_BOUNDS'),
    PATIENT_PROBABILITIES: W.PATIENT_PROBABILITIES,
    HOSPITAL_ICU_COLUMNS: W.HOSPITAL_ICU_COLUMNS,
    BED_SNAPSHOTS: W.BED_SNAPSHOTS,
    createPatientProfileSampler: W.createPatientProfileSampler
  };
};
