import asyncio
import base64
import json
import os
import pathlib
import re
import time
import uuid
from difflib import SequenceMatcher
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from groq import AsyncGroq
from pydantic import BaseModel

load_dotenv()

from story_engine import StoryEngine, SCENES
from characters import CHARACTERS, ALL_VOICES
from media_engine import generate_scene_image, generate_scene_music, generate_trailer_music, SCENE_MUSIC_PROMPTS

ROOT = pathlib.Path(__file__).resolve().parent
ON_VERCEL = bool(os.getenv("VERCEL"))

app = FastAPI(title="The Missing Angle")
engine = StoryEngine()

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_BASE    = "https://api.elevenlabs.io/v1"
GROQ_API_KEY       = os.getenv("GROQ_API_KEY", "")
PRUNA_ENABLED      = bool(os.getenv("PRUNA_API_KEY", ""))
_groq_client: Optional[AsyncGroq] = None

_trailer_cache: dict = {}

TRAILER_SCRIPT = (
    "Everyone remembers the fall. <break time=\"1.4s\" /> "
    "No one remembers the same moment. <break time=\"1.2s\" /> "
    "One frame was missed. <break time=\"1.1s\" /> "
    "One silence was kept. <break time=\"1.4s\" /> "
    "And before the night is over... <break time=\"1.0s\" /> "
    "someone will decide what the truth looks like. <break time=\"1.5s\" /> "
    "The Missing Angle."
)


CHOICE_DIRECTOR_PROMPT = """You are the voice choice director for an interactive film called "The Missing Angle".

The viewer is speaking while the movie is paused on a two-option decision.
Your job is to choose exactly one visible option, or null if the viewer's words do not map to either option.

Rules:
- Never invent a new branch.
- Never continue the story.
- Prefer semantic intent over exact wording.
- Handle negation carefully: "don't trust Sara" is not the same as "trust Sara".
- Return only JSON.

Respond with:
{
  "choice_key": "<one of the provided keys, or null>",
  "confidence": <0.0 to 1.0>,
  "confirmation": "<short cinematic phrase, max 8 words>"
}
"""


# ── Startup ────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    # Vercel filesystem is read-only except /tmp; pre-generated assets ship in git.
    if ON_VERCEL:
        print("[Startup] Vercel — skipping background media pre-generation")
        return

    asyncio.create_task(_pregen_all_scene_music())
    asyncio.create_task(_pregen_trailer_tts())

    if not PRUNA_ENABLED:
        print("[Media] No PRUNA_API_KEY — image generation skipped")
        return

    asyncio.create_task(_pregen_all_scene_images())


async def _pregen_trailer_tts():
    """Pre-generate trailer narration TTS and cache it in memory."""
    try:
        audio = await tts(TRAILER_SCRIPT, "NARRATOR")
        _trailer_cache["audio_b64"] = base64.b64encode(audio).decode()
        print("[Trailer] TTS pre-generated and cached")
    except Exception as e:
        print(f"[Trailer] TTS pre-gen failed: {e}")


async def _pregen_all_scene_music():
    """Generate background music for every scene atmosphere, cache to static/music/."""
    atmospheres = list({s.get("atmosphere") for s in SCENES.values() if s.get("atmosphere")})
    print(f"[Music] Pre-generating {len(atmospheres)} scene tracks...")
    for atm in atmospheres:
        if atm not in SCENE_MUSIC_PROMPTS:
            continue
        try:
            result = await generate_scene_music(atm)
            print(f"  {'✓' if result else '✗'} {atm}")
        except Exception as e:
            print(f"  ✗ {atm} ({e})")


async def _pregen_all_scene_images():
    """Generate every unique scene atmosphere image once, cache forever."""
    atmospheres = list({s.get("atmosphere", "default") for s in SCENES.values()})
    print(f"[Media] Pre-generating {len(atmospheres)} scene backgrounds...")
    for atm in atmospheres:
        try:
            result = await generate_scene_image(atm, "")
            status = "✓" if result else "✗"
        except Exception as e:
            status = f"✗ ({e})"
        print(f"  {status} {atm}")


