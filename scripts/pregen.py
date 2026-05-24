"""
Pre-generation script — run ONCE before the hackathon demo.

Generates all scene videos and character portraits using Pruna AI.
Results saved to static/scenes/ and static/avatars/ — never regenerated.

Usage:
    cd speechengine
    python3 scripts/pregen.py

Cost estimate:
    31 scene images    × $0.005 = $0.155
    31 scene videos    × 8s × $0.02 = $4.96
    3 character images × $0.005 = $0.015
    ─────────────────────────────────────
    Total: ~$5.13 one-time
"""

import asyncio
import base64
import json
import os
import pathlib
import sys
import time

import httpx
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from media_engine import SCENE_IMAGE_PROMPTS
from characters import CHARACTERS as _CHARACTERS

PRUNA_BASE = "https://api.pruna.ai/v1"
API_KEY = os.getenv("PRUNA_API_KEY", "")

SCENES_DIR  = pathlib.Path(__file__).parent.parent / "static" / "scenes"
AVATARS_DIR = pathlib.Path(__file__).parent.parent / "static" / "avatars"
SCENES_JSON = pathlib.Path(__file__).parent.parent / "scenes.json"

SCENES_DIR.mkdir(parents=True, exist_ok=True)
AVATARS_DIR.mkdir(parents=True, exist_ok=True)


def headers(model: str = None, sync: bool = False) -> dict:
    h = {"apikey": API_KEY, "Content-Type": "application/json"}
    if model: h["Model"] = model
    if sync:  h["Try-Sync"] = "true"
    return h


async def poll(job_id: str, timeout: int = 180) -> dict:
    deadline = time.time() + timeout
    async with httpx.AsyncClient(timeout=15) as c:
        while time.time() < deadline:
            r = await c.get(f"{PRUNA_BASE}/predictions/status/{job_id}",
                            headers={"apikey": API_KEY})
            if r.status_code == 200:
                d = r.json()
                if d.get("status") == "succeeded":
                    return d
                if d.get("status") in ("failed", "error"):
                    raise RuntimeError(f"Job {job_id} failed: {d}")
            await asyncio.sleep(3)
    raise TimeoutError(f"Job {job_id} timed out")


async def download(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as c:
        r = await c.get(url, headers={"apikey": API_KEY})
        r.raise_for_status()
        return r.content


async def generate_image(prompt: str, aspect: str) -> bytes:
    """p-image → bytes"""
    async with httpx.AsyncClient(timeout=45) as c:
        r = await c.post(f"{PRUNA_BASE}/predictions",
                         headers=headers("p-image", sync=True),
                         json={"input": {"prompt": prompt, "aspect_ratio": aspect}})
        r.raise_for_status()
        d = r.json()

    gen_url = d.get("generation_url") if d.get("status") == "succeeded" else None
    if not gen_url and d.get("id"):
        result = await poll(d["id"])
        gen_url = result.get("generation_url")

    if not gen_url:
        raise RuntimeError(f"No generation_url in response: {d}")
    return await download(gen_url)


async def generate_video_from_image(image_bytes: bytes, prompt: str, duration: int = 8) -> bytes:
    """Upload image → wan-i2v → video bytes"""
    # Upload image to Pruna file storage
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{PRUNA_BASE}/files",
                         headers={"apikey": API_KEY},
                         files={"files": ("scene.jpg", image_bytes, "image/jpeg")})
        r.raise_for_status()
        fdata = r.json()
        files = fdata.get("files") or fdata.get("data") or []
        file_id = files[0].get("id") or files[0].get("url") if files else fdata.get("id", "")

    # Submit p-video job (async — video gen takes ~30-90s)
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{PRUNA_BASE}/predictions",
                         headers=headers("p-video"),
                         json={"input": {
                             "image": file_id,
                             "prompt": prompt,
                             "duration": duration,
                         }})
        r.raise_for_status()
        d = r.json()

    gen_url = d.get("generation_url") if d.get("status") == "succeeded" else None
    if not gen_url and d.get("id"):
        result = await poll(d["id"], timeout=180)
        gen_url = result.get("generation_url")

    if not gen_url:
        raise RuntimeError(f"No video url: {d}")
    return await download(gen_url)


