import asyncio
import json
import os
import re
import secrets
import time
from pathlib import Path

import aiohttp
import socketio
from aiohttp import web
from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

ROOT = Path(__file__).resolve().parents[1]
AGENTS_DIR = ROOT / ".agents"
SEARCH_REQUEST_PATH = AGENTS_DIR / "search_request.json"
ANALYZED_PROFILES_PATH = AGENTS_DIR / "analyzed_profiles.json"
FINAL_MATCH_PATH = AGENTS_DIR / "final_match.json"
BACKEND_LOGS_PATH = AGENTS_DIR / "backend_logs.txt"

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "deepseek-v3.2:cloud")
BACKEND_PORT = int(os.getenv("BACKEND_PORT", "5001"))

sio = socketio.AsyncServer(async_mode="aiohttp", cors_allowed_origins="*")
app = web.Application()
sio.attach(app)


def _ensure_agents_dir() -> None:
    AGENTS_DIR.mkdir(parents=True, exist_ok=True)
    if not SEARCH_REQUEST_PATH.exists():
        SEARCH_REQUEST_PATH.write_text("{}", encoding="utf-8")
    if not ANALYZED_PROFILES_PATH.exists():
        ANALYZED_PROFILES_PATH.write_text("[]", encoding="utf-8")
    if not FINAL_MATCH_PATH.exists():
        FINAL_MATCH_PATH.write_text("{}", encoding="utf-8")
    if not BACKEND_LOGS_PATH.exists():
        BACKEND_LOGS_PATH.write_text("", encoding="utf-8")


async def log(message: str) -> None:
    _ensure_agents_dir()
    line = f"[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] Python Backend: {message}"
    with BACKEND_LOGS_PATH.open("a", encoding="utf-8") as f:
        f.write(f"{line}\n")
    await sio.emit("system_log", line)


def normalize_text(value) -> str:
    return str(value or "").strip().lower()


def sanitize_for_room(value: str) -> str:
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", normalize_text(value)))[:24]


def create_jitsi_room_id(city: str, skill: str) -> str:
    city_part = sanitize_for_room(city) or "city"
    skill_part = sanitize_for_room(skill) or "skill"
    return f"skillswap-{city_part}-{skill_part}-{int(time.time())}-{secrets.token_hex(3)}"


def build_demo_profiles(requested_skill: str, requested_city: str):
    skill = requested_skill or "React"
    city = requested_city or "Nagpur"
    return [
        {
            "username": "krushna1133",
            "name": "Krushna",
            "avatar_url": "https://avatars.githubusercontent.com/u/0?v=4",
            "bio": "Full-stack developer passionate about React, Node.js, and Next.js.",
            "city": city,
            "location": city,
            "followers": 42,
            "public_repos": 18,
            "skills": [skill, "Node.js", "TypeScript", "Next.js"],
            "topSkills": [skill, "Node.js", "TypeScript"],
            "skillScores": {skill: 88},
            "summary": f"Strong full-stack profile with notable {skill} experience.",
        },
        {
            "username": "sachit-dev",
            "name": "Sachit",
            "avatar_url": "https://avatars.githubusercontent.com/u/0?v=4",
            "bio": "Frontend developer focused on React and clean UI engineering.",
            "city": city,
            "location": city,
            "followers": 28,
            "public_repos": 12,
            "skills": [skill, "JavaScript", "CSS", "Figma"],
            "topSkills": [skill, "JavaScript", "CSS"],
            "skillScores": {skill: 82},
            "summary": f"Creative frontend profile with strong {skill} implementation quality.",
        },
    ]


def heuristic_score(profile: dict, repos: list, requested_skill: str):
    skill = normalize_text(requested_skill)
    languages = [normalize_text(r.get("language")) for r in repos if r.get("language")]
    topics = [normalize_text(t) for r in repos for t in (r.get("topics") or [])]
    descriptions = " ".join([normalize_text(r.get("description")) for r in repos])

    all_text = " ".join(languages + topics + [descriptions])
    has_skill = bool(skill and skill in all_text)

    skill_map = {}
    for idx, lang in enumerate(dict.fromkeys(languages)):
        skill_map[lang] = max(55, 85 - idx * 5)
    if has_skill:
        skill_map[skill] = 86

    top_skills = [k.title() for k, _ in sorted(skill_map.items(), key=lambda x: x[1], reverse=True)[:5]]
    return {
        "skills": top_skills,
        "topSkills": top_skills,
        "skillScores": skill_map,
        "summary": f"Developer with {profile.get('public_repos', 0)} repos. {'Active in requested skill.' if has_skill else 'Generalist profile.'}",
    }


