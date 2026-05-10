"""
KTAS 중증도 분류 챗봇 - 백엔드 서버 (멀티턴 대화 버전)
실행: python server.py

## 변경 사항 (v2)
- 기존 단답형 → 멀티턴 대화 방식으로 전환
- GPT가 분류 애매 시 최대 MAX_QUESTIONS(=3)회 추가 질문
- 서버는 stateless 유지: 대화 히스토리와 ktas_context를 클라이언트가 캐싱 후 전송

## API 변경
  POST /classify
  Request:
    {
      "messages":      [{"role": "user"|"assistant", "content": "..."}],  # 전체 대화 히스토리
      "ktas_context":  "..."   # 선택 사항: 첫 응답에서 받은 값을 이후 요청마다 재전송
    }
  Response (추가 질문):
    {
      "type":              "question",
      "question":          "숨이 차거나 호흡이 힘드신가요?",
      "question_number":   1,           # 몇 번째 질문인지
      "ktas_context":      "...",       # 첫 응답에서만 포함 – 클라이언트가 저장해야 함
      "matched_complaints": [...]       # 첫 응답에서만 포함
    }
  Response (최종 분류):
    {
      "type":              "classification",
      "level":             2,
      "reason":            "중등도 호흡곤란과 심장성 흉통으로 레벨 2 판정",
      "chief_complaint":   "흉통 (심장성)",
      "matched_complaints": [...]
    }
"""

import json
import re
import os
from difflib import SequenceMatcher
from flask import Flask, request, jsonify
from flask_cors import CORS
from openai import OpenAI
from dotenv import load_dotenv

# ─────────────────────────────────────────
# 초기 설정
# ─────────────────────────────────────────
load_dotenv()
app = Flask(__name__)
CORS(app)

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# 추가 질문 최대 횟수
MAX_QUESTIONS = 3

# KTAS 데이터 로드
with open("ktas_data.json", encoding="utf-8") as f:
    KTAS_DATA = json.load(f)

print(f"✅ KTAS 데이터 로드 완료: {len(KTAS_DATA)}개 주호소")


# ─────────────────────────────────────────
# RAG: 증상 → 관련 KTAS 항목 검색
# ─────────────────────────────────────────

KEYWORD_MAP = {
    "가슴": ["흉통", "심장성", "비심장성", "심계항진"],
    "흉통": ["흉통", "심장성", "비심장성"],
    "심장": ["흉통", "심장성", "심정지", "심계항진"],
    "심정지": ["심정지"],
    "두통": ["두통"],
    "머리": ["두통", "두부"],
    "복통": ["복통"],
    "배": ["복통", "복부"],
    "아랫배": ["복통", "옆구리"],
    "옆구리": ["옆구리"],
    "호흡": ["호흡", "기침", "상기도"],
    "숨": ["호흡", "기침"],
    "기침": ["기침", "상기도"],
    "어지럼": ["현훈"],
    "어지러": ["현훈"],
    "두근": ["심계항진"],
    "발열": ["열"],
    "고열": ["열"],
    "체온": ["열"],
    "구토": ["구토", "구역"],
    "토": ["구토", "토혈"],
    "설사": ["설사"],
    "혈뇨": ["혈뇨"],
    "혈변": ["혈변", "흑색변"],
    "피": ["출혈", "혈"],
    "골절": ["골절"],
    "외상": ["외상", "손상"],
    "타박": ["외상"],
    "화상": ["화상"],
    "요통": ["요통"],
    "허리": ["요통"],
    "발작": ["발작"],
    "경련": ["발작"],
    "실신": ["실신"],
    "기절": ["실신"],
    "부종": ["부종"],
    "부어": ["부종"],
    "두드러기": ["두드러기", "알레르기"],
    "알레르기": ["알레르기", "두드러기"],
    "가려움": ["두드러기", "피부"],
    "소변": ["소변", "요로"],
    "고혈압": ["고혈압"],
    "혈압": ["고혈압"],
    "뇌졸중": ["뇌졸중", "사지 약화"],
    "마비": ["사지 약화", "뇌졸중"],
    "손발": ["사지 약화", "감각상실"],
    "떨림": ["떨림"],
    "의식": ["의식"],
    "무의식": ["의식"],
    "눈": ["눈"],
    "귀": ["귀", "이통"],
    "코": ["코"],
    "목": ["인후통", "목"],
    "삼킴": ["연하장애"],
    "우울": ["우울증"],
    "불안": ["불안"],
    "자해": ["우울증", "자해"],
    "자살": ["우울증"],
    "임신": ["임신"],
    "생리": ["질"],
    "피부": ["피부"],
    "발진": ["피부", "두드러기"],
    "찰과상": ["열상"],
    "찢어": ["열상"],
    "절단": ["절단"],
    "낙상": ["외상"],
    "교통": ["외상", "다발성"],
    "독": ["중독"],
    "약물": ["중독", "물질오용"],
    "음주": ["알코올"],
    "술": ["알코올"],
}


