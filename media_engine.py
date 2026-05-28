"""Media helpers for The Missing Angle.

Runtime media generation uses ElevenLabs Music for scene beds (instrumental,
loop-friendly underscore). Scene videos and evidence art ship under static/.
"""

import os
import pathlib
from typing import Optional

import httpx

ELEVEN_BASE = "https://api.elevenlabs.io/v1"
ELEVEN_KEY = lambda: os.getenv("ELEVENLABS_API_KEY", "")
# Public API documents music_v1; set ELEVENLABS_MUSIC_MODEL=music_v2 if your key has access.
MUSIC_MODEL = os.getenv("ELEVENLABS_MUSIC_MODEL", "music_v1")
MUSIC_OUTPUT_FORMAT = os.getenv("ELEVENLABS_MUSIC_FORMAT", "mp3_44100_128")

_ROOT = pathlib.Path(__file__).parent
_ON_VERCEL = bool(os.getenv("VERCEL"))

MUSIC_DIR = _ROOT / "static" / "music"
MUSIC_DIR.mkdir(parents=True, exist_ok=True)

# ── Scene music (ElevenLabs Music API — instrumental cinematic beds) ───────

SCENE_MUSIC_PROMPTS: dict[str, str] = {
    "intro_party": (
        "Instrumental cinematic rooftop party underscore for a mystery film opening. "
        "Warm celebration energy — soft four-on-the-floor kick, muted bass, glassy synth pads, "
        "distant city-night atmosphere. 102 BPM. Hopeful but with a subtle unease underneath, "
        "as if something is about to go wrong. No vocals, no dialogue, no sound effects."
    ),
    "rooftop_establishing": (
        "Instrumental crime-scene investigation underscore. Sparse felt piano, low sub drone, "
        "distant morning city haze. Slow 68 BPM noir pulse. Quiet dread and focus — detective "
        "returning to the rooftop after a death. No vocals, no percussion hits, no jump scares."
    ),
    "cctv_review": (
        "Instrumental surveillance-review tension bed. Glitchy digital texture, muted kick pulse, "
        "cold analog synth, broken CCTV static woven lightly into the mix. 84 BPM investigative "
        "thriller. Fragmented and suspicious — footage that hides the truth. No vocals."
    ),
    "sara_video_call": (
        "Instrumental anxious video-call underscore. Soft tremolo strings, isolated reverb piano, "
        "fragile high-register pads. 76 BPM emotional thriller. Guilt, distance, and controlled "
        "panic — overseas witness on a screen. No vocals, no phone UI sounds."
    ),
    "maya_video_call": (
        "Instrumental confession underscore for a secret relationship reveal. Restrained piano, "
        "warm cello lines, subtle heartbeat-like low pulse. 74 BPM grief and suspicion. Intimate "
        "but tense — loving someone who is now a suspect. No vocals."
    ),
    "cole_video_call": (
        "Instrumental defensive interview underscore for a nervous security supervisor on video call. "
        "Tight muted pulse, cold digital undertone, restrained brass stabs. 80 BPM — controlled "
        "denial under pressure, not action-movie chaos. No vocals."
    ),
    "truth_reveal_cole": (
        "Instrumental murder-reveal climax for a detective story ending. Dark rising strings, "
        "low brass swells, tense pulsing bass, cinematic hits that stay controlled. 92 BPM "
        "truth exposed — the missing angle finally appears. No vocals, no choir."
    ),
}

SCENE_MUSIC_DURATION_MS: dict[str, int] = {
    "intro_party":          90_000,
    "rooftop_establishing": 75_000,
    "cctv_review":          75_000,
    "sara_video_call":      75_000,
    "maya_video_call":      75_000,
    "cole_video_call":      75_000,
    "truth_reveal_cole":    80_000,
}

TRAILER_MUSIC_PROMPT = (
    "Instrumental cinematic mystery trailer underscore. Low pulsing synth, distant piano motif, "
    "slow-building investigative tension, rooftop party aftermath energy. 88 BPM. Dark but elegant — "
    "interactive murder mystery film. No vocals, no dialogue, no trailer whooshes."
)

TRAILER_MUSIC_DURATION_MS = 45_000


async def _compose_instrumental(
    prompt: str,
    duration_ms: int,
    *,
    model_id: Optional[str] = None,
) -> Optional[bytes]:
    """Generate loop-friendly instrumental audio via ElevenLabs Music API."""
    if not ELEVEN_KEY():
        return None

    models = [model_id or MUSIC_MODEL]
    if models[0] != "music_v1":
        models.append("music_v1")

    async with httpx.AsyncClient(timeout=180) as client:
        for model in models:
            try:
                resp = await client.post(
                    f"{ELEVEN_BASE}/music",
                    params={"output_format": MUSIC_OUTPUT_FORMAT},
                    headers={"xi-api-key": ELEVEN_KEY(), "Content-Type": "application/json"},
                    json={
                        "prompt": prompt,
                        "music_length_ms": duration_ms,
                        "model_id": model,
                        "force_instrumental": True,
                    },
                )
                if resp.status_code == 200 and resp.content:
                    if model != models[0]:
                        print(f"[Music] Used fallback model {model}")
                    return resp.content
                print(f"[Music] {model} failed ({resp.status_code}): {resp.text[:240]}")
            except Exception as e:
                print(f"[Music] {model} error: {e}")
    return None


async def generate_scene_music(atmosphere: str, *, force: bool = False) -> Optional[pathlib.Path]:
    """
    Generate a scene bed with ElevenLabs Music and save to static/music/{atmosphere}.mp3.
    Skips if the file already exists unless force=True.
    """
    out_path = MUSIC_DIR / f"{atmosphere}.mp3"
    if out_path.exists() and not force:
        return out_path

    prompt = SCENE_MUSIC_PROMPTS.get(atmosphere)
    if not prompt:
        return None

    duration_ms = SCENE_MUSIC_DURATION_MS.get(atmosphere, 75_000)
    audio = await _compose_instrumental(prompt, duration_ms)
    if not audio:
        return out_path if out_path.exists() else None

    out_path.write_bytes(audio)
    print(f"[Music] ✓ {atmosphere} ({len(audio)//1024}KB, {duration_ms//1000}s, {MUSIC_MODEL})")
    return out_path


async def generate_trailer_music(*, force: bool = False) -> Optional[pathlib.Path]:
    """Generate trailer suspense bed; falls back to intro_party if generation fails."""
    out_path = MUSIC_DIR / "trailer_suspense.mp3"
    if out_path.exists() and not force:
        return out_path

    fallback = MUSIC_DIR / "intro_party.mp3"

    if _ON_VERCEL or not ELEVEN_KEY():
        return fallback if fallback.exists() else (out_path if out_path.exists() else None)

    audio = await _compose_instrumental(TRAILER_MUSIC_PROMPT, TRAILER_MUSIC_DURATION_MS)
    if not audio:
        return fallback if fallback.exists() else (out_path if out_path.exists() else None)

    out_path.write_bytes(audio)
    print(f"[Music] ✓ trailer_suspense ({len(audio)//1024}KB)")
    return out_path


async def generate_all_scene_music(*, force: bool = False) -> dict[str, bool]:
    """Generate every configured scene atmosphere plus the trailer bed."""
    results: dict[str, bool] = {}
    for atmosphere in SCENE_MUSIC_PROMPTS:
        path = await generate_scene_music(atmosphere, force=force)
        results[atmosphere] = bool(path and path.exists())
    trailer = await generate_trailer_music(force=force)
    results["trailer_suspense"] = bool(trailer and trailer.exists())
    return results
