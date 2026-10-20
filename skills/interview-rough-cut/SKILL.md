---
name: interview-rough-cut
description: Build a rough cut from an interview — keep answers that matter, drop questions and tangents, keep it watchable in order.
---
# Interview rough cut

1. `get_overview`, then read the full transcript.
2. Identify question/answer pairs. Keep the interviewee's strongest answers (specific, complete thoughts of 5–40 s). Drop the interviewer's questions unless the user wants them.
3. Remove false starts and repeated takes; leave natural pauses (≤ 0.5 s).
4. Use `remove_range` for everything between kept answers (ripple) so there is no gap, with 6–10 frames of room around each answer.
5. Put a marker (`add_marker`) at the start of each answer with a 3–5 word label so the editor can navigate.
6. Optionally add captions in `default` style if asked.
7. `validate`; report which topics remain and the total duration.
