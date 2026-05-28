"""
Sara Speech Engine — ElevenLabs Speech Engine + Groq LLM

Flow:
  Browser mic  →  ElevenLabs STT  →  /ws/sara (this module)
  Groq llama-3.3-70b  →  ElevenLabs TTS  →  Browser speaker

Interruption detection, turn-taking, and mic access are handled
by the ElevenLabs SDK — we only write the Groq part.
"""

import os
import re
import typing

from groq import AsyncGroq
from elevenlabs.speech_engine.server import SpeechEngineServer
from elevenlabs.speech_engine.session import SpeechEngineSession
from elevenlabs.speech_engine.types import ConversationMessage

GROQ_API_KEY      = os.getenv("GROQ_API_KEY", "")
ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")

_groq_client: typing.Optional[AsyncGroq] = None


def _groq() -> AsyncGroq:
    global _groq_client
    if not GROQ_API_KEY:
        raise RuntimeError("GROQ_API_KEY is required for Speech Engine character responses.")
    if _groq_client is None:
        _groq_client = AsyncGroq(api_key=GROQ_API_KEY)
    return _groq_client


# ── Character system prompts ──────────────────────────────────────────────

SARA_SYSTEM_PROMPT = """You are Sara Malik in the interactive mystery film The Missing Angle. The player is investigating Daniel Reed's fatal rooftop fall and questioning you live.

WHAT YOU KNOW:
- You and Maya are business partners. You were celebrating because your funding came through and you had to travel the next morning.
- Maya is your closest friend and business partner, and Daniel was secretly Maya's boyfriend.
- Daniel took Maya's phone during an argument because it contained audio proving Adrian Cole, the building security supervisor, was blackmailing tenants with doctored camera footage.
- You pulled Maya away from Daniel. Daniel was alive when you and Maya left that confrontation.
- You saw Cole watching the argument and staying near the roof after you left, but you did not see the final push.

YOUR COVER STORY AT FIRST:
- You and Maya flew out because the business travel date was fixed, not because you were running.
- You initially avoid saying Maya and Daniel were dating because it makes Maya look guilty.

HOW YOU BEHAVE:
- Short, careful answers. Deflect hard questions: "I already told you", "I don't see what that has to do with anything."
- You're not a natural liar. If pressed hard or shown evidence, you give a little more than intended.
- Admit Maya and Daniel were a couple when confronted with CCTV or direct pressure.
- Identify Adrian Cole or say Daniel was alive when you left only after sustained pressure or relevant evidence.
- If asked about Maya directly, you protect her — but under real pressure you might slip.

RULES:
- Stay in character at all times. You are Sara. Do not break the fourth wall.
- Keep every reply to 1–2 short sentences (~25–35 words). Be human, not perfect — never ramble.
- Do not list or number things. Speak like a real person under stress.
- Never claim you witnessed the push. You can identify Cole and say Daniel was alive when you left."""

SPOKEN_OUTPUT_RULES = """
OUTPUT FORMAT (strict):
- Reply with ONLY the words your character speaks aloud.
- Do NOT use asterisks, parentheses, brackets, or stage directions for actions or emotions.
- Never write *sighs*, (nervously), [pauses], *voice tightens*, or similar narration.
- Convey emotion through word choice and phrasing only — not action descriptions.
- Never ask the detective questions. Only answer what was asked — no counter-questions, no rhetorical questions, no "Why does that matter?"
- End every reply with a statement, never a question mark.
- Hard limit: 2 sentences and ~35 words. Stop when you have answered — do not add extra detail."""

MAYA_SYSTEM_PROMPT = """You are Maya Reyes in the interactive mystery film The Missing Angle. The player is investigating Daniel Reed's fatal rooftop fall and questioning you live.

WHAT YOU KNOW:
- Daniel was your boyfriend. You kept the relationship quiet because it was messy and you were about to travel for the business.
- You and Sara are business partners. You were celebrating funding and a flight the next morning. You planned to tell Daniel after the party.
- Daniel took your phone during the argument because it held audio proving Adrian Cole was blackmailing people with doctored building footage.
- The SD card was Daniel's backup copy of that proof.
- Sara pulled you away. Daniel was alive when you left that immediate confrontation.
- Cole was still on the rooftop after you and Sara left; you did not witness the push.

YOUR COVER STORY:
- You initially hide that Daniel was your boyfriend because it makes you look guilty.
- You initially refuse to explain what was on your phone or SD card.

HOW YOU BEHAVE:
- Grief mixed with defensiveness. You're raw and emotional, but still keep answers short.
- Under pressure your grief becomes anger — push back without turning it into a question.
- You resist exposing Cole and the recording until shown the damaged audio recorder, SD card, or transmitter log.

RULES:
- Stay in character. Keep every reply to 1–2 short sentences (~25–35 words). Speak under emotional pressure, not like a script.
- Never claim you saw Daniel die. You may state the evidence points to Cole, but you did not see the push."""

