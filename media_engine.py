"""
Pruna AI integration — scene image generation + character avatar lip-sync video.

Cost estimate (one-time with disk cache):
  31 scene atmospheres × $0.005  = $0.155
  3 character portraits × $0.005 = $0.015
  ─────────────────────────────────────────
  Total image cost:                $0.17  (charged once, cached to disk forever)

  Avatar video (per demo session, ~20 responses × 5s avg):
  20 × 5s × $0.025               = $2.50 per full playthrough
"""

import asyncio
import base64
import hashlib
import os
import pathlib
import time
from typing import Optional

import httpx

PRUNA_BASE = "https://api.pruna.ai/v1"
PRUNA_KEY  = lambda: os.getenv("PRUNA_API_KEY", "")

SIMLI_BASE = "https://api.simli.ai"
SIMLI_KEY  = lambda: os.getenv("SIMLI_API_KEY", "")

ELEVEN_BASE = "https://api.elevenlabs.io/v1"
ELEVEN_KEY  = lambda: os.getenv("ELEVENLABS_API_KEY", "")

# Disk cache directory — images persist across server restarts (never re-charged)
CACHE_DIR = pathlib.Path(__file__).parent / "static" / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

MUSIC_DIR = pathlib.Path(__file__).parent / "static" / "music"
MUSIC_DIR.mkdir(parents=True, exist_ok=True)

# In-memory caches
_scene_image_cache: dict[str, str] = {}   # atmosphere → base64 JPEG
_portrait_cache:    dict[str, str] = {}   # character → base64 JPEG
_avatar_video_cache:dict[str, str] = {}   # hash → base64 MP4
_simli_face_ids:    dict[str, str] = {}   # character → Simli faceId


def _disk_key(prefix: str, key: str) -> pathlib.Path:
    safe = hashlib.md5(key.encode()).hexdigest()
    return CACHE_DIR / f"{prefix}_{safe}.jpg"


def _load_from_disk(path: pathlib.Path) -> Optional[str]:
    if path.exists():
        return base64.b64encode(path.read_bytes()).decode()
    return None


def _save_to_disk(path: pathlib.Path, b64: str):
    path.write_bytes(base64.b64decode(b64))


def _headers(extra: dict = None) -> dict:
    h = {
        "apikey": PRUNA_KEY(),
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


# ── File upload ───────────────────────────────────────────────────────────

async def upload_file(data: bytes, filename: str, mime: str) -> str:
    """Upload bytes to Pruna file storage. Returns the full file URL."""
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{PRUNA_BASE}/files",
            headers={"apikey": PRUNA_KEY()},
            files={"files": (filename, data, mime)},
        )
        resp.raise_for_status()
        result = resp.json()
        # API returns {"files": [{"id": "file-xxx", "url": "https://api.pruna.ai/v1/files/file-xxx"}]}
        files = result.get("files") or result.get("data") or []
        if files:
            f = files[0]
            # Always return the full URL — Pruna prediction input requires the URL form
            return f.get("url") or f"{PRUNA_BASE}/files/{f.get('id', '')}"
        fid = result.get("id", "")
        return result.get("url") or f"{PRUNA_BASE}/files/{fid}"


# ── Async job polling ─────────────────────────────────────────────────────

async def poll_job(job_id: str, get_url: str, timeout: float = 90) -> dict:
    """Poll a Pruna async job until succeeded or failed."""
    deadline = time.time() + timeout
    async with httpx.AsyncClient(timeout=15) as client:
        while time.time() < deadline:
            resp = await client.get(
                f"{PRUNA_BASE}/predictions/status/{job_id}",
                headers={"apikey": PRUNA_KEY()},
            )
            if resp.status_code != 200:
                await asyncio.sleep(2)
                continue
            data = resp.json()
            status = data.get("status", "")
            if status == "succeeded":
                return data
            if status in ("failed", "error", "cancelled"):
                raise RuntimeError(f"Pruna job {job_id} failed: {data}")
            await asyncio.sleep(2)
    raise TimeoutError(f"Pruna job {job_id} timed out after {timeout}s")