# ── TTS ────────────────────────────────────────────────────────────────────

async def tts(text: str, character: str) -> bytes:
    character = (character or "NARRATOR").upper()
    char     = ALL_VOICES.get(character) or ALL_VOICES["NARRATOR"]
    voice_id = char["voice_id"]
    settings = char["voice_settings"]
    model_id = char.get("model_id", "eleven_turbo_v2_5")

    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(
            f"{ELEVENLABS_BASE}/text-to-speech/{voice_id}",
            headers={"xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json"},
            json={"text": text, "model_id": model_id,
                  "voice_settings": settings, "output_format": "mp3_44100_128"},
        )
        if r.status_code != 200:
            raise RuntimeError(f"TTS failed: {r.text}")
        return r.content


# ── Game session transport (WebSocket locally, HTTP batch on Vercel) ───────

class SessionSink:
    """Collects outbound game events for WebSocket or HTTP responses."""

    def __init__(self, ws: Optional[WebSocket] = None):
        self.ws = ws
        self.messages: list[dict] = []
        self.auto_advance: Optional[dict] = None

    @property
    def is_http(self) -> bool:
        return self.ws is None

    async def send(self, msg: dict):
        if self.ws is not None:
            await self.ws.send_json(msg)
        else:
            self.messages.append(msg)

    def schedule_auto_advance(self, next_scene_id: str, delay_sec: float, sid: str):
        if self.ws is not None:
            asyncio.create_task(
                _auto_advance(self, SCENES[next_scene_id], delay_sec, sid)
            )
        else:
            self.auto_advance = {
                "next_scene_id": next_scene_id,
                "delay_ms": int(max(500, delay_sec * 1000)),
            }


def _http_payload(sid: str, sink: SessionSink) -> dict:
    return {
        "session_id": sid,
        "messages": sink.messages,
        "auto_advance": sink.auto_advance,
    }


@app.websocket("/ws/game")
async def game_ws(ws: WebSocket):
    await ws.accept()
    sid = str(uuid.uuid4())

    try:
        await _run_session(SessionSink(ws), sid)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass


async def _run_session(sink: SessionSink, sid: str):
    engine.reset_state(sid)
    await _send_scene_start(sink, SCENES["party_night"], sid)

    if sink.is_http:
        return

    async for msg in _receive_loop(sink.ws):
        if msg.get("type") == "bytes":
            await _handle_voice_choice(sink, sid, msg["data"])
        elif msg.get("type") == "text_input":
            branch_key = msg.get("branch_key")
            if branch_key:
                await _handle_branch_choice(
                    sink, sid, branch_key, msg.get("text", "").strip()
                )
        elif msg.get("type") == "restart":
            engine.reset_state(sid)
            await _send_scene_start(sink, SCENES["party_night"], sid)


async def _receive_loop(ws: WebSocket):
    """Yield normalised message dicts forever until disconnect."""
    while True:
        raw = await ws.receive()
        if raw["type"] == "websocket.disconnect":
            return
        if raw.get("bytes"):
            yield {"type": "bytes", "data": raw["bytes"]}
        elif raw.get("text"):
            try:
                yield json.loads(raw["text"])
            except Exception:
                pass


