import json
import os
from dataclasses import dataclass, field

with open(os.path.join(os.path.dirname(__file__), "scenes.json")) as f:
    SCENE_DATA = json.load(f)

SCENES = SCENE_DATA["scenes"]


@dataclass
class StoryState:
    current_scene: str = "party_night"
    previous_scenes: list = field(default_factory=list)
    choices_made: list = field(default_factory=list)
    session_id: str = ""

    def get_scene(self) -> dict:
        return SCENES.get(self.current_scene, SCENES["party_night"])


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