async def download_result_bytes(delivery_path: str) -> bytes:
    """Download output bytes from a completed Pruna job."""
    url = f"{PRUNA_BASE}/predictions/delivery/{delivery_path}"
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        resp = await client.get(url, headers={"apikey": PRUNA_KEY()})
        resp.raise_for_status()
        return resp.content


# ── Scene image generation ────────────────────────────────────────────────

async def _pruna_generate_image(prompt: str, aspect_ratio: str) -> Optional[str]:
    """Shared Pruna p-image call. Returns base64 JPEG or None."""
    async with httpx.AsyncClient(timeout=45) as client:
        resp = await client.post(
            f"{PRUNA_BASE}/predictions",
            headers={**_headers(), "Model": "p-image", "Try-Sync": "true"},
            json={"input": {"prompt": prompt, "aspect_ratio": aspect_ratio}},
        )
        resp.raise_for_status()
        data = resp.json()

        output_url = None
        if data.get("status") == "succeeded":
            output_url = data.get("output") or data.get("generation_url")
        elif data.get("id"):
            result = await poll_job(data["id"], data.get("get_url", ""))
            output_url = result.get("output") or result.get("generation_url")

        if output_url:
            img_resp = await client.get(output_url, headers={"apikey": PRUNA_KEY()})
            return base64.b64encode(img_resp.content).decode()
    return None


ARIA   = "woman in her late 30s, dark hair pulled back, dark technical station uniform"
MARCUS = "East Asian man in his early 40s, short dark hair, stubble, dark work jacket"
VERA   = "woman in her mid 40s, dark hair, calm unreadable expression, dark clothing"
STYLE  = "cinematic 35mm film still, photorealistic, dramatic lighting, shallow depth of field, 16:9 widescreen"

# ── The Missing Angle — scene image prompts ──────────────────────────────────
_SARA_P  = "woman in her late 20s, dark brown hair loosely pulled back, sharp worried eyes, dark grey t-shirt"
_COLE_P  = "man in his early 40s, short dark hair slight grey at temples, dark charcoal suit, calm unreadable expression"
_MAYA_P  = "woman in her mid 20s, natural curly dark hair, red-rimmed eyes, dark jacket, raw with grief"
_W_STYLE = "cinematic 35mm film still, photorealistic, dramatic noir lighting, shallow depth of field, modern urban thriller, teal and amber color grade, 16:9 widescreen"

