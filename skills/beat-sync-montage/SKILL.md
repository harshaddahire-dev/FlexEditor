---
name: beat-sync-montage
description: Cut a montage so its cuts land on the beats of a music track.
---
# Beat-synced montage

1. `get_overview`; identify the music media (audio, with beats) and the visual media.
2. `get_beats` for the music: use tempo and the beat times (media time). Decide on cutting every 1, 2 or 4 beats — faster for energetic tracks (> 120 BPM → every 2 beats, slower → every beat).
3. Place the music on A1 first (`add_clip`), then lay video clips back to back so every cut falls on a beat time (convert to timeline time through the music clip placement). Cuts snap to frames; choose the nearest frame and accept < 1 frame of drift.
4. Vary clip sources; use `get_scenes` to start each clip at an interesting moment. Mute the video clips' own audio with `set_clip gainDb` (or leave it if the user wants ambience at −18 dB).
5. Fade the music out over the last 2 s and end the picture on the last downbeat.
6. `validate`; report BPM, cut spacing and count.