async def evaluate_with_ollama(profile: dict, repos: list, requested_skill: str):
    client = AsyncOpenAI(api_key="ollama", base_url=OLLAMA_BASE_URL)
    repo_summary = [
        {
            "name": r.get("name"),
            "description": r.get("description"),
            "language": r.get("language"),
            "stars": r.get("stargazers_count"),
            "topics": r.get("topics") or [],
        }
        for r in repos
    ]
    prompt = f"""
Return only valid JSON with keys: skills (array), topSkills (array), skillScores (object), summary (string).
Requested skill: {requested_skill}
Profile: username={profile.get("login")}, bio={profile.get("bio")}, location={profile.get("location")}
Repos: {json.dumps(repo_summary, ensure_ascii=True)}
""".strip()

    response = await client.chat.completions.create(
        model=OLLAMA_MODEL,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
    )
    raw = (response.choices[0].message.content or "").strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.IGNORECASE | re.DOTALL).strip()
    parsed = json.loads(cleaned)
    return {
        "skills": parsed.get("skills") if isinstance(parsed.get("skills"), list) else [],
        "topSkills": parsed.get("topSkills") if isinstance(parsed.get("topSkills"), list) else [],
        "skillScores": parsed.get("skillScores") if isinstance(parsed.get("skillScores"), dict) else {},
        "summary": parsed.get("summary") if isinstance(parsed.get("summary"), str) else "",
    }


def score_profile(profile: dict, requested_skill: str, requested_city: str):
    skill = normalize_text(requested_skill)
    city = normalize_text(requested_city)
    score = 0
    reasons = []

    raw_skills = []
    if isinstance(profile.get("skills"), list):
        raw_skills.extend([str(v) for v in profile["skills"]])
    if isinstance(profile.get("topSkills"), list):
        raw_skills.extend([str(v) for v in profile["topSkills"]])
    normalized_skills = [normalize_text(s) for s in raw_skills if s]

    if skill and skill in normalized_skills:
        score += 100
        reasons.append("exact skill match")
    elif skill and any(skill in s or s in skill for s in normalized_skills if s):
        score += 70
        reasons.append("partial skill match")

    skill_scores = profile.get("skillScores")
    if isinstance(skill_scores, dict):
        for name, value in skill_scores.items():
            name_n = normalize_text(name)
            if skill and (name_n == skill or name_n in skill or skill in name_n):
                try:
                    score += max(0, min(100, int(float(value))))
                    reasons.append("AI skill score bonus")
                except Exception:
                    pass
                break

    searchable_text = normalize_text(" ".join([str(profile.get("bio") or ""), str(profile.get("summary") or "")]))
    if skill and skill in searchable_text:
        score += 25
        reasons.append("profile text mentions skill")

    location_text = normalize_text(" ".join([str(profile.get("city") or ""), str(profile.get("location") or "")]))
    if city and location_text:
        if location_text == city:
            score += 35
            reasons.append("exact city match")
        elif city in location_text or location_text in city:
            score += 20
            reasons.append("partial city match")

    followers = float(profile.get("followers") or 0)
    repos = float(profile.get("public_repos") or 0)
    score += min(20, followers / 10 + repos / 20)

    return {"score": int(score), "reasons": reasons}


def pick_best_match(profiles: list, requested_skill: str, requested_city: str):
    ranked = []
    for p in profiles:
        scored = score_profile(p, requested_skill, requested_city)
        ranked.append({"profile": p, "score": scored["score"], "reasons": scored["reasons"]})
    ranked.sort(key=lambda x: x["score"], reverse=True)
    return ranked[0] if ranked else None


def github_headers():
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "SkillSwap-Python-Backend",
    }
    if GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    return headers


async def github_get_json(session: aiohttp.ClientSession, url: str):
    async with session.get(url, headers=github_headers()) as response:
        if response.status >= 400:
            text = await response.text()
            raise RuntimeError(f"GitHub API {response.status}: {url} :: {text[:200]}")
        return await response.json()