SCENE_IMAGE_PROMPTS = {
    # ── The Missing Angle ───────────────────────────────────────────────────
    "intro":                f"{_W_STYLE}, close-up of a smartphone on a bedside table, 7am blue-grey morning light, unread messages glowing on screen, a hand reaching for it, dread in the stillness",
    "sara_calls":           f"{_W_STYLE}, {_SARA_P} pressed to an apartment wall, phone to her ear, backlit from a window, speaking quietly, afraid of being overheard",
    "detective_arrives":    f"{_W_STYLE}, {_COLE_P} standing in a doorway holding a notepad, shot from inside looking out, soft morning light behind him, polite and immovable",
    "cole_pushes":          f"{_W_STYLE}, {_COLE_P} at a small kitchen table, sliding a printed photograph across it, single overhead lamp, deliberate and still",
    "cole_follows_up":      f"{_W_STYLE}, {_COLE_P} across a narrow table, notebook open pen down, single lamp overhead, waiting for you to speak, patient pressure",
    "sara_comes_over":      f"{_W_STYLE}, {_SARA_P} standing at an apartment door, desperate, slightly out of breath, dark hallway behind her, she ran here",
    "sara_reveals":         f"{_W_STYLE}, {_SARA_P} sitting on a couch edge, face half in shadow, window light cutting across the room, hands clasped, quiet confession",
    "maya_calls":           f"{_W_STYLE}, {_MAYA_P} sitting on a low wall outside a building, phone pressed to ear, shot from across the street with long lens, grief and urgency",
    "ending_complicit":     f"{_W_STYLE}, empty city park path, autumn leaves, {_SARA_P} walking away in the distance, back to camera, she does not look back",
    "ending_witness":       f"{_W_STYLE}, police station exterior at dawn, glass doors, cold clean light, the moment before walking in, threshold",
    "ending_witness_broken":f"{_W_STYLE}, {_COLE_P} at a desk, pen on paper not writing, looking slightly away, overhead light, the weight of what was just said",
    "ending_witness_doubt": f"{_W_STYLE}, police station corridor, a glass door swinging closed, a silhouette visible through frosted glass walking away free, ambiguous light",
    "ending_truth":         f"{_W_STYLE}, {_SARA_P} and a silhouette walking side by side toward a glass building entrance, morning light, small and determined, backs to camera",
    "ending_truth_together":f"{_W_STYLE}, three figures walking together toward a lit glass entrance at dawn, backs to camera, deliberate unified pace, long lens shot",
    "ending_betrayal":      f"{_W_STYLE}, {_SARA_P} in a courtroom, turned slightly toward camera, quiet betrayal in her expression, cold fluorescent light, foreground blurred",
    "ending_alone":         f"{_W_STYLE}, dark apartment interior, phone face-down on a table, single lamp, the room after someone just left, nobody there",
    # ── Legacy sci-fi atmospheres (unused by the current story) ──────────────
    "space_station":      f"{STYLE}, wide shot of deep space station control room, 3am, {ARIA} hunched over a workstation studying signal data on glowing monitors, blue light, back to camera, tense posture",
    "ai_core":            f"{STYLE}, {ARIA} walks down a narrow server corridor, cold blue rack lighting on both sides, seen from behind, deliberate pace, searching",
    "ai_core_red":        f"{STYLE}, {MARCUS} sprints through a server room bathed in red emergency light, blurred motion, hand on wall for balance, alarm strobing",
    "ai_core_white":      f"{STYLE}, {ARIA} stands with arms crossed examining dark server panels, white clinical light, side profile, tense, something is wrong",
    "lab_green":          f"{STYLE}, {ARIA} leans over a glowing research terminal in a dark lab, green data cascading on screens surrounding her, night, absorbed",
    "morning_amber":      f"{STYLE}, long station corridor, warm amber morning light through porthole windows, silhouette of {ARIA} walking purposefully away from camera",
    "corridor_harsh":     f"{STYLE}, {MARCUS} strides down a white corridor under harsh fluorescent light, seen from behind, urgency in his step, head slightly turned",
    "corridor_white":     f"{STYLE}, {ARIA} and {MARCUS} standing in a sterile corridor from side angle, dramatic overhead light casting hard shadows, neither moving, standoff",
    "corridor_orange":    f"{STYLE}, motion-blur chase shot through industrial corridor, {ARIA} running hard, orange emergency strip lighting, handheld energy",
    "corridor_cold":      f"{STYLE}, {MARCUS} walks slowly through a cold blue-lit corridor, hands in pockets, shot from the side, the weight of something unseen",
    "conference_cold":    f"{STYLE}, dark conference room, one overhead light, {ARIA} and {MARCUS} sit across from an empty chair, both staring at it, tension",
    "transmission_purple":f"{STYLE}, monitor screen close-up in a dark room, {VERA}'s face partially visible through purple encrypted static interference, mysterious",
    "transmission_white": f"{STYLE}, {VERA} sits at a transmission terminal, bright white light from behind, calm expression, filmed from a slight low angle, composed",
    "dark_lab":           f"{STYLE}, dark lab, only screen glow visible, {ARIA} rapidly typing, looking over her shoulder toward the door, caught doing something",
    "dark_station":       f"{STYLE}, {MARCUS} pressed against a dark station corridor wall, single emergency light ahead, peering around corner, afraid",
    "cosmic_purple":      f"{STYLE}, vast signal visualization chamber, purple nebula data filling walls, {ARIA} small against it, arms at sides, overwhelmed by scale",
    "cosmic_red":         f"{STYLE}, {MARCUS} grips a console as red data cascades on screens behind him, shot from side, desperation in posture",
    "cosmic_alone":       f"{STYLE}, lone figure at porthole, vast deep space outside, one distant star, shot from behind, profound solitude, silence",
    "red_alert":          f"{STYLE}, {MARCUS} running through strobing red corridor, smoke in air, alarm lights, motion blur, chaos",
    "server_room_red":    f"{STYLE}, {ARIA} at a terminal in a dark server room, red lights blinking, deletion progress bar on screen behind her, still, resolute",
    "split_screen_chaos": f"{STYLE}, {ARIA} standing between two monitors showing conflicting data, caught mid-turn, disbelief on her face, side profile",
    "interrogation":      f"{STYLE}, empty interrogation room, harsh bare bulb overhead, metal table, single chair, door slightly open, someone about to enter",
    "interrogation_grey": f"{STYLE}, {MARCUS} sits on a concrete bench in a grey cell, small window with bars, light shifting, hands clasped, waiting",
    "escape_orange":      f"{STYLE}, maintenance tunnel, low ceiling, {ARIA} crouching through tight passage, orange hazard lights, urgent claustrophobic energy",
    "bunker_amber":       f"{STYLE}, underground bunker, amber tactical light, {VERA} standing at an old console surrounded by equipment, back three-quarters to camera",
    "station_warm":       f"{STYLE}, station break room, warm light, {ARIA} and {MARCUS} at a small table with coffee, window to space behind them, a rare quiet moment",
    "white_void":         f"{STYLE}, {ARIA} stands alone in an overexposed white room, a single chair, long shot, existential stillness, hard shadows on floor",
    "empty_corridor":     f"{STYLE}, long corridor receding to vanishing point, {ARIA} walking away, back to camera, she does not look back, cinematic",
    "ending_gold":        f"{STYLE}, space station porthole, golden sunrise over Earth below filling the frame, silhouette of a figure standing at the glass",
    "ending_blue":        f"{STYLE}, airlock interior, cold blue deep space through the window, the station visible receding, figure seated alone, back to camera",
    "default":            f"{STYLE}, dark deep space station corridor, dramatic lighting ahead, atmospheric, cinematic",
}


