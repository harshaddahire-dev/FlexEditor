---
name: loudness-master
description: Measure and set loudness for delivery — dialogue to −16 LUFS, music under speech, peaks under −1 dBTP.
---
# Loudness master

1. `get_overview`; `get_loudness` for every media item used on the timeline (integrated LUFS, LRA, true peak).
2. Dialogue/primary clips: `set_clip gainDb` = −16 − measured integrated LUFS (limit to ±12 dB; flag anything beyond).
3. Music or beds that play with speech: 14–18 dB below dialogue, i.e. about −30 LUFS integrated; full level (−14 to −16) only when nothing is spoken. Use `add_keyframes` on `audio.gainDb` to duck under speech (0.3 s down, 0.6 s back up).
4. Check no clip's true peak after gain exceeds −1 dBTP; reduce gain if so and say so.
5. Short fades (20 ms) at cuts that have none.
6. `validate`; report a table: clip, measured, gain applied, expected result.
