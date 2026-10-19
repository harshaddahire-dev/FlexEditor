---
name: highlight-reel
description: Assemble the best moments from long footage into a short highlight reel of a requested length.
---
# Highlight reel

1. `get_overview` and `get_scenes` for every video. Use `get_transcript` where there is speech and `get_loudness`/`get_beats` for energy.
2. Shortlist moments: scene starts with motion, loud/laughing/excited speech, strong sentences. Aim for 2–3× more candidates than you need.
3. Pick moments in chronological order unless the user wants a story order. Each moment 2–6 s; start 0.2 s before the action and end on a natural stop.
4. Place with `add_clip` at consecutive timeline positions (ripple/insert), never leaving gaps.
5. Hit the requested total length within ±1 s. If none was given use 30 s.
6. Add a short dissolve (0.4 s) between moments from different scenes with `add_transition` — only where both sides have spare footage — and a 0.5 s fade out at the end.
7. `validate`; list the moments (source time → timeline time).