async def generate_scene_image(atmosphere: str, scene_title: str) -> Optional[str]:
    """Generate a scene background image. Returns base64 JPEG string or None.
    Results are cached to disk — Pruna is only called once per unique atmosphere."""
    if not PRUNA_KEY():
        return None

    cache_key = atmosphere  # atmosphere is the unique key (title varies, vibe is same)
    if cache_key in _scene_image_cache:
        return _scene_image_cache[cache_key]

    # Check disk cache first — completely free after first run
    disk_path = _disk_key("scene", cache_key)
    cached = _load_from_disk(disk_path)
    if cached:
        _scene_image_cache[cache_key] = cached
        return cached

    prompt_base = SCENE_IMAGE_PROMPTS.get(atmosphere, SCENE_IMAGE_PROMPTS["default"])
    prompt = f"{prompt_base}, title: {scene_title}"

    try:
        b64 = await _pruna_generate_image(prompt, "16:9")
        if b64:
            _scene_image_cache[cache_key] = b64
            _save_to_disk(disk_path, b64)
            return b64
    except Exception as e:
        print(f"[Pruna] Scene image failed for {atmosphere}: {e}")
    return None


# ── Character portrait generation ─────────────────────────────────────────

from characters import CHARACTERS as _CHARACTERS
CHARACTER_PORTRAIT_PROMPTS = {name: c["portrait_prompt"] for name, c in _CHARACTERS.items()}


AVATARS_DIR = pathlib.Path(__file__).parent / "static" / "avatars"
AVATARS_DIR.mkdir(parents=True, exist_ok=True)


def _save_portrait_for_frontend(character_name: str, b64: str):
    """Save portrait to static/avatars/<name>_portrait.jpg for direct frontend access."""
    path = AVATARS_DIR / f"{character_name.lower()}_portrait.jpg"
    if not path.exists():
        path.write_bytes(base64.b64decode(b64))