async def _send_scene_start(sink: SessionSink, scene: dict, sid: Optional[str] = None):
    if sid and scene.get("id"):
        engine.get_state(sid).current_scene = scene["id"]

    payload = _scene_payload(scene)
    await sink.send({"type": "scene_start", "scene": payload})

    auto_next = scene.get("auto_advance")
    if auto_next and auto_next in SCENES:
        t0 = time.time()
        narration = scene.get("narration") if _should_narrate(scene) else None
        narrator  = scene.get("narrator_character", "NARRATOR")
        narration_secs = 0.0
        if narration:
            audio_b64 = None
            try:
                audio = await tts(narration, narrator)
                narration_secs = len(audio) / 16000
                audio_b64 = base64.b64encode(audio).decode()
            except Exception as e:
                print(f"[TTS] Narrator failed: {e}")
                narration_secs = len(narration) * 0.065
            await sink.send({
                "type":      "scene_narration",
                "text":      narration,
                "audio_b64": audio_b64,
            })
        elapsed = time.time() - t0
        minimum_secs = float(scene.get("minimum_duration", 0))
        # +2.5s accounts for: 1s client video-load delay + 0.5s crossfade + 1s safety margin
        adv_delay = max(0.5, narration_secs + 2.5 - elapsed, minimum_secs - elapsed)
        sink.schedule_auto_advance(auto_next, adv_delay, sid or "")
        return

    narration = scene.get("narration") if _should_narrate(scene) else None
    question  = scene.get("question")
    narrator  = scene.get("narrator_character", "NARRATOR")

    if narration and question and sink.is_http:
        # HTTP (Vercel): generate all TTS in parallel to stay under the 10s timeout
        character       = question["character"]
        text            = question["text"]
        decision_prompt = _decision_prompt(scene)
        results = await asyncio.gather(
            tts(narration, narrator),
            tts(text, character),
            tts(decision_prompt, "NARRATOR"),
            return_exceptions=True,
        )
        narr_b64 = base64.b64encode(results[0]).decode() if isinstance(results[0], bytes) else None
        q_b64    = base64.b64encode(results[1]).decode() if isinstance(results[1], bytes) else None
        d_b64    = base64.b64encode(results[2]).decode() if isinstance(results[2], bytes) else None
        await sink.send({"type": "scene_narration", "text": narration, "audio_b64": narr_b64})
        await sink.send({
            "type": "scene_question", "character": character, "text": text,
            "audio_b64": q_b64, "decision_prompt": decision_prompt,
            "decision_audio_b64": d_b64,
            "pause_at": scene.get("pause_at", 6), "options": _branch_options(scene),
        })
        return

    if narration:
        audio_b64 = None
        try:
            audio_b64 = base64.b64encode(await tts(narration, narrator)).decode()
        except Exception as e:
            print(f"[TTS] Narrator failed: {e}")
        await sink.send({"type": "scene_narration", "text": narration, "audio_b64": audio_b64})

    if question:
        character = question["character"]
        text      = question["text"]
        decision_prompt = _decision_prompt(scene)
        await sink.send({
            "type":             "scene_question",
            "character":        character,
            "text":             text,
            "audio_b64":        None,
            "decision_prompt":  decision_prompt,
            "decision_audio_b64": None,
            "pause_at":         scene.get("pause_at", 6),
            "options":          _branch_options(scene),
        })
        asyncio.create_task(_send_question_audio(sink, character, text, decision_prompt))


async def _auto_advance(sink: SessionSink, next_scene: dict, delay: float, sid: Optional[str] = None):
    await asyncio.sleep(delay)
    await _send_scene_start(sink, next_scene, sid)


async def _send_question_audio(sink: SessionSink, character: str, text: str, decision_prompt: str):
    question_audio_b64 = None
    decision_audio_b64 = None
    try:
        question_audio, decision_audio = await asyncio.gather(
            tts(text, character),
            tts(decision_prompt, "NARRATOR"),
        )
        question_audio_b64 = base64.b64encode(question_audio).decode()
        decision_audio_b64 = base64.b64encode(decision_audio).decode()
    except Exception as e:
        print(f"[TTS] {character} decision beat failed: {e}")
        if not question_audio_b64:
            try:
                question_audio_b64 = base64.b64encode(await tts(text, character)).decode()
            except Exception as q_err:
                print(f"[TTS] {character} question failed: {q_err}")
        if not decision_audio_b64:
            try:
                decision_audio_b64 = base64.b64encode(await tts(decision_prompt, "NARRATOR")).decode()
            except Exception as d_err:
                print(f"[TTS] Narrator decision prompt failed: {d_err}")

    await sink.send({
        "type":      "scene_question_audio",
        "character": character,
        "text":      text,
        "audio_b64": question_audio_b64,
        "decision_prompt": decision_prompt,
        "decision_audio_b64": decision_audio_b64,
    })