def search_ktas(symptom_text: str, top_k: int = 5) -> list:
    """사용자 증상에서 관련 KTAS 주호소 항목을 검색합니다."""
    text = symptom_text.lower()
    scores = []

    for entry in KTAS_DATA:
        score = 0.0
        cc = entry["chief_complaint"]
        cc_lower = cc.lower()

        # 1) 키워드 매핑 점수
        for kw, targets in KEYWORD_MAP.items():
            if kw in text:
                for target in targets:
                    if target in cc_lower:
                        score += 3

        # 2) 주호소 단어가 입력에 직접 포함
        cc_words = re.sub(r"[^\w가-힣]", " ", cc).split()
        for word in cc_words:
            if len(word) > 1 and word in symptom_text:
                score += 5

        # 3) 문자열 유사도 (보조)
        sim = SequenceMatcher(None, text, cc_lower).ratio()
        score += sim * 2

        scores.append((score, entry))

    scores.sort(key=lambda x: -x[0])
    return [entry for score, entry in scores[:top_k] if score > 0.1]


def format_ktas_context(entries: list) -> str:
    """검색된 KTAS 항목을 GPT 프롬프트용 텍스트로 변환합니다."""
    if not entries:
        return "관련 항목 없음"

    lines = []
    for entry in entries:
        lines.append(f"\n【{entry['chief_complaint']} (NACRS {entry['nacrs_code']})】")

        if entry["vital_sign_rules"]:
            lines.append("  [활력징후 1차 고려사항]")
            for rule in entry["vital_sign_rules"]:
                lines.append(f"    레벨{rule['level']}: {rule['condition']}")

        if entry["other_first_rules"]:
            lines.append("  [그 밖의 1차 고려사항]")
            for rule in entry["other_first_rules"]:
                lines.append(f"    레벨{rule['level']}: {rule['condition']}")

        if entry["symptom_rules"]:
            lines.append("  [증상별 2차 고려사항]")
            for rule in entry["symptom_rules"]:
                lines.append(f"    레벨{rule['level']}: {rule['condition']}")

    return "\n".join(lines)


# ─────────────────────────────────────────
# GPT 시스템 프롬프트
# ─────────────────────────────────────────

SYSTEM_TEMPLATE = """당신은 KTAS(한국형 응급환자 분류도구, 2021) 전문 분류 시스템입니다.

## KTAS 레벨 정의
- 레벨 1 (소생): 즉각 처치. 심정지, 무의식(GCS 3-8), 쇼크, 중증 호흡곤란
- 레벨 2 (긴급): 15분 이내. 의식변화, 혈역학적 장애, 중등도 호흡곤란, 고위험 기전
- 레벨 3 (응급): 30분 이내. 경증 호흡곤란, 비정상 활력징후(안정), 중등도 통증
- 레벨 4 (준응급): 1시간 이내. 경미한 증상, 경증 통증
- 레벨 5 (비응급): 2시간 이내. 만성 경증, 단순 처방

## 분류 규칙
1. 활력징후 1차 고려사항 → 그 밖의 1차 고려사항 → 증상별 2차 고려사항 순서로 적용
2. 여러 조건 해당 시 가장 높은 중증도(낮은 숫자) 선택

## 행동 지침
- 현재 정보로 KTAS 레벨을 자신 있게 결정할 수 있으면 → 즉시 분류
- 레벨 간 경계가 애매하거나 분류에 결정적인 정보가 부족하면 → 추가 질문 1개
  - 질문은 반드시 KTAS 분류에 직접 영향을 주는 것으로 한정
    (통증 강도 0~10, 호흡곤란 정도, 의식 상태, 발병 시점, 동반 증상 유무 등)
  - 이미 답변을 받은 내용은 다시 묻지 말 것
- 이미 {max_questions}번 질문했으면 → 보수적으로(더 높은 중증도로) 즉시 분류

## 관련 KTAS 분류 기준
{ktas_context}

## 응답 형식 (반드시 JSON만 출력, 다른 텍스트 금지)

추가 질문이 필요한 경우:
{{"type": "question", "question": "<질문 내용을 환자에게 직접 묻는 말투로>"}}

분류 가능한 경우:
{{"type": "classification", "level": <1~5>, "reason": "<분류 근거 한 문장>", "chief_complaint": "<해당 주호소명>"}}
"""


