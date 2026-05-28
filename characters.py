import os
from voices import DEFAULT_VOICE_IDS

CHARACTERS = {
    "SARA": {
        "name": "SARA",
        "voice_id": os.getenv("SARA_VOICE_ID") or DEFAULT_VOICE_IDS["SARA"],
        "voice_settings": {"stability": 0.55, "similarity_boost": 0.80, "style": 0.45},
    },
    "MAYA": {
        "name": "MAYA",
        "voice_id": os.getenv("MAYA_VOICE_ID") or DEFAULT_VOICE_IDS["MAYA"],
        "voice_settings": {"stability": 0.50, "similarity_boost": 0.82, "style": 0.60},
    },
    "DANIEL": {
        "name": "DANIEL",
        "voice_id": os.getenv("DANIEL_VOICE_ID") or DEFAULT_VOICE_IDS["DANIEL"],
        "voice_settings": {"stability": 0.58, "similarity_boost": 0.78, "style": 0.36},
    },
    "COLE": {
        "name": "COLE",
        "voice_id": os.getenv("COLE_VOICE_ID") or DEFAULT_VOICE_IDS["COLE"],
        "voice_settings": {"stability": 0.88, "similarity_boost": 0.72, "style": 0.15},
    },
}

NARRATOR = {
    "name": "NARRATOR",
    "voice_id": os.getenv("NARRATOR_VOICE_ID") or DEFAULT_VOICE_IDS["TRAILER_THRILLER"],
    "model_id": "eleven_turbo_v2_5",
    "speed": 1.06,
    "voice_settings": {
        "stability": 0.52,
        "similarity_boost": 0.76,
        "style": 0.22,
        "use_speaker_boost": True,
    },
}

NARRATOR_MALE = {
    "name": "NARRATOR_MALE",
    "voice_id": os.getenv("NARRATOR_MALE_VOICE_ID") or DEFAULT_VOICE_IDS["NARRATOR_MALE"],
    "voice_settings": {"stability": 0.58, "similarity_boost": 0.78, "style": 0.32},
}

TRAILER_NARRATOR = {
    "name": "TRAILER_NARRATOR",
    "voice_id": os.getenv("TRAILER_NARRATOR_VOICE_ID") or DEFAULT_VOICE_IDS["TRAILER_THRILLER"],
    "model_id": "eleven_multilingual_v2",
    "voice_settings": {
        "stability": 0.64,
        "similarity_boost": 0.76,
        "style": 0.28,
        "use_speaker_boost": True,
    },
}

ALL_VOICES = {
    **CHARACTERS,
    "NARRATOR": NARRATOR,
    "NARRATOR_MALE": NARRATOR_MALE,
    "TRAILER_NARRATOR": TRAILER_NARRATOR,
}