async def run_pipeline(sid: str, city: str, skill: str):
    _ensure_agents_dir()
    SEARCH_REQUEST_PATH.write_text(json.dumps({"city": city, "skill": skill}), encoding="utf-8")
    await log(f'Pipeline triggered: city="{city}", skill="{skill}"')

    users = []
    async with aiohttp.ClientSession() as session:
        try:
            query = f"location:{city} {skill}".strip().replace(" ", "+")
            search_url = f"https://api.github.com/search/users?q={query}&per_page=5"
            await log(f"Searching GitHub: location={city}, skill={skill}")
            data = await github_get_json(session, search_url)
            users = (data.get("items") or [])[:5]
            await log(f"GitHub returned {len(users)} user(s).")
        except Exception as exc:
            await log(f"GitHub search failed: {exc}")

        evaluated = []
        for user in users:
            username = user.get("login")
            if not username:
                continue
            try:
                await log(f"Fetching profile for {username}...")
                profile, repos = await asyncio.gather(
                    github_get_json(session, f"https://api.github.com/users/{username}"),
                    github_get_json(session, f"https://api.github.com/users/{username}/repos?per_page=10&sort=updated"),
                )
                await log(f"Evaluating {username} with {OLLAMA_MODEL}...")
                try:
                    eval_data = await evaluate_with_ollama(profile, repos, skill)
                except Exception as exc:
                    await log(f"Ollama evaluation failed for {username}: {exc}. Falling back to heuristic.")
                    eval_data = heuristic_score(profile, repos, skill)

                evaluated.append(
                    {
                        "username": profile.get("login"),
                        "name": profile.get("name") or profile.get("login"),
                        "avatar_url": profile.get("avatar_url"),
                        "bio": profile.get("bio") or "",
                        "city": city,
                        "location": profile.get("location") or city,
                        "followers": profile.get("followers", 0),
                        "public_repos": profile.get("public_repos", 0),
                        **eval_data,
                    }
                )
            except Exception as exc:
                await log(f"Skipping {username}: {exc}")

    demo_profiles = build_demo_profiles(skill, city)
    all_profiles = evaluated + demo_profiles
    ANALYZED_PROFILES_PATH.write_text(json.dumps(all_profiles, indent=2), encoding="utf-8")
    await log(f"Wrote {len(all_profiles)} profile(s) to analyzed_profiles.json")

    best = pick_best_match(all_profiles, skill, city)
    if not best:
        await sio.emit("match_error", {"error": "No candidate profiles available."}, to=sid)
        await log("No candidate profiles available.")
        return

    room_id = create_jitsi_room_id(city, skill)
    result = {
        "requestedCity": city,
        "requestedSkill": skill,
        "matchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "roomId": room_id,
        "jitsiUrl": f"https://meet.jit.si/{room_id}",
        "matchConfidence": best["score"],
        "matchReasons": best["reasons"],
        "matchedUser": best["profile"],
    }
    FINAL_MATCH_PATH.write_text(json.dumps(result, indent=2), encoding="utf-8")
    await sio.emit("match_result", result, to=sid)
    await log(f'Match secured: {result["matchedUser"].get("username")} (score {result["matchConfidence"]})')


@sio.event
async def connect(sid, environ):
    await log(f"Client connected: {sid}")
    await sio.emit("backend_ready", {"status": "ok"}, to=sid)


@sio.event
async def disconnect(sid):
    await log(f"Client disconnected: {sid}")


@sio.event
async def request_match(sid, data):
    city = normalize_text((data or {}).get("city"))
    skill = normalize_text((data or {}).get("skill"))
    if not city or not skill:
        await sio.emit("match_error", {"error": "Both city and skill are required."}, to=sid)
        return
    await sio.emit("search_ack", {"city": city, "skill": skill}, to=sid)
    asyncio.create_task(run_pipeline(sid, city, skill))


async def health(request):
    return web.json_response({"ok": True})


app.router.add_get("/health", health)


if __name__ == "__main__":
    _ensure_agents_dir()
    print(f"Python backend listening on http://localhost:{BACKEND_PORT}")
    web.run_app(app, host="0.0.0.0", port=BACKEND_PORT)
