---
name: podcast-cleanup
description: Clean up a conversation or podcast recording — trim long pauses, balance speakers, normalise loudness, add micro-fades.
---
# Podcast cleanup

1. `get_overview`; `get_loudness` and `get_silences` for each audio/video media item.
2. Shorten pauses longer than 1.2 s to about 0.6 s (a "breath" is natural; dead air is not). Use `remove_range` on the middle of the pause so both sides keep their room tone.
3. Do not remove filler or restructure the conversation unless asked.
4. Level: target −16 LUFS integrated (−19 for stereo-mixed music beds). Gain per clip = target − measured loudness, applied with `set_clip gainDb`. Never push a clip so that true peak exceeds −1 dBTP (check `get_loudness`).
5. If two speakers are on separate tracks, make sure the quieter one is within 3 dB of the other.
6. Add 10–30 ms fades at cuts that have none (the engine adds an 8 ms crossfade at joins automatically).
7. `validate`, then report: pauses shortened, dB applied per clip, final duration.