async def generate_character_portrait(character_name: str) -> Optional[str]:
    """Generate and cache a character portrait. Returns base64 JPEG or None.
    Cached to disk — only called once ever per character."""
    if not PRUNA_KEY():
        return None

    if character_name in _portrait_cache:
        _save_portrait_for_frontend(character_name, _portrait_cache[character_name])
        return _portrait_cache[character_name]

    disk_path = _disk_key("portrait", character_name)
    cached = _load_from_disk(disk_path)
    if cached:
        _portrait_cache[character_name] = cached
        _save_portrait_for_frontend(character_name, cached)
        return cached

    prompt = CHARACTER_PORTRAIT_PROMPTS.get(character_name, "cinematic portrait, dramatic lighting, photorealistic, 1:1")

    try:
        b64 = await _pruna_generate_image(prompt, "1:1")
        if b64:
            _portrait_cache[character_name] = b64
            _save_to_disk(disk_path, b64)
            _save_portrait_for_frontend(character_name, b64)
            return b64
    except Exception as e:
        print(f"[Pruna] Portrait failed for {character_name}: {e}")
    return None


# ── Emotion → video_prompt mapping ───────────────────────────────────────

_EMOTION_VIDEO_PROMPTS = {
    "afraid":    "wide frightened eyes, trembling expression, desperate urgent energy, slight body tremor",
    "tense":     "tense jaw, controlled hard stare, barely suppressed emotion",
    "desperate": "desperate pleading expression, raw vulnerability, trembling lip",
    "hopeful":   "gentle hopeful eyes, soft open expression, slight warmth",
    "angry":     "barely contained anger, clenched jaw, intense burning stare",
    "sad":       "sorrowful downcast eyes, quiet grief, still composure",
    "calm":      "composed professional expression, minimal movement, steady gaze",
    "suspicious":"narrowed skeptical eyes, slight chin tilt, reading the room",
    "betrayed":  "hurt disbelief in eyes, searching expression, quiet devastation",
    "resolved":  "firm determined chin-up expression, clear direct gaze",
    "neutral":   "natural steady engagement, attentive expression",
}

_CHAR_DEFAULT_VIDEO_PROMPT = {
    "SARA": "slight natural body movement, subtle emotional expression",
    "COLE": "minimal movement, professional composed authority, steady camera",
}


# ── Avatar lip-sync video (P-Video-Avatar) ────────────────────────────────

async def generate_avatar_video(
    character_name: str,
    portrait_b64: Optional[str],
    audio_bytes: bytes,
    audio_mime: str = "audio/mpeg",
    emotion: str = "neutral",
) -> Optional[str]:
    """
    Generate a lip-synced avatar video using Pruna P-Video-Avatar.
    portrait_b64: base64 JPEG of character portrait (or None to skip)
    audio_bytes:  MP3 of character speech
    emotion:      controls video_prompt expression
    Returns base64 MP4 string or None.
    """
    if not PRUNA_KEY() or not portrait_b64:
        return None

    cache_key = f"{character_name}_{emotion}_{hash(audio_bytes)}"
    if cache_key in _avatar_video_cache:
        return _avatar_video_cache[cache_key]

    # Build video_prompt: emotion expression + character movement style
    emotion_desc = _EMOTION_VIDEO_PROMPTS.get(emotion, _EMOTION_VIDEO_PROMPTS["neutral"])
    char_style   = _CHAR_DEFAULT_VIDEO_PROMPT.get(character_name, "natural expression and movement")
    video_prompt = f"{emotion_desc}, {char_style}"

    try:
        portrait_bytes = base64.b64decode(portrait_b64)

        # Upload portrait + audio in parallel
        portrait_url, audio_url = await asyncio.gather(
            upload_file(portrait_bytes, f"{character_name}.jpg", "image/jpeg"),
            upload_file(audio_bytes, "speech.mp3", audio_mime),
        )

        if not portrait_url or not audio_url:
            print(f"[Pruna] File upload failed for {character_name}: portrait={portrait_url}, audio={audio_url}")
            return None

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{PRUNA_BASE}/predictions",
                headers={**_headers(), "Model": "p-video-avatar"},
                json={
                    "input": {
                        "image":        portrait_url,
                        "audio":        audio_url,
                        "video_prompt": video_prompt,
                        "resolution":   "720p",
                    }
                },
            )
            resp.raise_for_status()
            data = resp.json()
            print(f"[Pruna] Avatar job submitted for {character_name}, emotion={emotion}: {data.get('id', '?')}")

            output_url = None
            if data.get("status") == "succeeded":
                output_url = data.get("output") or data.get("generation_url")
            elif data.get("id"):
                result = await poll_job(data["id"], data.get("get_url", ""), timeout=90)
                output_url = result.get("output") or result.get("generation_url")

            if not output_url:
                print(f"[Pruna] No output URL for {character_name}")
                return None

            vid_resp = await client.get(output_url, headers={"apikey": PRUNA_KEY()})
            vid_resp.raise_for_status()
            video_bytes = vid_resp.content

            if video_bytes:
                b64 = base64.b64encode(video_bytes).decode()
                _avatar_video_cache[cache_key] = b64
                print(f"[Pruna] Avatar ready for {character_name} ({len(video_bytes)//1024}KB)")
                return b64

    except Exception as e:
        print(f"[Pruna] Avatar video failed for {character_name}: {e}")
    return None


