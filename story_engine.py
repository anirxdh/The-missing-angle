import json
import os
from dataclasses import dataclass, field

_SCENES_PATH = os.path.join(os.path.dirname(__file__), "scenes.json")
_scenes_mtime = 0.0
SCENE_DATA: dict = {}
SCENES: dict = {}


def reload_scenes_if_needed() -> None:
    """Reload scenes.json when the file changes (uvicorn --reload ignores JSON edits)."""
    global _scenes_mtime
    try:
        mtime = os.path.getmtime(_SCENES_PATH)
    except OSError:
        return
    if mtime == _scenes_mtime and SCENES:
        return
    with open(_SCENES_PATH, encoding="utf-8") as f:
        data = json.load(f)
    SCENE_DATA.clear()
    SCENE_DATA.update(data)
    SCENES.clear()
    SCENES.update(SCENE_DATA.get("scenes", {}))
    _scenes_mtime = mtime


reload_scenes_if_needed()


@dataclass
class StoryState:
    current_scene: str = "crime_scene"
    previous_scenes: list = field(default_factory=list)
    choices_made: list = field(default_factory=list)
    session_id: str = ""
    interview_replies: dict = field(default_factory=lambda: {"SARA": [], "MAYA": [], "COLE": []})

    def get_scene(self) -> dict:
        reload_scenes_if_needed()
        return SCENES.get(self.current_scene, SCENES["crime_scene"])


class StoryEngine:
    def __init__(self):
        self.states: dict[str, StoryState] = {}

    def get_state(self, session_id: str) -> StoryState:
        if session_id not in self.states:
            self.states[session_id] = StoryState(session_id=session_id)
        return self.states[session_id]

    def reset_state(self, session_id: str) -> StoryState:
        self.states[session_id] = StoryState(session_id=session_id)
        return self.states[session_id]
