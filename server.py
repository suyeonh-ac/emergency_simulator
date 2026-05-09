# server.py
# 통합 Flask 백엔드
# - /classify : KTAS RAG 분류 (ktas_data.json)
# - /gpt      : GPT-4o-mini 증상 분석 → HTML로 결과 전달
# - /stt      : CLOVA STT 프록시 (브라우저 CORS 우회)
#
# 실행: python server.py
# .env 필요:
#   OPENAI_API_KEY=sk-...
#   CLOVA_CLIENT_ID=pqeinf27eq
#   CLOVA_CLIENT_SECRET=r69cMUzcTbxy5n6uP5tz54aQP1PD79UVGAsvgzTg

import json, re, os
from difflib import SequenceMatcher
import requests as req
from flask import Flask, request, jsonify
from flask_cors import CORS
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)

openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
CLOVA_ID     = os.getenv("CLOVA_CLIENT_ID")
CLOVA_SECRET = os.getenv("CLOVA_CLIENT_SECRET")
CLOVA_URL    = "https://naveropenapi.apigw.ntruss.com/recog/v1/stt?lang=Kor"

with open("ktas_data.json", encoding="utf-8") as f:
    KTAS_DATA = json.load(f)

KEYWORD_MAP = {
    "가슴":["흉통","심장성","비심장성","심계항진"],"흉통":["흉통"],"두통":["두통"],
    "복통":["복통"],"어지럼":["현훈"],"어지러":["현훈"],"두근":["심계항진"],
    "발열":["열"],"고열":["열"],"구토":["구토","구역"],"설사":["설사"],
    "허리":["목, 등, 허리 통증"],"혈압":["고혈압"],"고혈압":["고혈압"],
    "경련":["발작"],"실신":["실신"],"기절":["실신"],"호흡":["기침"],"숨":["기침"],
    "외상":["외상"],"골절":["골절"],"화상":["화상"],"마비":["사지 약화"],
    "의식":["의식 변화","실신"],"쓰러":["실신","의식 변화"],
    "출혈":["출혈"],"구역":["구역","구토"],"속":["복통","구역"],"머리":["두통"],
}

def search_ktas(text, top_k=6):
    tl = text.lower(); scores = []
    for entry in KTAS_DATA:
        s = 0.0; cc = entry["chief_complaint"]; ccl = cc.lower()
        for kw, targets in KEYWORD_MAP.items():
            if kw in tl:
                for t in targets:
                    if t in ccl: s += 3.0
        for word in re.sub(r"[^\w가-힣]"," ",cc).split():
            if len(word)>1 and word in text: s += 5.0
        s += SequenceMatcher(None,tl,ccl).ratio()*2.0
        scores.append((s,entry))
    scores.sort(key=lambda x:-x[0])
    return [e for s,e in scores[:top_k] if s>0.1]

def build_context(entries):
    ctx = ""
    for e in entries:
        ctx += f"\n[주호소: {e['chief_complaint']} / NACRS: {e['nacrs_code']}]\n"
        for r in e["vital_sign_rules"]:   ctx += f"  활력 L{r['level']}: {r['condition']}\n"
        for r in e["other_first_rules"]:  ctx += f"  기타 L{r['level']}: {r['condition']}\n"
        for r in e["symptom_rules"]:      ctx += f"  증상 L{r['level']}: {r['condition']}\n"
    return ctx

def call_gpt(system, user, max_tokens=512):
    msg = openai_client.chat.completions.create(
        model="gpt-4o-mini", temperature=0.1, max_tokens=max_tokens,
        response_format={"type":"json_object"},
        messages=[{"role":"system","content":system},{"role":"user","content":user}]
    )
    return json.loads(msg.choices[0].message.content)

# ── /classify ────────────────────────────────────────────
@app.route("/classify", methods=["POST"])
def classify():
    data = request.get_json()
    symptom = (data or {}).get("symptom","").strip()
    if not symptom: return jsonify({"error":"증상 없음"}),400
    try:
        entries = search_ktas(symptom)
        result  = call_gpt(
            "KTAS 분류 전문가. JSON만 반환: {\"level\":숫자,\"reason\":\"한 문장\"}",
            f"증상: {symptom}\n\nKTAS 기준:\n{build_context(entries)}",
            max_tokens=256
        )
        result["matched_complaints"] = [e["chief_complaint"] for e in entries]
        return jsonify(result)
    except Exception as e:
        return jsonify({"error":str(e)}),500

# ── /gpt ─────────────────────────────────────────────────
@app.route("/gpt", methods=["POST"])
def gpt_analyze():
    data    = request.get_json()
    symptom = (data or {}).get("symptom","").strip()
    age     = (data or {}).get("age","미입력")
    gender  = (data or {}).get("gender","미입력")
    history = (data or {}).get("history","없음")
    if not symptom: return jsonify({"error":"증상 없음"}),400
    prompt = f"""환자 정보: 증상="{symptom}", 나이={age}세, 성별={gender}, 병력={history}

응답 JSON:
{{
  "ktas": 1~5 정수,
  "ktas_reason": "판단 근거 한 줄",
  "dept": "cardiac|neuro|trauma|peds|ob|opth|internal|general",
  "dept_label": "진료과 한글명",
  "symptoms": ["흉통/호흡곤란/복통/두통/심정지/외상/뇌졸중/발열/의식저하/좌측 팔 저림/식은땀/구토/골절/진통/안과 이상/소아 증상 중 해당 항목"],
  "critical": true또는false,
  "message": "안내 메시지 2~3문장"
}}"""
    try:
        return jsonify(call_gpt("한국 응급의료 전문 AI. JSON만 반환.", prompt))
    except Exception as e:
        return jsonify({"error":str(e)}),500

# ── /stt ─────────────────────────────────────────────────
@app.route("/stt", methods=["POST"])
def stt():
    audio = request.files.get("audio")
    if not audio: return jsonify({"error":"오디오 없음"}),400
    headers = {
        "X-NCP-APIGW-API-KEY-ID": CLOVA_ID,
        "X-NCP-APIGW-API-KEY":    CLOVA_SECRET,
        "Content-Type":           "application/octet-stream",
    }
    try:
        res = req.post(CLOVA_URL, data=audio.read(), headers=headers, timeout=10)
        if res.status_code==200:
            return jsonify({"text": res.json().get("text","")})
        return jsonify({"error": res.text}), res.status_code
    except Exception as e:
        return jsonify({"error":str(e)}),500

# ── /health ──────────────────────────────────────────────
@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status":"ok","model":"gpt-4o-mini"})

if __name__=="__main__":
    print("="*50)
    print("  응급실 배정 최적화 백엔드")
    print("  /classify  /gpt  /stt  /health")
    print("  http://localhost:5000")
    print("="*50)
    app.run(debug=True, port=5000)