# ── Simli AI — fast lip-sync (~3-5s vs Pruna's 15-30s) ───────────────────

async def create_simli_face(portrait_bytes: bytes, name: str) -> Optional[str]:
    """Upload a portrait to Simli Trinity and return the faceId string."""
    if not SIMLI_KEY():
        return None
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{SIMLI_BASE}/faces/trinity",
                headers={"x-simli-api-key": SIMLI_KEY()},
                params={"face_name": name},
                files={"image": (f"{name.lower()}.jpg", portrait_bytes, "image/jpeg")},
            )
            resp.raise_for_status()
            data = resp.json()
            print(f"[Simli] Face created for {name}: {data}")
            face_id = (
                data.get("faceId") or data.get("face_id") or data.get("id")
                or (data.get("face") or {}).get("faceId")
                or (data.get("face") or {}).get("id")
            )
            if face_id:
                _simli_face_ids[name] = face_id
                print(f"[Simli] faceId for {name}: {face_id}")
            return face_id
    except Exception as e:
        print(f"[Simli] Face creation failed for {name}: {e}")
    return None


async def generate_avatar_video_simli(
    face_id: str,
    audio_bytes: bytes,
) -> Optional[str]:
    """Send MP3 audio to Simli static endpoint, return base64 MP4."""
    if not SIMLI_KEY() or not face_id:
        return None

    cache_key = f"simli_{face_id}_{hash(audio_bytes)}"
    if cache_key in _avatar_video_cache:
        return _avatar_video_cache[cache_key]

    try:
        audio_b64 = base64.b64encode(audio_bytes).decode()
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{SIMLI_BASE}/static/audio",
                headers={
                    "x-simli-api-key": SIMLI_KEY(),
                    "Content-Type": "application/json",
                },
                json={
                    "faceId":            face_id,
                    "audioBase64":       audio_b64,
                    "audioFormat":       "mp3",
                    "audioSampleRate":   44100,
                    "audioChannelCount": 1,
                    "videoStartingFrame": 0,
                },
            )
            resp.raise_for_status()
            data = resp.json()

            mp4_url = data.get("mp4_url")
            if not mp4_url:
                print(f"[Simli] Unexpected response (no mp4_url): {data}")
                return None

            vid_resp = await client.get(mp4_url)
            vid_resp.raise_for_status()
            b64 = base64.b64encode(vid_resp.content).decode()
            _avatar_video_cache[cache_key] = b64
            print(f"[Simli] Lip-sync ready ({len(vid_resp.content)//1024}KB)")
            return b64

    except Exception as e:
        print(f"[Simli] Static video failed: {e}")
    return None


# ── Unified lip-sync entry point ──────────────────────────────────────────