async def transcribe_choice_audio(audio: bytes) -> str:
    async with httpx.AsyncClient(timeout=45) as c:
        r = await c.post(
            f"{ELEVENLABS_BASE}/speech-to-text",
            headers={"xi-api-key": ELEVENLABS_API_KEY},
            data={
                "model_id": "scribe_v2",
                "tag_audio_events": "false",
                "timestamps_granularity": "none",
            },
            files={"file": ("choice.webm", audio, "audio/webm")},
        )
        if r.status_code != 200:
            raise RuntimeError(f"STT failed: {r.text}")
        data = r.json()
        return (data.get("text") or "").strip()


async def _handle_voice_choice(sink: SessionSink, sid: str, audio: bytes):
    state = engine.get_state(sid)
    scene = state.get_scene()
    if not scene.get("branches"):
        return

    try:
        transcript = await transcribe_choice_audio(audio)
    except Exception as e:
        await sink.send({"type": "voice_no_match", "message": str(e)})
        return

    if not transcript:
        await sink.send({"type": "voice_no_match", "message": "No speech detected"})
        return

    await sink.send({"type": "transcript", "text": transcript})
    branch_key = await _match_branch_key_with_groq(scene, transcript)
    if not branch_key:
        branch_key = _match_branch_key(scene, transcript)
    if not branch_key:
        await sink.send({"type": "voice_no_match", "message": "No matching choice"})
        return

    await _handle_branch_choice(sink, sid, branch_key, transcript)


async def _handle_branch_choice(sink: SessionSink, sid: str, branch_key: str, text: str):
    state = engine.get_state(sid)
    scene = state.get_scene()
    branch = scene.get("branches", {}).get(branch_key)
    if not branch:
        return

    next_scene_id = branch.get("next")
    next_scene = SCENES.get(next_scene_id or "")
    if not next_scene:
        return

    state.previous_scenes.append(state.current_scene)
    state.choices_made.append({"from": state.current_scene, "to": next_scene_id, "said": text})
    state.current_scene = next_scene_id

    await asyncio.sleep(0.6)

    await _send_scene_start(sink, next_scene, sid)
    if next_scene.get("is_ending"):
        await sink.send({"type": "ending", "scene": next_scene_id})


# ── Helpers ────────────────────────────────────────────────────────────────

def _branch_options(scene: dict) -> list:
    """Return [{key, display}] for each branch — sent to frontend as clickable options."""
    options = []
    for key, branch in scene.get("branches", {}).items():
        label = branch.get("label", key)
        display = label.split("/")[0].strip().title()
        options.append({"key": key, "display": display})
    return options[:2]  # max 2 options


def _decision_prompt(scene: dict) -> str:
    return scene.get("decision_prompt") or "The film holds. Which angle should we follow?"


def _groq() -> Optional[AsyncGroq]:
    global _groq_client
    if not GROQ_API_KEY:
        return None
    if _groq_client is None:
        _groq_client = AsyncGroq(api_key=GROQ_API_KEY)
    return _groq_client


async def _match_branch_key_with_groq(scene: dict, transcript: str) -> Optional[str]:
    client = _groq()
    branches = scene.get("branches", {})
    if not client or not branches:
        return None

    options = {
        key: {
            "display": branch.get("label", key).split("/")[0].strip().title(),
            "semantic_labels": [p.strip() for p in branch.get("label", key).split("/")],
        }
        for key, branch in branches.items()
    }

    try:
        response = await client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": CHOICE_DIRECTOR_PROMPT},
                {
                    "role": "user",
                    "content": json.dumps({
                        "scene_id": scene.get("id"),
                        "scene_title": scene.get("title"),
                        "visible_options": options,
                        "viewer_said": transcript,
                    }),
                },
            ],
            temperature=0.1,
            max_tokens=160,
            response_format={"type": "json_object"},
        )
        data = json.loads(response.choices[0].message.content)
        choice_key = data.get("choice_key")
        confidence = float(data.get("confidence") or 0)
        if choice_key in branches and confidence >= 0.55:
            return choice_key
    except Exception as e:
        print(f"[Groq] choice match failed: {e}")
    return None


