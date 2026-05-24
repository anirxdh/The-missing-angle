# The Missing Angle

An interactive cinematic thriller where the viewer chooses which clue the film follows next.

## Run locally

```bash
python3 -m pip install -r requirements.txt
cp .env.example .env
python3 -m uvicorn server:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000`.

## Deploy on Vercel

1. Import the GitHub repo in [Vercel](https://vercel.com).
2. In **Project → Settings → Environment Variables**, add `ELEVENLABS_API_KEY` (and optionally `PRUNA_API_KEY`).
3. Redeploy after env vars are set.

Vercel runs `server.py` as a FastAPI function. Background media pre-generation is disabled there; committed files under `static/` are served as-is.

## Environment

`ELEVENLABS_API_KEY` is required for narration, character voices, and spoken choice selection.

Optional:

- `PRUNA_API_KEY` for scene image generation.
- `SARA_VOICE_ID`, `COLE_VOICE_ID`, `MAYA_VOICE_ID`, `NARRATOR_VOICE_ID` to override default voices.
