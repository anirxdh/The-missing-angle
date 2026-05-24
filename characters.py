import os
from voices import DEFAULT_VOICE_IDS

CHARACTERS = {
    "SARA": {
        "name": "SARA",
        "full_name": "Sara — your best friend",
        "role": "She was at the party. She's scared and calling you before the police do.",
        "voice_id": os.getenv("SARA_VOICE_ID") or DEFAULT_VOICE_IDS["SARA"],
        "voice_settings": {"stability": 0.55, "similarity_boost": 0.80, "style": 0.45},
        "color": "#f472b6",
        "portrait_prompt": (
            "cinematic film still, close-up portrait of a woman in her late 20s, "
            "dark brown hair loosely pulled back, sharp worried eyes, natural makeup, "
            "wearing a simple dark grey t-shirt, soft window light from the left, "
            "shallow depth of field, clean background, 35mm film, photorealistic, 1:1"
        ),
    },
    "MAYA": {
        "name": "MAYA",
        "full_name": "Maya — the victim's girlfriend",
        "role": "She was there. She has her own version of what happened — and she needs you to hear it.",
        "voice_id": os.getenv("MAYA_VOICE_ID") or DEFAULT_VOICE_IDS["MAYA"],
        "voice_settings": {"stability": 0.50, "similarity_boost": 0.82, "style": 0.60},
        "color": "#a78bfa",
        "portrait_prompt": (
            "cinematic film still, close-up portrait of a woman in her mid 20s, "
            "natural curly dark hair, red-rimmed eyes from crying, raw grief, "
            "wearing a dark jacket, outdoor soft grey overcast light, "
            "slight angle, shallow depth of field, clean background, 35mm film, photorealistic, 1:1"
        ),
    },
    "COLE": {
        "name": "COLE",
        "full_name": "Detective Cole",
        "role": "Calm, reads people for a living. Asks one question that changes everything.",
        "voice_id": os.getenv("COLE_VOICE_ID") or DEFAULT_VOICE_IDS["COLE"],
        "voice_settings": {"stability": 0.88, "similarity_boost": 0.72, "style": 0.15},
        "color": "#94a3b8",
        "portrait_prompt": (
            "cinematic film still, close-up portrait of a man in his early 40s, "
            "short dark hair with slight grey at temples, clean shave, calm unreadable expression, "
            "wearing a dark charcoal suit, face forward slight angle, "
            "neutral office light, shallow depth of field, clean background, "
            "35mm film, photorealistic, 1:1"
        ),
    },
}

NARRATOR = {
    "name": "NARRATOR",
    "voice_id": os.getenv("NARRATOR_VOICE_ID") or DEFAULT_VOICE_IDS["NARRATOR"],
    "model_id": "eleven_multilingual_v2",
    "voice_settings": {
        "stability": 0.42,
        "similarity_boost": 0.76,
        "style": 0.88,
        "use_speaker_boost": True,
    },
    "color": "#ffffff",
}

NARRATOR_MALE = {
    "name": "NARRATOR_MALE",
    "voice_id": os.getenv("NARRATOR_MALE_VOICE_ID") or DEFAULT_VOICE_IDS["NARRATOR_MALE"],
    "voice_settings": {"stability": 0.58, "similarity_boost": 0.78, "style": 0.32},
    "color": "#ffffff",
}

ALL_VOICES = {**CHARACTERS, "NARRATOR": NARRATOR, "NARRATOR_MALE": NARRATOR_MALE}