def _match_branch_key(scene: dict, transcript: str) -> Optional[str]:
    branches = scene.get("branches", {})
    keys = list(branches.keys())
    spoken = _normalise_choice_text(transcript)

    ordinal_map = {
        "first": 0, "one": 0, "option one": 0, "left": 0, "top": 0,
        "second": 1, "two": 1, "option two": 1, "right": 1, "bottom": 1,
    }
    for phrase, idx in ordinal_map.items():
        if phrase in spoken and idx < len(keys):
            return keys[idx]

    best_key = None
    best_score = 0.0
    spoken_tokens = set(spoken.split())

    for key, branch in branches.items():
        label = branch.get("label", key)
        phrases = [key.replace("_", " "), *label.split("/")]
        score = 0.0

        for phrase in phrases:
            candidate = _normalise_choice_text(phrase)
            if not candidate:
                continue
            phrase_score = 0.0
            candidate_tokens = set(candidate.split())
            if candidate in spoken or spoken in candidate:
                phrase_score = max(phrase_score, 1.0)
            if candidate_tokens:
                overlap = len(spoken_tokens & candidate_tokens) / len(candidate_tokens)
                phrase_score = max(phrase_score, overlap)
            phrase_score = max(phrase_score, SequenceMatcher(None, spoken, candidate).ratio() * 0.85)

            if _is_negated(spoken_tokens) and not _is_negated(candidate_tokens):
                phrase_score = min(phrase_score, 0.25)

            score = max(score, phrase_score)

        if score > best_score:
            best_score = score
            best_key = key

    return best_key if best_score >= 0.38 else None


def _normalise_choice_text(value: str) -> str:
    value = (value or "").lower()
    value = value.replace("don't", "dont").replace("can't", "cant").replace("won't", "wont")
    value = re.sub(r"[^a-z0-9\s]", " ", (value or "").lower())
    value = re.sub(r"\s+", " ", value).strip()
    stopwords = {
        "i", "want", "to", "the", "a", "an", "please", "choose", "pick",
        "select", "go", "with", "option", "let", "lets", "us", "we", "should",
        "do",
    }
    return " ".join(word for word in value.split() if word not in stopwords)


def _is_negated(tokens: set[str]) -> bool:
    return bool(tokens & {"not", "dont", "cant", "cannot", "wont", "doubt", "reject", "blame"})


def _scene_payload(scene: dict) -> dict:
    return {
        "id":                 scene.get("id", ""),
        "title":              scene.get("title", ""),
        "atmosphere":         scene.get("atmosphere", "default"),
        "characters_present": scene.get("characters_present", []),
        "pause_at":           scene.get("pause_at"),
        "is_ending":          scene.get("is_ending", False),
        "ending_type":        scene.get("ending_type", ""),
        "has_narration":      bool(scene.get("narration") and _should_narrate(scene)),
        "auto_advance":       scene.get("auto_advance") or None,
    }


def _should_narrate(scene: dict) -> bool:
    return bool(scene.get("narration"))


# ── REST ───────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok",
            "elevenlabs": bool(ELEVENLABS_API_KEY),
            "groq":       bool(GROQ_API_KEY),
            "pruna":      PRUNA_ENABLED}

@app.get("/api/scenes")
async def get_scenes():
    return {"scenes": list(SCENES.keys())}


