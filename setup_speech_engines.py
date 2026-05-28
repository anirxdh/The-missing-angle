"""
One-time setup: create Sara, Maya, and Cole Speech Engine resources in ElevenLabs.

Run once:
    python3 setup_speech_engines.py

Requires:
    ELEVENLABS_API_KEY in .env
    SARA_VOICE_ID in .env (or defaults from voices.py)
    SPEECH_ENGINE_PUBLIC_URL in .env  <- public HTTPS or WSS server URL

What this does:
    1. Creates a Speech Engine resource for Sara, Maya, and Cole in ElevenLabs
    2. The resource has:  ws_url → your server's /ws/sara endpoint
                          voice  → Sara's ElevenLabs voice
                          STT    → ElevenLabs automatic
    3. Prints the speech_engine_id to add to your .env

Add to .env after running:
    SARA_SPEECH_ENGINE_ID=seng_...
    MAYA_SPEECH_ENGINE_ID=seng_...
    COLE_SPEECH_ENGINE_ID=seng_...
"""

import asyncio
import os
import sys

from dotenv import load_dotenv

load_dotenv()

from elevenlabs import AsyncElevenLabs
from elevenlabs.types import (
    SpeechEngineConfig,
    TtsConversationalConfigInput,
)

from voices import DEFAULT_VOICE_IDS

ELEVENLABS_API_KEY    = os.getenv("ELEVENLABS_API_KEY", "")
SPEECH_ENGINE_PUBLIC_URL = os.getenv("SPEECH_ENGINE_PUBLIC_URL", "")


async def create_speech_engine(character: str) -> str:
    if not ELEVENLABS_API_KEY:
        print("ERROR: ELEVENLABS_API_KEY not set"); sys.exit(1)
    if not SPEECH_ENGINE_PUBLIC_URL:
        print("ERROR: SPEECH_ENGINE_PUBLIC_URL not set")
        print("  For local dev: run  ngrok http 8000  then set")
        print("  SPEECH_ENGINE_PUBLIC_URL=https://YOUR-NGROK-ID.ngrok.io")
        sys.exit(1)

    voice_id = os.getenv(f"{character}_VOICE_ID") or DEFAULT_VOICE_IDS.get(character, "")
    ws_path = character.lower()   # /ws/sara, /ws/maya, or /ws/cole

    # ElevenLabs must reach the persistent FastAPI WebSocket endpoint.
    base = SPEECH_ENGINE_PUBLIC_URL.rstrip("/")
    if base.startswith("https://"):
        base = "wss://" + base[len("https://"):]
    elif base.startswith("http://"):
        base = "ws://" + base[len("http://"):]
    ws_url = f"{base}/ws/{ws_path}"

    client = AsyncElevenLabs(api_key=ELEVENLABS_API_KEY)

    existing_id = os.getenv(f"{character}_SPEECH_ENGINE_ID", "")
    if existing_id:
        # Update the existing resource (e.g. new ws_url after ngrok restart)
        result = await client.speech_engine.update(
            speech_engine_id=existing_id,
            speech_engine=SpeechEngineConfig(ws_url=ws_url),
            name=f"The Missing Angle — {character.title()}",
        )
        print(f"[{character}] Updated Speech Engine {result.engine_id}")
        print(f"  ws_url = {ws_url}")
        return result.engine_id

    # Create new resource
    result = await client.speech_engine.create(
        name=f"The Missing Angle — {character.title()}",
        speech_engine=SpeechEngineConfig(ws_url=ws_url),
        tts=TtsConversationalConfigInput(voice_id=voice_id) if voice_id else None,
    )
    seid = result.engine_id
    print(f"[{character}] Created Speech Engine: {seid}")
    print(f"  ws_url = {ws_url}")
    print(f"\nAdd to .env:")
    print(f"  {character}_SPEECH_ENGINE_ID={seid}")
    return seid


async def main():
    for char in ("SARA", "MAYA", "COLE"):
        await create_speech_engine(char)
        print()


if __name__ == "__main__":
    asyncio.run(main())
