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

load_dotenv()

from story_engine import StoryEngine, SCENES
from characters import CHARACTERS, ALL_VOICES
from media_engine import generate_scene_image, generate_scene_music, SCENE_MUSIC_PROMPTS

ROOT = pathlib.Path(__file__).resolve().parent
ON_VERCEL = bool(os.getenv("VERCEL"))

app = FastAPI(title="The Missing Angle")
engine = StoryEngine()

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_BASE    = "https://api.elevenlabs.io/v1"
PRUNA_ENABLED      = bool(os.getenv("PRUNA_API_KEY", ""))


# ── Startup ────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    # Vercel filesystem is read-only except /tmp; pre-generated assets ship in git.
    if ON_VERCEL:
        print("[Startup] Vercel — skipping background media pre-generation")
        return

    asyncio.create_task(_pregen_all_scene_music())

    if not PRUNA_ENABLED:
        print("[Media] No PRUNA_API_KEY — image generation skipped")
        return

    asyncio.create_task(_pregen_all_scene_images())


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


# ── WebSocket ──────────────────────────────────────────────────────────────

@app.websocket("/ws/game")
async def game_ws(ws: WebSocket):
    await ws.accept()
    sid = str(uuid.uuid4())

    try:
        await _run_session(ws, sid)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass


async def _run_session(ws: WebSocket, sid: str):
    engine.reset_state(sid)
    intro = SCENES["party_night"]

    # Send initial scene + question audio (both arrive before user does anything)
    await _send_scene_start(ws, intro, sid)

    # Main loop
    async for msg in _receive_loop(ws):
        if msg.get("type") == "bytes":
            await _handle_voice_choice(ws, sid, msg["data"])
        elif msg.get("type") == "text_input":
            branch_key = msg.get("branch_key")
            if branch_key:
                await _handle_branch_choice(ws, sid, branch_key, msg.get("text", "").strip())
        elif msg.get("type") == "restart":
            engine.reset_state(sid)
            await _send_scene_start(ws, SCENES["party_night"], sid)


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


async def _send_scene_start(ws: WebSocket, scene: dict, sid: Optional[str] = None):
    if sid and scene.get("id"):
        engine.get_state(sid).current_scene = scene["id"]

    payload = _scene_payload(scene)
    await ws.send_json({"type": "scene_start", "scene": payload})

    # Auto-advance scenes (like intro) — narrate then jump
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
                # Estimate playback duration from MP3 byte size (128 kbps)
                narration_secs = len(audio) / 16000
                audio_b64 = base64.b64encode(audio).decode()
            except Exception as e:
                print(f"[TTS] Narrator failed: {e}")
                narration_secs = len(narration) * 0.065  # fallback: ~150 wpm
            await ws.send_json({
                "type":      "scene_narration",
                "text":      narration,
                "audio_b64": audio_b64,
            })
        # Fire auto-advance after narration finishes + small buffer,
        # subtracting time already spent on TTS so the wall-clock total is right
        elapsed   = time.time() - t0
        adv_delay = max(0.5, narration_secs + 1.0 - elapsed)
        asyncio.create_task(_auto_advance(ws, SCENES[auto_next], adv_delay, sid))
        return

    # Send choices immediately; speech audio can arrive after without blocking options.
    narration = scene.get("narration") if _should_narrate(scene) else None
    question  = scene.get("question")

    narrator       = scene.get("narrator_character", "NARRATOR")
    narration_task = asyncio.ensure_future(tts(narration, narrator)) if narration else None

    if narration_task:
        audio_b64 = None
        try:
            narration_audio = await narration_task
            audio_b64 = base64.b64encode(narration_audio).decode()
        except Exception as e:
            print(f"[TTS] Narrator failed: {e}")
        await ws.send_json({"type": "scene_narration", "text": narration, "audio_b64": audio_b64})

    if question:
        character = question["character"]
        text      = question["text"]
        await ws.send_json({
            "type":             "scene_question",
            "character":        character,
            "text":             text,
            "audio_b64":        None,
            "pause_at":         scene.get("pause_at", 6),
            "options":          _branch_options(scene),
        })
        asyncio.create_task(_send_question_audio(ws, character, text))


async def _auto_advance(ws: WebSocket, next_scene: dict, delay: float, sid: Optional[str] = None):
    """Wait for intro video to play, then automatically load next scene."""
    await asyncio.sleep(delay)
    await _send_scene_start(ws, next_scene, sid)



async def _send_question_audio(ws: WebSocket, character: str, text: str):
    try:
        audio = await tts(text, character)
        await ws.send_json({
            "type":      "scene_question_audio",
            "character": character,
            "text":      text,
            "audio_b64": base64.b64encode(audio).decode(),
        })
    except Exception as e:
        print(f"[TTS] {character} question failed: {e}")


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


async def _handle_voice_choice(ws: WebSocket, sid: str, audio: bytes):
    state = engine.get_state(sid)
    scene = state.get_scene()
    if not scene.get("branches"):
        return

    try:
        transcript = await transcribe_choice_audio(audio)
    except Exception as e:
        await ws.send_json({"type": "voice_no_match", "message": str(e)})
        return

    if not transcript:
        await ws.send_json({"type": "voice_no_match", "message": "No speech detected"})
        return

    await ws.send_json({"type": "transcript", "text": transcript})
    branch_key = _match_branch_key(scene, transcript)
    if not branch_key:
        await ws.send_json({"type": "voice_no_match", "message": "No matching choice"})
        return

    await _handle_branch_choice(ws, sid, branch_key, transcript)


async def _handle_branch_choice(ws: WebSocket, sid: str, branch_key: str, text: str):
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

    await asyncio.sleep(0.6)   # brief beat so the choice registers visually

    # Use _send_scene_start for all cases — it handles narration + question + ending flag
    await _send_scene_start(ws, next_scene, sid)
    if next_scene.get("is_ending"):
        await ws.send_json({"type": "ending", "scene": next_scene_id})


# ── Helpers ────────────────────────────────────────────────────────────────

def _branch_options(scene: dict) -> list:
    """Return [{key, display}] for each branch — sent to frontend as clickable options."""
    options = []
    for key, branch in scene.get("branches", {}).items():
        label = branch.get("label", key)
        display = label.split("/")[0].strip().title()
        options.append({"key": key, "display": display})
    return options[:2]  # max 2 options


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
    }


def _should_narrate(scene: dict) -> bool:
    return bool(scene.get("narration"))


# ── REST ───────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok",
            "elevenlabs": bool(ELEVENLABS_API_KEY),
            "pruna":      PRUNA_ENABLED}

@app.get("/api/scenes")
async def get_scenes():
    return {"scenes": list(SCENES.keys())}

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