@app.get("/api/trailer")
async def get_trailer():
    audio_b64 = None
    music_url = None
    audio_b64 = _trailer_cache.get("audio_b64")
    if not audio_b64:
        try:
            audio_b64 = base64.b64encode(await tts(TRAILER_SCRIPT, "NARRATOR")).decode()
            _trailer_cache["audio_b64"] = audio_b64
        except Exception as e:
            print(f"[TTS] Trailer narration failed: {e}")
    try:
        music_path = await generate_trailer_music()
        if music_path:
            music_url = f"/static/music/{music_path.name}"
    except Exception as e:
        print(f"[Music] Trailer music failed: {e}")
    return {
        "text": TRAILER_SCRIPT,
        "audio_b64": audio_b64,
        "music_url": music_url,
        "video_urls": ["/static/trailer/trailer_combined.mp4"],
    }


class SessionIdBody(BaseModel):
    session_id: str
    scene_id: str = ""   # client sends current scene; survives cold-start state loss


class ChoiceBody(BaseModel):
    session_id: str
    branch_key: str
    text: str = ""
    scene_id: str = ""   # same — lets server restore scene without in-memory state


def _restore_scene(state, scene_id: str) -> dict:
    """Use scene_id from request when available; fall back to engine state."""
    if scene_id and scene_id in SCENES:
        state.current_scene = scene_id
        return SCENES[scene_id]
    return state.get_scene()


@app.post("/api/game/session")
async def http_game_session():
    """Start a game (HTTP fallback for Vercel — no WebSockets)."""
    sid = str(uuid.uuid4())
    sink = SessionSink()
    engine.reset_state(sid)
    await _send_scene_start(sink, SCENES["party_night"], sid)
    return _http_payload(sid, sink)


@app.post("/api/game/advance")
async def http_game_advance(body: SessionIdBody):
    """Continue after an auto-advance scene."""
    state = engine.get_state(body.session_id)
    scene = _restore_scene(state, body.scene_id)
    next_id = scene.get("auto_advance")
    if not next_id or next_id not in SCENES:
        raise HTTPException(400, "No auto-advance pending for this scene")
    sink = SessionSink()
    await _send_scene_start(sink, SCENES[next_id], body.session_id)
    return _http_payload(body.session_id, sink)


@app.post("/api/game/choice")
async def http_game_choice(body: ChoiceBody):
    state = engine.get_state(body.session_id)
    _restore_scene(state, body.scene_id)   # restores current_scene before branch lookup
    sink = SessionSink()
    await _handle_branch_choice(sink, body.session_id, body.branch_key, body.text)
    return _http_payload(body.session_id, sink)


@app.post("/api/game/voice")
async def http_game_voice(session_id: str = Form(...), file: UploadFile = File(...)):
    sink = SessionSink()
    audio = await file.read()
    await _handle_voice_choice(sink, session_id, audio)
    return _http_payload(session_id, sink)


@app.post("/api/game/restart")
async def http_game_restart(body: SessionIdBody):
    sink = SessionSink()
    engine.reset_state(body.session_id)
    await _send_scene_start(sink, SCENES["party_night"], body.session_id)
    return _http_payload(body.session_id, sink)

@app.post("/api/clone-voice")
async def clone_voice(character: str = Form(...), file: UploadFile = File(...)):
    audio = await file.read()
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(f"{ELEVENLABS_BASE}/voices/add",
                         headers={"xi-api-key": ELEVENLABS_API_KEY},
                         data={"name": f"{character}_clone"},
                         files={"files": (file.filename, audio, "audio/webm")})
        if r.status_code not in (200, 201):
            raise HTTPException(502, r.text)
    CHARACTERS[character]["voice_id"] = r.json()["voice_id"]
    return {"status": "ok", "character": character}


# ── Static / frontend ──────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory=str(ROOT / "static")), name="static")

@app.get("/")
def index():  return FileResponse(ROOT / "frontend/index.html")
@app.get("/app.js")
def js():     return FileResponse(ROOT / "frontend/app.js")
@app.get("/style.css")
def css():    return FileResponse(ROOT / "frontend/style.css")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
