# The Missing Angle

An interactive cinematic thriller where the viewer chooses which clue the film follows next.

## Run locally

```bash
python3 -m pip install -r requirements.txt
cp .env.example .env
python3 -m uvicorn server:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000`.

## Environment

`ELEVENLABS_API_KEY` is required for narration, character voices, and spoken choice selection.

Optional:

- `PRUNA_API_KEY` for scene image generation.
- `SARA_VOICE_ID`, `COLE_VOICE_ID`, `MAYA_VOICE_ID`, `NARRATOR_VOICE_ID` to override default voices.
