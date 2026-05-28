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
from starlette.responses import Response
from groq import AsyncGroq
from pydantic import BaseModel
from elevenlabs.speech_engine import verify_speech_engine_jwt

load_dotenv()

from story_engine import StoryEngine, SCENES, reload_scenes_if_needed
from characters import ALL_VOICES
from media_engine import generate_scene_music, generate_trailer_music, SCENE_MUSIC_PROMPTS
from sara_engine import (
    SERVERS as SPEECH_ENGINE_SERVERS,
    character_system_prompt,
    clean_spoken_reply,
)

ROOT = pathlib.Path(__file__).resolve().parent
ON_VERCEL = bool(os.getenv("VERCEL"))
ON_RAILWAY = bool(os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_PROJECT_ID"))

_MEDIA_CACHE_SUFFIXES = {".mp4", ".mp3", ".spz", ".png", ".jpg", ".jpeg", ".webp", ".gif"}


class CachedStaticFiles(StaticFiles):
    """Long-cache static media; supports byte-range streaming on Railway/local."""

    async def get_response(self, path: str, scope) -> Response:
        response = await super().get_response(path, scope)
        suffix = pathlib.Path(path).suffix.lower()
        if response.status_code == 200 and suffix in _MEDIA_CACHE_SUFFIXES:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response

app = FastAPI(title="The Missing Angle")
engine = StoryEngine()

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
ELEVENLABS_BASE    = "https://api.elevenlabs.io/v1"
GROQ_API_KEY       = os.getenv("GROQ_API_KEY", "")
_groq_client: Optional[AsyncGroq] = None

_REQUIRED_ENV = ("ELEVENLABS_API_KEY", "GROQ_API_KEY")
_SPEECH_ENGINE_ENV = (
    "SPEECH_ENGINE_PUBLIC_URL",
    "SARA_SPEECH_ENGINE_ID",
    "MAYA_SPEECH_ENGINE_ID",
    "COLE_SPEECH_ENGINE_ID",
)


def _env_check() -> dict:
    """Summarize which env vars are set (values never exposed)."""
    required = {k: bool(os.getenv(k, "")) for k in _REQUIRED_ENV}
    speech_engine = {k: bool(os.getenv(k, "")) for k in _SPEECH_ENGINE_ENV}
    missing_required = [k for k, ok in required.items() if not ok]
    missing_speech = [k for k, ok in speech_engine.items() if not ok]
    playable = not missing_required
    live_voice = playable and not missing_speech
    if not playable:
        status = "missing_required"
    elif not live_voice:
        status = "degraded"
    else:
        status = "ok"
    return {
        "status": status,
        "platform": "vercel" if ON_VERCEL else ("railway" if ON_RAILWAY else "local"),
        "ready": {"playable": playable, "live_voice": live_voice},
        "elevenlabs": required["ELEVENLABS_API_KEY"],
        "groq": required["GROQ_API_KEY"],
        "speech_engine": {
            "public_url": speech_engine["SPEECH_ENGINE_PUBLIC_URL"],
            "sara": speech_engine["SARA_SPEECH_ENGINE_ID"],
            "maya": speech_engine["MAYA_SPEECH_ENGINE_ID"],
            "cole": speech_engine["COLE_SPEECH_ENGINE_ID"],
        },
        "missing": {
            "required": missing_required,
            "speech_engine": missing_speech,
        },
    }


def _log_env_check() -> None:
    check = _env_check()
    platform = check["platform"]
    if check["status"] == "ok":
        print(f"[Env] OK ({platform}) — playable + live voice ready")
        return
    if check["ready"]["playable"]:
        missing = ", ".join(check["missing"]["speech_engine"]) or "none"
        print(f"[Env] Degraded ({platform}) — playable, live voice incomplete: {missing}")
        return
    missing = ", ".join(check["missing"]["required"]) or "none"
    print(f"[Env] ERROR ({platform}) — missing required: {missing}")

_trailer_cache: dict = {}

ROOFTOP_EVIDENCE_AUDIO = {
    "audio_recorder": "couple_reveal",
    "memory_card": "missing_interval",
    "camera_panel": "unknown_man",
}

ROOFTOP_EVIDENCE_META = {
    "audio_recorder": {
        "source": "Rooftop / damaged audio recorder",
        "suspect": "MAYA",
    },
    "memory_card": {
        "source": "Rooftop / SD audio backup",
        "suspect": None,
    },
    "camera_panel": {
        "source": "Rooftop / wireless transmitter log",
        "suspect": None,
    },
}

# Rooftop review — don't reveal Cole before interviews / whiteboard
ROOFTOP_REVIEW_OVERRIDES = {
    "camera_panel": {
        "speaker": "UNKNOWN VOICE",
        "text": (
            "Daniel, the roof camera is unstable. Give me Maya's phone and the backup "
            "before this becomes a problem."
        ),
    },
    "memory_card": {
        "text": (
            "Why are you killing the feed? Maya already has the audio. "
            "You cannot erase both copies."
        ),
    },
}


def _rooftop_incident_track(evidence_key: str) -> Optional[dict]:
    """Map rooftop evidence to recovered incident audio from the whiteboard fragments."""
    track_key = ROOFTOP_EVIDENCE_AUDIO.get(evidence_key)
    if not track_key:
        return None
    fragment = next(
        (
            item
            for item in SCENES.get("audio_reconstruction", {}).get("fragments", [])
            if item.get("key") == track_key
        ),
        None,
    )
    if not fragment:
        return None
    meta = ROOFTOP_EVIDENCE_META.get(evidence_key, {})
    return {
        "key": fragment.get("key"),
        "label": fragment.get("label"),
        "speaker": fragment.get("speaker"),
        "voice_character": fragment.get("voice_character", "NARRATOR_MALE"),
        "text": fragment.get("text"),
        "source": meta.get("source", "Rooftop recovered audio"),
        "suspect": meta.get("suspect"),
    }


async def _rooftop_hotspot_payload(evidence_key: str) -> dict:
    """Metadata + TTS for recovered rooftop clips (review panel listen / case file)."""
    incident = _rooftop_incident_track(evidence_key)
    if not incident:
        return {"text": "", "audio_b64": None}
    overrides = ROOFTOP_REVIEW_OVERRIDES.get(evidence_key, {})
    text = overrides.get("text", incident.get("text", ""))
    speaker = overrides.get("speaker", incident.get("speaker"))
    char = incident.get("voice_character", "NARRATOR_MALE")
    audio_b64 = None
    if text:
        try:
            audio = await tts(text, char)
            audio_b64 = base64.b64encode(audio).decode()
        except Exception as e:
            print(f"[TTS] rooftop clip failed ({evidence_key}): {e}")
    return {
        "text": text,
        "audio_b64": audio_b64,
        "track_key": incident.get("key"),
        "label": incident.get("label"),
        "speaker": speaker,
        "source": incident.get("source"),
        "suspect": incident.get("suspect"),
        "voice_character": char,
    }

TRAILER_SCRIPT = (
    "Everyone remembers the fall. <break time=\"1.4s\" /> "
    "No one remembers the same moment. <break time=\"1.2s\" /> "
    "One frame was missed. <break time=\"1.1s\" /> "
    "One silence was kept. <break time=\"1.4s\" /> "
    "And before the night is over... <break time=\"1.0s\" /> "
    "someone will decide what the truth looks like. <break time=\"1.5s\" /> "
    "The Missing Angle."
)


CHOICE_DIRECTOR_PROMPT = """You are the voice choice director for an interactive murder investigation called "The Missing Angle".

The player is the lead detective speaking while the case is paused on an accusation decision.
Your job is to choose exactly one visible suspect option, or null if the player's words do not map to an option.

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
    _log_env_check()

    # Vercel filesystem is read-only except /tmp; pre-generated assets ship in git.
    if ON_VERCEL:
        print("[Startup] Vercel — skipping background media pre-generation")
        return

    asyncio.create_task(_pregen_all_scene_music())
    asyncio.create_task(_pregen_trailer_tts())


async def _pregen_trailer_tts():
    """Pre-generate trailer narration TTS and cache it in memory."""
    try:
        audio = await tts(TRAILER_SCRIPT, "TRAILER_NARRATOR")
        _trailer_cache["audio_b64"] = base64.b64encode(audio).decode()
        print("[Trailer] TTS pre-generated and cached")
    except Exception as e:
        print(f"[Trailer] TTS pre-gen failed: {e}")


async def _pregen_all_scene_music():
    """Generate missing ElevenLabs Music beds into static/music/."""
    from media_engine import generate_all_scene_music

    print("[Music] Checking scene + trailer beds (ElevenLabs Music API)...")
    try:
        results = await generate_all_scene_music(force=False)
        for name, ok in results.items():
            print(f"  {'✓' if ok else '✗'} {name}")
    except Exception as e:
        print(f"[Music] Pre-gen failed: {e}")


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
    await _send_scene_start(sink, SCENES["crime_scene"], sid)

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
        elif msg.get("type") == "scene_done":
            await _handle_scene_done(
                sink, sid, msg.get("scene_id", ""), msg.get("interview_log")
            )
        elif msg.get("type") == "dr_interrogate":
            await _handle_dr_interrogate_ws(sink, sid, msg)
        elif msg.get("type") == "restart":
            engine.reset_state(sid)
            await _send_scene_start(sink, SCENES["crime_scene"], sid)


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
    reload_scenes_if_needed()
    scene_id = scene.get("id")
    if scene_id and scene_id in SCENES:
        scene = SCENES[scene_id]

    if sid and scene.get("id"):
        engine.get_state(sid).current_scene = scene["id"]

    scene_type = scene.get("type", "video")
    payload = _scene_payload(scene)
    await sink.send({"type": "scene_start", "scene": payload})

    # ── Rooftop investigation scene ────────────────────────────────────────
    if scene_type == "investigation3d":
        guide_text = scene.get("guide_text", "")
        await sink.send({
            "type": "scene_investigation_setup",
            "id": scene.get("id", ""),
            "guide_text": guide_text,
            "guide_speaker": scene.get("guide_speaker", "DETECTIVE"),
            "guide_audio_b64": None,
        })
        return

    # ── Interrogation scene ──────────────────────────────────────────────────
    if scene_type == "interrogation":
        suspect       = scene.get("suspect", "SARA")
        opening_text  = scene.get("opening_line", "")
        guide_text    = scene.get("guide_text", "")
        guide_character = scene.get("guide_character", "NARRATOR_MALE")
        tts_tasks     = []
        labels        = []
        if opening_text:
            tts_tasks.append(tts(opening_text, suspect)); labels.append("opening")
        if guide_text:
            tts_tasks.append(tts(guide_text, guide_character)); labels.append("guide")
        results     = await asyncio.gather(*tts_tasks, return_exceptions=True) if tts_tasks else []
        raw_audios  = {labels[i]: r for i, r in enumerate(results)}
        audios      = {k: base64.b64encode(v).decode() if isinstance(v, bytes) else None
                       for k, v in raw_audios.items()}
        await sink.send({
            "type":                 "scene_interrogation_setup",
            "id":                   scene.get("id", ""),
            "suspect":              suspect,
            "guide_text":           guide_text,
            "guide_speaker":        scene.get("guide_speaker", "DETECTIVE"),
            "guide_audio_b64":      audios.get("guide"),
            "opening_line":         opening_text,
            "opening_audio_b64":    audios.get("opening"),
            "questions":            scene.get("questions", []),
            "evidence_reactions":   scene.get("evidence_reactions", {}),
            "atmosphere":           scene.get("atmosphere"),
            "suspect_video":        scene.get("suspect_video"),
            "video_disabled":       bool(scene.get("video_disabled")),
        })
        return

    # ── Recovered-audio reconstruction puzzle ───────────────────────────────
    if scene_type == "audio_reconstruction":
        guide_character = scene.get("guide_character", "NARRATOR_MALE")
        resolution = scene.get("resolution", "")
        fragments = scene.get("fragments", [])
        state = engine.get_state(sid) if sid else None
        brief = await _build_whiteboard_brief(state) if state else _default_whiteboard_brief()

        tasks = []
        labels = []
        for fragment in fragments:
            tasks.append(tts(fragment.get("text", ""), fragment.get("voice_character", "COLE")))
            labels.append(fragment.get("key", ""))
        if resolution:
            tasks.append(tts(resolution, guide_character))
            labels.append("resolution")
        results = await asyncio.gather(*tasks, return_exceptions=True) if tasks else []
        audio_by_key = {
            labels[i]: base64.b64encode(value).decode() if isinstance(value, bytes) else None
            for i, value in enumerate(results)
        }
        payload_fragments = [
            {**fragment, "audio_b64": audio_by_key.get(fragment.get("key", ""))}
            for fragment in fragments
        ]
        await sink.send({
            "type": "scene_audio_reconstruction_setup",
            "id": scene.get("id", ""),
            "closing_text": brief["closing_text"],
            "witness_insights": brief["witness_insights"],
            "fragments": payload_fragments,
            "resolution": resolution,
            "resolution_audio_b64": audio_by_key.get("resolution"),
        })
        return

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


async def _handle_voice_choice(sink: SessionSink, sid: str, audio: bytes, scene_id: str = ""):
    state = engine.get_state(sid)
    scene = _restore_scene(state, scene_id)
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

async def _handle_scene_done(
    sink: SessionSink, sid: str, scene_id: str, interview_log: Optional[dict] = None
):
    """Client finished a CCTV or interrogation scene; advance to the next."""
    state = engine.get_state(sid)
    if interview_log:
        _merge_interview_log(state, interview_log)
    scene = _restore_scene(state, scene_id)
    next_id = scene.get("advance_after")
    if not next_id or next_id not in SCENES:
        return
    state.current_scene = next_id
    await _send_scene_start(sink, SCENES[next_id], sid)


async def _handle_dr_interrogate_ws(sink: SessionSink, sid: str, msg: dict):
    """WebSocket handler for on-demand TTS: hotspot observation / question answer / evidence reaction."""
    scene_id  = msg.get("scene_id", "")
    req_type  = msg.get("action", "ask")    # "hotspot" | "ask" | "evidence"
    key       = msg.get("key", "")
    scene     = SCENES.get(scene_id, {})
    suspect   = scene.get("suspect", "SARA")

    text = ""
    char = "NARRATOR_MALE"

    if req_type == "hotspot" and scene_id == "rooftop_investigation":
        payload = await _rooftop_hotspot_payload(key)
        await sink.send({
            "type":          "interrogation_answer",
            "question_key":  key,
            **payload,
        })
        return

    if req_type == "hotspot":
        incident = None
        text = ""
        char = "NARRATOR_MALE"
    elif req_type == "ask":
        payload = await _interrogation_ask_reply(scene, key)
        if not payload:
            await sink.send({"type": "interrogation_answer", "question_key": key, "text": "", "audio_b64": None})
            return
        reply = await _tts_reply_payload(
            payload["text"],
            payload["char"],
            cracks=payload.get("cracks", False),
            cracks_status=payload.get("cracks_status"),
            unlocks_evidence=payload.get("unlocks_evidence"),
        )
        _record_interview_reply(engine.get_state(sid), payload["char"], payload["text"])
        await sink.send({"type": "interrogation_answer", "question_key": key, **reply})
        return
    elif req_type == "evidence":
        payload = await _interrogation_evidence_reply(scene, key)
        text = payload["text"]
        char = payload["char"]
        _record_interview_reply(engine.get_state(sid), char, text)

    if not text:
        await sink.send({"type": "interrogation_answer", "question_key": key, "text": "", "audio_b64": None})
        return

    audio_b64 = None
    try:
        audio     = await tts(text, char)
        audio_b64 = base64.b64encode(audio).decode()
    except Exception as e:
        print(f"[TTS] dr interrogate failed: {e}")
    await sink.send({
        "type":          "interrogation_answer",
        "question_key":  key,
        "text":          text,
        "audio_b64":     audio_b64,
        **({
            "track_key": incident.get("key"),
            "label": incident.get("label"),
            "speaker": incident.get("speaker"),
            "source": incident.get("source"),
            "suspect": incident.get("suspect"),
        } if req_type == "hotspot" and 'incident' in locals() and incident else {}),
    })


def _branch_options(scene: dict) -> list:
    """Return the visible case-decision options for the current scene."""
    options = []
    for key, branch in scene.get("branches", {}).items():
        label = branch.get("label", key)
        display = label.split("/")[0].strip().title()
        options.append({"key": key, "display": display})
    return options


def _decision_prompt(scene: dict) -> str:
    return scene.get("decision_prompt") or "Your case is ready. Who should be charged?"


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
                        "detective_said": transcript,
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
        "third": 2, "three": 2, "option three": 2,
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


async def _groq_interrogation_answer(suspect: str, question: str, story_context: str) -> str:
    """Generate an in-character answer to a scripted detective question via Groq."""
    system_prompt = character_system_prompt(suspect)
    instruction = (
        f"The detective is asking you: \"{question}\"\n"
        "Answer in character. Be truthful to your knowledge but guard what you're hiding. "
        "1–3 sentences (~35–50 words). Speak like a real person under pressure — no lists, no numbering. "
        "Spoken dialogue only — no stage directions or emotion tags. "
        "Never ask the detective questions — only answer."
        + (
            " Sound nervous and defensive — like you're protecting yourself without rambling."
            if suspect == "COLE"
            else ""
        )
        + (
            f"\n\nPrivate story knowledge (never quote verbatim — paraphrase naturally in your own words): {story_context}"
            if story_context
            else ""
        )
    )
    try:
        client = _groq()
        response = await client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": instruction},
            ],
            temperature=0.92 if suspect == "COLE" else 0.85,
            max_tokens=120,
        )
        return clean_spoken_reply(response.choices[0].message.content.strip())
    except Exception as e:
        print(f"[Groq] interrogation answer failed: {e}")
        return ""


WHITEBOARD_CLOSING = (
    "We've reached the end of the investigation. "
    "The evidence you collected is on the left — cross-check it with what each witness told you."
)

WITNESS_SCENE_IDS = {
    "SARA": "sara_interview_1",
    "MAYA": "maya_interview_1",
    "COLE": "cole_interview_1",
}


def _record_interview_reply(state, suspect: str, text: str) -> None:
    text = clean_spoken_reply((text or "").strip())
    if not text:
        return
    name = (suspect or "").upper()
    if name not in state.interview_replies:
        return
    if state.interview_replies[name] and state.interview_replies[name][-1] == text:
        return
    state.interview_replies[name].append(text)
    if len(state.interview_replies[name]) > 12:
        state.interview_replies[name] = state.interview_replies[name][-12:]


def _merge_interview_log(state, log: dict) -> None:
    if not isinstance(log, dict):
        return
    for name, lines in log.items():
        key = (name or "").upper()
        if key not in state.interview_replies or not isinstance(lines, list):
            continue
        for line in lines:
            _record_interview_reply(state, key, str(line))


def _question_canon_hint(q: dict) -> str:
    """Story facts for Groq context — never returned verbatim to the player."""
    return (q.get("canon_hint") or "").strip()


def _canon_witness_hints() -> dict[str, str]:
    hints: dict[str, str] = {}
    for name, scene_id in WITNESS_SCENE_IDS.items():
        scene = SCENES.get(scene_id, {})
        parts = []
        for q in scene.get("questions", []):
            hint = _question_canon_hint(q)
            if hint:
                parts.append(hint)
        hints[name] = " ".join(parts[:2])
    return hints


def _default_whiteboard_brief() -> dict:
    return {
        "closing_text": WHITEBOARD_CLOSING,
        "witness_insights": {
            "SARA": "Sara framed the rooftop party as a business celebration and was careful about Maya and Daniel.",
            "MAYA": "Maya admitted the relationship under pressure and tied Daniel's phone to proof about Cole.",
            "COLE": "Cole dismissed the camera override and denied any link to Daniel's recording.",
        },
    }


async def _groq_witness_insights(replies: dict[str, list[str]]) -> dict[str, str]:
    canon = _canon_witness_hints()
    blocks = []
    for name in ("SARA", "MAYA", "COLE"):
        lines = replies.get(name) or []
        if lines:
            quoted = "\n".join(f'  - "{line}"' for line in lines[-8:])
            blocks.append(f"{name} — their actual interview replies:\n{quoted}")
        elif canon.get(name):
            blocks.append(f"{name} — no live replies recorded; story context only:\n  {canon[name]}")
        else:
            blocks.append(f"{name} — no interview replies recorded.")

    prompt = (
        "You are briefing a detective at the evidence board after three witness interviews.\n\n"
        + "\n\n".join(blocks)
        + "\n\nReturn JSON only with keys SARA, MAYA, COLE. "
        "Each value is ONE sentence (max 28 words) summarizing that witness's key claim or deflection "
        "based ONLY on their listed replies — do not invent facts. "
        "Detective note style. No questions. No stage directions."
    )
    try:
        client = _groq()
        response = await client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.4,
            max_tokens=220,
            response_format={"type": "json_object"},
        )
        raw = json.loads(response.choices[0].message.content)
        return {
            name: clean_spoken_reply(str(raw.get(name, "")).strip())
            for name in ("SARA", "MAYA", "COLE")
        }
    except Exception as e:
        print(f"[Groq] witness insights failed: {e}")
        fallback = _default_whiteboard_brief()["witness_insights"]
        result = {}
        for name in ("SARA", "MAYA", "COLE"):
            lines = replies.get(name) or []
            if lines:
                result[name] = clean_spoken_reply(lines[-1])
            else:
                result[name] = fallback[name]
        return result


async def _build_whiteboard_brief(state) -> dict:
    insights = await _groq_witness_insights(state.interview_replies)
    for name in ("SARA", "MAYA", "COLE"):
        if not insights.get(name):
            insights[name] = _default_whiteboard_brief()["witness_insights"][name]
    return {"closing_text": WHITEBOARD_CLOSING, "witness_insights": insights}


async def _interrogation_ask_reply(scene: dict, question_key: str) -> Optional[dict]:
    """Groq-generated reply for a scripted interview question."""
    suspect = scene.get("suspect", "SARA")
    q = next((item for item in scene.get("questions", []) if item["key"] == question_key), None)
    if not q:
        return None
    detective_question = q.get("cole_asks", "")
    canon = _question_canon_hint(q)
    context = canon
    groq_text = await _groq_interrogation_answer(suspect, detective_question, context)
    if not groq_text:
        groq_text = await _out_of_scope_reply(suspect, detective_question)
    return {
        "text": groq_text,
        "char": suspect,
        "cracks": q.get("cracks", False),
        "cracks_status": q.get("cracks_status"),
        "unlocks_evidence": q.get("unlocks_evidence"),
    }


async def _interrogation_evidence_reply(scene: dict, evidence_key: str) -> dict:
    """Groq-generated reaction when the detective presents evidence."""
    suspect = scene.get("suspect", "SARA")
    reactions = scene.get("evidence_reactions", {})
    canon = (reactions.get(evidence_key) or "").strip()
    label = evidence_key.replace("_", " ")
    prompt = f"The detective is showing you this evidence: {label}."
    groq_text = await _groq_interrogation_answer(suspect, prompt, canon)
    if not groq_text:
        groq_text = await _out_of_scope_reply(suspect, prompt)
    return {"text": groq_text, "char": suspect}


async def _tts_reply_payload(text: str, char: str, **extra) -> dict:
    audio_b64 = None
    if text:
        try:
            audio = await tts(text, char)
            audio_b64 = base64.b64encode(audio).decode()
        except Exception as e:
            print(f"[TTS] reply failed: {e}")
    return {"text": text, "audio_b64": audio_b64, **extra}


async def _out_of_scope_reply(suspect: str, detective_said: str) -> str:
    """Generate a natural in-character deflection when detective asks something outside scripted questions."""
    system_prompt = character_system_prompt(suspect)
    deflect_instruction = (
        "The detective just asked you something you either can't answer or won't answer right now. "
        "Respond in character with a brief deflection — 1–2 short sentences (~18–28 words). "
        "Vary your wording: redirect ('that's not relevant'), limit what you'll share ('I've told you what I know'), "
        "or push back without asking a question ('I'm not getting into that'). "
        "Do NOT say 'I don't understand' or give generic help-desk rejections. Stay fully in character. "
        "Spoken dialogue only — no stage directions or emotion tags. Never ask the detective questions."
    )
    for attempt in range(2):
        try:
            client = _groq()
            response = await client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[
                    {"role": "system", "content": system_prompt + "\n\n" + deflect_instruction},
                    {"role": "user", "content": detective_said},
                ],
                temperature=0.95 if attempt else 0.88,
                max_tokens=70,
            )
            text = clean_spoken_reply(response.choices[0].message.content.strip())
            if text:
                return text
        except Exception as e:
            print(f"[Groq] out-of-scope reply failed (attempt {attempt + 1}): {e}")
    return ""


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
        "type":               scene.get("type", "video"),
        "atmosphere":         scene.get("atmosphere", "default"),
        "still_image":        scene.get("still_image"),
        "characters_present": scene.get("characters_present", []),
        "pause_at":           scene.get("pause_at"),
        "is_ending":          scene.get("is_ending", False),
        "ending_type":        scene.get("ending_type", ""),
        "has_narration":      bool(scene.get("narration") and _should_narrate(scene)),
        "auto_advance":       scene.get("auto_advance") or None,
        "advance_after":      scene.get("advance_after") or None,
        "story_card":         scene.get("story_card") or None,
    }


def _should_narrate(scene: dict) -> bool:
    return bool(scene.get("narration"))


# ── REST ───────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    check = _env_check()
    if not check["ready"]["playable"]:
        return Response(
            content=json.dumps(check),
            status_code=503,
            media_type="application/json",
        )
    return check

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
            audio_b64 = base64.b64encode(await tts(TRAILER_SCRIPT, "TRAILER_NARRATOR")).decode()
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
    interview_log: Optional[dict] = None


class JumpBody(BaseModel):
    session_id: Optional[str] = None
    scene_id: str


class ChoiceBody(BaseModel):
    session_id: str
    branch_key: str
    text: str = ""
    scene_id: str = ""   # same — lets server restore scene without in-memory state


def _restore_scene(state, scene_id: str) -> dict:
    """Use scene_id from request when available; fall back to engine state."""
    reload_scenes_if_needed()
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
    await _send_scene_start(sink, SCENES["crime_scene"], sid)
    return _http_payload(sid, sink)


@app.post("/api/game/jump")
async def http_game_jump(body: JumpBody):
    """Start or move a session directly to a scene, used by splash shortcuts."""
    if body.scene_id not in SCENES:
      raise HTTPException(400, f"Unknown scene '{body.scene_id}'")
    sid = body.session_id or str(uuid.uuid4())
    engine.reset_state(sid)
    sink = SessionSink()
    await _send_scene_start(sink, SCENES[body.scene_id], sid)
    return _http_payload(sid, sink)


@app.post("/api/game/advance")
async def http_game_advance(body: SessionIdBody):
    """Continue after an auto-advance scene."""
    state = engine.get_state(body.session_id)
    scene = _restore_scene(state, body.scene_id)
    next_id = scene.get("auto_advance") or scene.get("advance_after")
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
async def http_game_voice(session_id: str = Form(...), file: UploadFile = File(...), scene_id: str = Form("")):
    sink = SessionSink()
    audio = await file.read()
    await _handle_voice_choice(sink, session_id, audio, scene_id)
    return _http_payload(session_id, sink)


@app.post("/api/game/restart")
async def http_game_restart(body: SessionIdBody):
    sink = SessionSink()
    engine.reset_state(body.session_id)
    await _send_scene_start(sink, SCENES["crime_scene"], body.session_id)
    return _http_payload(body.session_id, sink)


@app.post("/api/game/scene_done")
async def http_scene_done(body: SessionIdBody):
    """Client finished a CCTV or interrogation scene; advance to next."""
    state = engine.get_state(body.session_id)
    if body.interview_log:
        _merge_interview_log(state, body.interview_log)
    scene = _restore_scene(state, body.scene_id)
    next_id = scene.get("advance_after")
    if not next_id or next_id not in SCENES:
        raise HTTPException(400, f"No advance_after for scene '{body.scene_id}'")
    state.current_scene = next_id
    sink = SessionSink()
    await _send_scene_start(sink, SCENES[next_id], body.session_id)
    return _http_payload(body.session_id, sink)


class InterrogateBody(BaseModel):
    session_id: str
    scene_id:   str = ""
    type:       str = "ask"    # "hotspot" | "ask" | "evidence"
    key:        str = ""


@app.post("/api/game/interrogate")
async def http_interrogate(body: InterrogateBody):
    """On-demand TTS for CCTV hotspot observations, interrogation answers, evidence reactions."""
    scene   = SCENES.get(body.scene_id, {})
    suspect = scene.get("suspect", "SARA")
    text    = ""
    char    = "NARRATOR_MALE"
    extra   = {}

    if body.type == "hotspot" and body.scene_id == "rooftop_investigation":
        payload = await _rooftop_hotspot_payload(body.key)
        return payload

    if body.type == "hotspot":
        incident = None
        text = ""
        char = "NARRATOR_MALE"
        extra = {}
    elif body.type == "ask":
        payload = await _interrogation_ask_reply(scene, body.key)
        if not payload:
            raise HTTPException(404, f"Question '{body.key}' not found in scene '{body.scene_id}'")
        reply = await _tts_reply_payload(
            payload["text"],
            payload["char"],
            cracks=payload.get("cracks", False),
            cracks_status=payload.get("cracks_status"),
            unlocks_evidence=payload.get("unlocks_evidence"),
        )
        _record_interview_reply(engine.get_state(body.session_id), payload["char"], payload["text"])
        return reply
    elif body.type == "evidence":
        payload = await _interrogation_evidence_reply(scene, body.key)
        text = payload["text"]
        char = payload["char"]
        _record_interview_reply(engine.get_state(body.session_id), char, text)
        extra = {}

    if not text:
        return {"text": "", "audio_b64": None, **extra}

    audio_b64 = None
    try:
        audio     = await tts(text, char)
        audio_b64 = base64.b64encode(audio).decode()
    except Exception as e:
        print(f"[TTS] interrogate failed: {e}")

    return {"text": text, "audio_b64": audio_b64, **extra}


# ── Static / frontend ──────────────────────────────────────────────────────

app.mount("/static", CachedStaticFiles(directory=str(ROOT / "static")), name="static")
app.mount("/world", CachedStaticFiles(directory=str(ROOT / "3d")), name="world")

@app.get("/")
def index():          return FileResponse(ROOT / "frontend/index.html")

# Deep links for puzzle "pages" (served by same SPA).
@app.get("/puzzles/{slug}")
def puzzles(slug: str): return FileResponse(ROOT / "frontend/index.html")

@app.get("/app.js")
def js():             return FileResponse(ROOT / "frontend/app.js")
@app.get("/style.css")
def css():            return FileResponse(ROOT / "frontend/style.css")
@app.get("/detective-room.js")
def dr_js():          return FileResponse(ROOT / "frontend/detective-room.js")
@app.get("/rooftop-investigation.js")
def ri_js():          return FileResponse(ROOT / "static/rooftop-investigation.js")


# ── Speech Engine endpoints ────────────────────────────────────────────────
# ElevenLabs calls /ws/sara, /ws/maya, or /ws/cole when a browser starts a session.
# The browser gets a WebRTC session token from /api/speech-engine/token first.

@app.websocket("/ws/{character}")
async def speech_engine_ws(ws: WebSocket, character: str):
    char = character.upper()
    server = SPEECH_ENGINE_SERVERS.get(char)
    auth_header = ws.headers.get("x-elevenlabs-speech-engine-authorization", "")
    if not server or not ELEVENLABS_API_KEY:
        await ws.close(code=1008)
        return
    try:
        verify_speech_engine_jwt(auth_header, ELEVENLABS_API_KEY)
    except ValueError:
        await ws.close(code=1008)
        return
    await ws.accept()
    session = server.handle_connection(ws)
    await session.run()


@app.get("/api/speech-engine/token")
async def speech_engine_token(character: str = "SARA"):
    """Return a browser-safe WebRTC token for a Speech Engine character."""
    char = character.upper()
    if char not in SPEECH_ENGINE_SERVERS:
        raise HTTPException(status_code=404, detail=f"Unknown character: {char}")
    if ON_VERCEL:
        raise HTTPException(
            status_code=503,
            detail="Speech Engine requires a persistent WebSocket backend; deploy this FastAPI app on a WebSocket-capable service.",
        )
    if not ELEVENLABS_API_KEY:
        raise HTTPException(status_code=503, detail="ELEVENLABS_API_KEY is not configured.")
    speech_engine_id = os.getenv(f"{char}_SPEECH_ENGINE_ID", "")
    if not speech_engine_id:
        raise HTTPException(
            status_code=503,
            detail=f"Speech Engine not configured for {char}. Run setup_speech_engines.py first.",
        )
    from elevenlabs import AsyncElevenLabs
    client = AsyncElevenLabs(api_key=ELEVENLABS_API_KEY)
    result = await client.conversational_ai.conversations.get_webrtc_token(
        agent_id=speech_engine_id
    )
    return {"conversation_token": result.token, "character": char}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