# ─────────────────────────────────────────
# 멀티턴 분류 함수
# ─────────────────────────────────────────

def count_questions(messages: list) -> int:
    """대화 히스토리에서 이미 질문한 횟수를 셉니다."""
    count = 0
    for m in messages:
        if m.get("role") == "assistant":
            try:
                parsed = json.loads(m["content"])
                if parsed.get("type") == "question":
                    count += 1
            except (json.JSONDecodeError, KeyError):
                pass
    return count


def classify_with_gpt(messages: list, ktas_context: str, question_count: int) -> dict:
    """
    멀티턴 대화 히스토리와 KTAS 컨텍스트를 바탕으로 GPT가 분류 또는 추가 질문을 반환합니다.
    """
    system_prompt = SYSTEM_TEMPLATE.format(
        max_questions=MAX_QUESTIONS,
        ktas_context=ktas_context,
    )

    # 최대 질문 횟수에 도달했으면 강제 분류 지시
    if question_count >= MAX_QUESTIONS:
        system_prompt += (
            f"\n\n[필수] 이미 {MAX_QUESTIONS}번 질문했습니다. "
            "추가 질문 없이 지금 바로 분류해야 합니다."
        )

    gpt_messages = [{"role": "system", "content": system_prompt}] + messages

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0,
        response_format={"type": "json_object"},  # JSON 모드 강제
        messages=gpt_messages,
    )

    raw = response.choices[0].message.content.strip()
    return json.loads(raw)


# ─────────────────────────────────────────
# Flask 라우트
# ─────────────────────────────────────────

@app.route("/classify", methods=["POST"])
def classify():
    """
    멀티턴 KTAS 분류 API.

    첫 번째 요청 예시:
      { "messages": [{"role": "user", "content": "가슴이 많이 아파요"}] }

    두 번째 이후 요청 예시 (클라이언트가 ktas_context 캐싱 후 재전송):
      {
        "messages": [
          {"role": "user",      "content": "가슴이 많이 아파요"},
          {"role": "assistant", "content": "{\"type\":\"question\",\"question\":\"숨이 차신가요?\"}"},
          {"role": "user",      "content": "숨은 안 차요"}
        ],
        "ktas_context": "..."
      }
    """
    body = request.get_json(force=True, silent=True) or {}
    messages: list = body.get("messages", [])
    ktas_context: str = body.get("ktas_context", "").strip()

    # ── 입력 검증 ──────────────────────────
    if not messages:
        return jsonify({"error": "messages 배열이 비어 있습니다."}), 400

    # 첫 번째 사용자 메시지 = 초기 증상
    first_user = next(
        (m["content"] for m in messages if m.get("role") == "user"), ""
    ).strip()
    if not first_user:
        return jsonify({"error": "증상을 입력해주세요."}), 400
    if len(first_user) > 500:
        return jsonify({"error": "증상이 너무 깁니다 (최대 500자)."}), 400

    # ── RAG: 첫 호출일 때만 실행 ────────────
    matched_complaints: list = []
    is_first_call = not ktas_context
    if is_first_call:
        relevant_entries = search_ktas(first_user, top_k=5)
        ktas_context = format_ktas_context(relevant_entries)
        matched_complaints = [e["chief_complaint"] for e in relevant_entries]

    # ── 현재까지 질문 횟수 카운트 ────────────
    question_count = count_questions(messages)

    # ── GPT 호출 ────────────────────────────
    try:
        result = classify_with_gpt(messages, ktas_context, question_count)
    except Exception as e:
        print(f"❌ GPT 오류: {e}")
        return jsonify({"error": str(e)}), 500

    # ── 응답 메타데이터 추가 ─────────────────
    result_type = result.get("type")

    if result_type == "question":
        result["question_number"] = question_count + 1

    # 첫 호출에서만 ktas_context와 matched_complaints를 내려보냄
    # 클라이언트는 이 값을 저장해 두고 다음 요청에 재전송해야 함
    if is_first_call:
        result["ktas_context"] = ktas_context
        result["matched_complaints"] = matched_complaints

    if result_type == "classification" and matched_complaints:
        result["matched_complaints"] = matched_complaints

    return jsonify(result)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "ktas_entries": len(KTAS_DATA)})


# ─────────────────────────────────────────
# 실행
# ─────────────────────────────────────────

if __name__ == "__main__":
    print("🚀 서버 시작: http://localhost:5000")
    print("   index.html을 브라우저로 여세요")
    app.run(debug=True, port=5000)
