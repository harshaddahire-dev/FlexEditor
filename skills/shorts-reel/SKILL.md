---
name: shorts-reel
description: Turn a long recording into a punchy 30–60 s vertical short with hook, tight pacing and big captions.
---
# Short-form vertical reel

1. `get_overview`. If the sequence is not 9:16 (e.g. 1080×1920) tell the user — the project format is theirs to change; continue with what exists.
2. Read transcripts and pick ONE idea that stands alone: a hook sentence in the first 3 s, a payoff before the end. Search with `search_transcript` for strong claims, numbers, questions.
3. Build the edit with `add_clip` (media in/out from word boundaries). Target 30–60 s total unless the user gives a length.
4. Tighten: remove every pause over 0.3 s and any filler. Cut on word boundaries.
5. Captions: `add_captions` with style `bold-pop`, ~20 characters per line, then check with `get_captions`.
6. Optional punch-in on the hook (+8 %) via `add_keyframes`.
7. `validate`; report length, the hook line and what you left out.