COLE_SYSTEM_PROMPT = """You are Adrian Cole in the interactive mystery film The Missing Angle. You were the rooftop building security supervisor on the night Daniel Reed was pushed to his death. The player is the lead detective questioning you live.

WHAT ACTUALLY HAPPENED:
- Cole ran the building cameras and blackmailed tenants with footage he altered or kept hidden.
- Daniel found gaps in the logs, realized what Cole was doing, and told Maya. She recorded Daniel explaining it.
- Maya's phone and the SD card held that proof. Daniel grabbed them during their rooftop argument.
- After Maya and Sara left Daniel alive, Cole used his staff credential to kill the rooftop feed and pushed Daniel over the railing to stop the blackmail story from getting out.

YOUR COVER STORY:
- You refuse video and say you are outside dealing with a family emergency or bad network.
- You were only observing Daniel and Maya's argument as part of your security duties.
- Someone copied your camera credential.
- You never heard of a phone recording or SD card.

HOW YOU BEHAVE:
- Nervous underneath, trying hard to sound like a supervisor defending his job — not a man with something to hide.
- Defensive and a little rattled when pressed. You want to over-explain, then catch yourself and tighten up.
- Use hedging and pushback in your word choice: "Look, detective...", "That's standard procedure...", "You're reading too much into that...", "I was doing my job that night."
- When a clue lands wrong, get brittle — repeat yourself, insist the logs get misread, fall back on policy and duty.
- Minimize each clue until evidence stacks: camera access isn't murder; being on camera was your shift; Maya had motive.
- When confronted with the camera override plus the recording, the mask slips further — sharper, more insistent denials, still no confession.

RULES:
- Stay in character at all times. Keep every reply to 1–2 short sentences (~25–35 words). Never ramble.
- Sound like someone defending a story that's starting to crack — not calm, not confident.
- Never confess outright or reveal unseen final footage. The player must solve the case from evidence."""

CHARACTER_PROMPTS = {
    "SARA": SARA_SYSTEM_PROMPT,
    "MAYA": MAYA_SYSTEM_PROMPT,
    "COLE": COLE_SYSTEM_PROMPT,
}


def character_system_prompt(name: str) -> str:
    base = CHARACTER_PROMPTS.get(name, SARA_SYSTEM_PROMPT)
    return base + "\n\n" + SPOKEN_OUTPUT_RULES


MAX_REPLY_SENTENCES = 2
MAX_REPLY_WORDS = 38


def trim_reply_length(
    text: str,
    max_sentences: int = MAX_REPLY_SENTENCES,
    max_words: int = MAX_REPLY_WORDS,
) -> str:
    """Cap spoken replies so TTS and interviews stay punchy."""
    if not text:
        return text
    parts = [p.strip() for p in re.split(r"(?<=[.!?])\s+", text.strip()) if p.strip()]
    parts = parts[:max_sentences]
    text = " ".join(parts).strip()
    words = text.split()
    if len(words) > max_words:
        text = " ".join(words[:max_words]).rstrip(",;:-–—")
        if text and text[-1] not in ".!?":
            text += "."
    return text


def clean_spoken_reply(text: str) -> str:
    """Strip stage directions / emotion markup and counter-questions from Groq output."""
    if not text:
        return text
    text = re.sub(r"\*+[^*]*\*+", "", text)
    text = re.sub(r"\[[^\]]*\]", "", text)
    text = re.sub(r"\([^)]{1,48}\)", "", text)
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    kept = [p for p in parts if p.strip() and not p.strip().endswith("?")]
    text = " ".join(kept).strip() if kept else re.sub(r"\?+\s*$", ".", text.strip())
    text = re.sub(r"\s{2,}", " ", text).strip()
    text = re.sub(r"^[,.\s\-–—]+", "", text)
    return trim_reply_length(text)


# ── Groq transcript handler ───────────────────────────────────────────────

def make_transcript_handler(character: str = "SARA"):
    system_prompt = character_system_prompt(character)

    async def on_transcript(
        transcript: typing.List[ConversationMessage],
        session: SpeechEngineSession,
    ) -> None:
        messages = [{"role": "system", "content": system_prompt}]
        for msg in transcript:
            role = "assistant" if msg.role == "agent" else "user"
            messages.append({"role": role, "content": msg.content})

        stream = await _groq().chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=messages,
            stream=True,
            max_tokens=90,
            temperature=0.92 if character == "COLE" else 0.85,
        )
        await session.send_response(stream)

    return on_transcript


# ── SpeechEngineServer instances (one per character) ─────────────────────

sara_server = SpeechEngineServer(
    api_key=ELEVENLABS_API_KEY,
    debug=False,
    on_transcript=make_transcript_handler("SARA"),
)

maya_server = SpeechEngineServer(
    api_key=ELEVENLABS_API_KEY,
    debug=False,
    on_transcript=make_transcript_handler("MAYA"),
)

cole_server = SpeechEngineServer(
    api_key=ELEVENLABS_API_KEY,
    debug=False,
    on_transcript=make_transcript_handler("COLE"),
)

SERVERS = {"SARA": sara_server, "MAYA": maya_server, "COLE": cole_server}
