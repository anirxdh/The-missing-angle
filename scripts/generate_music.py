#!/usr/bin/env python3
"""Regenerate static/music beds via ElevenLabs Music API.

Usage:
  python scripts/generate_music.py              # skip tracks that already exist
  python scripts/generate_music.py --force      # overwrite all scene + trailer beds
  python scripts/generate_music.py --only intro_party cctv_review
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env")

from media_engine import (  # noqa: E402
    SCENE_MUSIC_PROMPTS,
    generate_all_scene_music,
    generate_scene_music,
    generate_trailer_music,
)


async def main() -> int:
    parser = argparse.ArgumentParser(description="Generate mystery film scene music beds.")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing mp3 files in static/music/",
    )
    parser.add_argument(
        "--only",
        nargs="*",
        metavar="ATMOSPHERE",
        help=f"Generate specific atmospheres only. Choices: {', '.join(SCENE_MUSIC_PROMPTS)}",
    )
    parser.add_argument("--trailer", action="store_true", help="Also regenerate trailer_suspense.mp3")
    args = parser.parse_args()

    if args.only:
        ok = True
        for atmosphere in args.only:
            if atmosphere not in SCENE_MUSIC_PROMPTS:
                print(f"Unknown atmosphere: {atmosphere}")
                ok = False
                continue
            path = await generate_scene_music(atmosphere, force=args.force)
            print(f"{'✓' if path else '✗'} {atmosphere}")
        if args.trailer:
            path = await generate_trailer_music(force=args.force)
            print(f"{'✓' if path else '✗'} trailer_suspense")
        return 0 if ok else 1

    results = await generate_all_scene_music(force=args.force)
    for name, success in results.items():
        print(f"{'✓' if success else '✗'} {name}")
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