async def generate_lipsync(
    character_name: str,
    portrait_b64: Optional[str],
    audio_bytes: bytes,
    emotion: str = "neutral",
) -> Optional[str]:
    """
    Generate a lip-synced avatar video.
    Prefers Simli (3-5s) over Pruna (15-30s) when both keys are available.
    """
    # ── Simli path (fast) ────────────────────────────────────────────────
    if SIMLI_KEY():
        face_id = _simli_face_ids.get(character_name)
        if face_id:
            result = await generate_avatar_video_simli(face_id, audio_bytes)
            if result:
                return result
            print(f"[Simli] Falling back to Pruna for {character_name}")

    # ── Pruna path (slow, fallback) ───────────────────────────────────────
    if PRUNA_KEY() and portrait_b64:
        return await generate_avatar_video(
            character_name, portrait_b64, audio_bytes, emotion=emotion
        )

    return None


# ── Scene music generation (ElevenLabs Sound Effects) ────────────────────

SCENE_MUSIC_PROMPTS: dict[str, str] = {
    "party_night":          "upbeat indie party, people talking, bass beat, warm crowded apartment, lively and alive",
    "intro":                "tense quiet thriller underscore, sparse piano, morning dread, low drone, unease",
    "sara_calls":           "anxious strings, desperate phone call energy, heart-pounding subtle pulse, fear",
    "detective_arrives":    "cold noir investigative underscore, low brass, measured slow tension, detective atmosphere",
    "cole_pushes":          "confrontation tension, rising strings, pressure building, no resolution, interrogation",
    "cole_follows_up":      "very minimal tense drone, confession atmosphere, barely breathing, sparse and heavy",
    "sara_comes_over":      "desperate emotional strings, someone running urgently, breathless, fear and love",
    "maya_calls":           "mysterious revelation, emotional strings, a secret surfacing, tense and fragile",
    "sara_reveals":         "raw quiet emotional score, truth being spoken aloud, piano and strings, vulnerable",
    "ending_complicit":     "dark ambient guilt theme, slow and heavy, something buried that will never leave",
    "ending_witness":       "bittersweet score, truth told at a cost, loss and relief, strings slowly fading",
    "ending_witness_broken":"somber piano, late confession, weight of consequences, honest and slow",
    "ending_witness_doubt": "ambiguous unresolved ambient, an open question, quiet uncertainty, no conclusion",
    "ending_truth":         "quiet hopeful strings, two people facing hard truth together, restrained morning light",
    "ending_truth_together":"united emotional score, three voices implied, truth prevailing, cautious hope",
    "ending_betrayal":      "cold sparse piano, betrayal theme, a friendship ended, courtroom silence and doubt",
    "ending_alone":         "lonely ambient drone, a phone unanswered, emptiness, the night after everything",
}


async def generate_scene_music(atmosphere: str) -> Optional[pathlib.Path]:
    """
    Generate atmospheric background music for a scene using ElevenLabs sound generation.
    Saves to static/music/{atmosphere}.mp3. Returns path if successful, None otherwise.
    Cached to disk — only generated once per atmosphere.
    """
    if not ELEVEN_KEY():
        return None

    out_path = MUSIC_DIR / f"{atmosphere}.mp3"
    if out_path.exists():
        return out_path

    prompt = SCENE_MUSIC_PROMPTS.get(atmosphere)
    if not prompt:
        return None

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{ELEVEN_BASE}/sound-generation",
                headers={"xi-api-key": ELEVEN_KEY(), "Content-Type": "application/json"},
                json={
                    "text":             prompt,
                    "duration_seconds": 22,
                    "prompt_influence": 0.4,
                },
            )
            if resp.status_code != 200:
                print(f"[Music] ElevenLabs sound generation failed for {atmosphere}: {resp.text[:200]}")
                return None

            out_path.write_bytes(resp.content)
            print(f"[Music] ✓ {atmosphere} ({len(resp.content)//1024}KB)")
            return out_path

    except Exception as e:
        print(f"[Music] Failed for {atmosphere}: {e}")
    return None