# ── Scene prompts ─────────────────────────────────────────────────────────
SCENE_VIDEO_PROMPTS = {
    "space_station":      "woman turns slowly from glowing monitor, leans forward examining signal data, atmospheric slow push in, cinematic",
    "ai_core":            "woman walks forward through server corridor, slow tracking shot, blue light flickering across her face, cinematic",
    "ai_core_red":        "man stands at console, red emergency lights pulse, he glances around warily, slow zoom in",
    "ai_core_white":      "woman examines dark server panels, runs her hand along equipment, uneasy, slow camera drift",
    "lab_green":          "woman scrolls through data on screens, leans closer, slow push in on her concerned expression, cinematic",
    "morning_amber":      "woman walks down corridor, amber light shifting on her face, purposeful stride, slow tracking shot",
    "corridor_harsh":     "man walks forward, fluorescent light harsh overhead, he pauses and listens, slow dolly",
    "corridor_white":     "two people face off in corridor, slow push in, tension building, neither moving",
    "corridor_orange":    "woman runs through orange-lit tunnel, urgent motion, handheld camera shake, cinematic",
    "corridor_cold":      "man walks slowly through blue corridor, hands in pockets, weight of something unseen, slow tracking",
    "conference_cold":    "two people sit across table, neither speaking, slow zoom in on their faces, tension",
    "transmission_purple":"woman on screen flickers through static, her image resolving and dissolving, purple interference",
    "transmission_white": "woman on screen looks directly at camera, calm and unreadable, slow zoom in on her eyes",
    "dark_lab":           "woman types at terminal, only light is screen glow, she looks over shoulder briefly, slow orbit",
    "dark_station":       "man moves cautiously toward emergency light, darkness all around, slow push forward",
    "cosmic_purple":      "woman stands before giant signal display, data patterns shifting around her, slow pull back revealing scale",
    "cosmic_red":         "man grips console as red data cascades across screens, desperate, slow zoom in",
    "cosmic_alone":       "figure sits motionless at porthole, stars drifting outside, profound stillness, slow pull back",
    "red_alert":          "man runs through strobing red corridor, smoke drifting, urgent handheld camera",
    "server_room_red":    "woman works frantically at keyboard, deletion bar ticking up, red lights blinking, tight shot",
    "split_screen_chaos": "woman stares at two screens, shakes her head slowly, disbelief, slow push in",
    "interrogation":      "woman sits under bare bulb, completely still, interrogation room, slow circular dolly",
    "interrogation_grey": "man sits alone in cell, light shifting through small window, time passing, slow drift",
    "escape_orange":      "two people run through maintenance tunnel, low ceiling, urgent, handheld chase cam",
    "bunker_amber":       "woman walks through bunker, hand trailing over old equipment, amber light, slow reveal pan",
    "station_warm":       "two people talk in break room, warm light, coffee steam rising, slow push in on their faces",
    "white_void":         "woman stands in white room, turns slowly, existential, slow camera orbit",
    "empty_corridor":     "woman walks away from camera down long corridor, slow tracking shot, she does not look back",
    "ending_gold":        "woman stands at porthole, golden light on her face, hand on glass, slow zoom in, triumphant and sad",
    "ending_blue":        "figure alone in airlock, station receding in window, cold blue light, slow pull back into darkness",
    "default":            "researcher walks through dark space station corridor, slow tracking shot, cinematic",
}

CHARACTER_IMAGE_PROMPTS = {name: c["portrait_prompt"] for name, c in _CHARACTERS.items()}


async def pregen_character(name: str, prompt: str):
    out = AVATARS_DIR / f"{name.lower()}_portrait.jpg"
    if out.exists():
        print(f"  ✓ {name} portrait (cached)")
        return
    print(f"  Generating {name} portrait...", end=" ", flush=True)
    img = await generate_image(prompt, "1:1")
    out.write_bytes(img)
    print(f"saved ({len(img)//1024}KB)")


async def pregen_scene(atmosphere: str, image_prompt: str, video_prompt: str):
    img_out = SCENES_DIR / f"{atmosphere}.jpg"
    vid_out = SCENES_DIR / f"{atmosphere}.mp4"

    # Skip if both exist
    if img_out.exists() and vid_out.exists():
        print(f"  ✓ {atmosphere} (cached)")
        return

    print(f"  {atmosphere}")

    # Step 1: generate image
    if not img_out.exists():
        print(f"    → image...", end=" ", flush=True)
        try:
            img_bytes = await generate_image(image_prompt, "16:9")
            img_out.write_bytes(img_bytes)
            print(f"done ({len(img_bytes)//1024}KB)")
        except Exception as e:
            print(f"FAILED: {e}")
            return
    else:
        img_bytes = img_out.read_bytes()
        print(f"    → image (cached)")

    # Step 2: animate image → video
    if not vid_out.exists():
        print(f"    → video (this takes 30-90s)...", end=" ", flush=True)
        try:
            vid_bytes = await generate_video_from_image(img_bytes, video_prompt, duration=8)
            vid_out.write_bytes(vid_bytes)
            print(f"done ({len(vid_bytes)//1024}KB)")
        except Exception as e:
            print(f"FAILED (will use image): {e}")


async def main():
    if not API_KEY:
        print("ERROR: PRUNA_API_KEY not set in .env")
        sys.exit(1)

    print(f"\n{'='*50}")
    print("THE LAST SIGNAL — Pre-generation")
    print(f"{'='*50}")
    print(f"Output: {SCENES_DIR}")
    print()

    # Characters
    print("[ CHARACTER PORTRAITS ]")
    for name, prompt in CHARACTER_IMAGE_PROMPTS.items():
        await pregen_character(name, prompt)

    print()
    print("[ SCENE VIDEOS ]")

    with open(SCENES_JSON) as f:
        scenes_data = json.load(f)

    # Get unique atmospheres
    atmospheres_seen = set()
    atmosphere_to_scenes = {}
    for scene_id, scene in scenes_data["scenes"].items():
        atm = scene.get("atmosphere", "default")
        if atm not in atmosphere_to_scenes:
            atmosphere_to_scenes[atm] = scene
        atmospheres_seen.add(atm)

    total = len(atmospheres_seen)
    done = 0
    for atm, scene in atmosphere_to_scenes.items():
        done += 1
        print(f"  [{done}/{total}]", end=" ")
        img_prompt = SCENE_IMAGE_PROMPTS.get(atm, SCENE_IMAGE_PROMPTS["default"])
        vid_prompt = SCENE_VIDEO_PROMPTS.get(atm, img_prompt + ", slow camera movement")
        await pregen_scene(atm, img_prompt, vid_prompt)

    print()
    print("[ DONE ]")
    imgs = len(list(SCENES_DIR.glob("*.jpg")))
    vids = len(list(SCENES_DIR.glob("*.mp4")))
    print(f"  {imgs} images, {vids} videos in {SCENES_DIR}")
    print(f"  {len(list(AVATARS_DIR.glob('*.jpg')))} character portraits in {AVATARS_DIR}")


if __name__ == "__main__":
    asyncio.run(main())
