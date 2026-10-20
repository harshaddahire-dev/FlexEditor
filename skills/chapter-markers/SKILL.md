---
name: chapter-markers
description: Add chapter markers (and a chapter list in the reply) based on topic changes in the transcript.
---
# Chapter markers

1. `get_overview`, then read the transcripts of the media on the timeline with `get_transcript`.
2. Map transcript sections to timeline time with `get_sequence` (clips map media time → timeline time through sourceIn/start/speed).
3. Split the content into 3–10 chapters at clear topic changes (new question, "next", "let's move on"). Each chapter ≥ 20 s.
4. Add one marker per chapter with `add_marker` at the timeline time (title ≤ 5 words; the first chapter at 0:00).
5. Reply with the chapter list as `m:ss Title` lines the user can paste into a video description.
