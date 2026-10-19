---
name: youtube-retention-cut
description: Tighten talking-head footage for YouTube — remove dead air, filler and false starts, keep energy high, add punch-ins and captions.
---
# YouTube retention cut

Use for a single-presenter video that should feel fast without feeling chopped.

1. `get_overview`, then `get_transcript` and `get_silences` for each talking-head media item. Read the whole transcript before cutting.
2. Find the real start: skip slates, "ok so", throat-clearing and repeated takes. When the speaker says the same line twice, keep the better (later, cleaner) take.
3. Remove silences longer than 0.45 s inside speech and all pauses longer than 1 s, keeping ~0.12 s (3–4 frames at 30 fps) of room around words. Prefer `remove_range` so audio and video stay together; cut only on word boundaries from `get_words`.
4. Remove filler ("um", "uh", "you know", "like," used as filler) when the cut lands cleanly between words; leave it if removing it would clip a neighbouring word.
5. Every 8–15 seconds of continuous talking, add a subtle punch-in on alternate clips (+6–10 % scale over the clip, via `add_keyframes` or `set_clip`) so jump cuts read as intentional. Never punch in on two adjacent clips with the same amount.
6. Fade the first clip in and the last clip out (0.3 s).
7. Run `validate`. Report the old and new duration and how many cuts you made.

Do not add music, transitions or effects unless asked.
