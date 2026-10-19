import { type Check, type EvalScenario, audioClips, captionStyle, check, clipId, isCaption, place, secs, sequenceDuration, sound, trackItems, videoClips } from './harness';

const text = (s: string) => ({ text: s });

/**
 * The agent evals. Each scenario is a plain-language request over a small synthetic project (interview.mp4, 60 s: speech at
 * 1.0–1.9 s and 5.0–6.0 s, silence 2.0–4.5 s, −24.1 LUFS, a scene cut at 3 s). `script` is a trajectory a competent agent would
 * take, so the suite also proves each outcome is reachable with the real tools; `checks` judge the *result*, not the path, so the
 * same checks score a live model.
 */
export const SCENARIOS: EvalScenario[] = [
  {
    id: 'remove-silence',
    title: 'Remove the long silence and keep A/V in sync',
    prompt: 'The silence in the middle of the interview is too long — take it out.',
    setup: (h) => place(h, 'm_int', 0, 0, 12),
    script: [
      () => ({ calls: [{ name: 'get_overview', args: {} }, { name: 'get_sequence', args: {} }, { name: 'get_silences', args: { mediaId: 'm_int' } }] }),
      () => ({ calls: [{ name: 'remove_range', args: { from: 2.1, to: 4.4 } }] }),
      () => ({ calls: [{ name: 'validate', args: {} }] }),
      () => text('Removed the silence between 2.1 s and 4.4 s; the speech on both sides is untouched.'),
    ],
    checks: ({ host, before }) => {
      const seq = host.sequence();
      const shorter = secs(before, sequenceDuration(before)) - secs(seq, sequenceDuration(seq));
      return [
        check('the silence is gone (≈2.3 s shorter)', shorter > 1.8 && shorter < 2.6, `timeline got ${shorter.toFixed(2)} s shorter`),
        check('speech before the silence is kept', videoClips(seq)[0]!.sourceIn === 0 && secs(seq, videoClips(seq)[0]!.duration) >= 2),
        check('video and audio were cut together', videoClips(seq).length === audioClips(seq).length && videoClips(seq).every((v, i) => v.start === audioClips(seq)[i]!.start && v.duration === audioClips(seq)[i]!.duration)),
        sound(host),
      ];
    },
  },
  {
    id: 'cut-filler-word',
    title: 'Cut a spoken "Um" using word timings',
    prompt: 'Cut the "um" out of the interview.',
    setup: (h) => place(h, 'm_int', 0, 0, 10),
    script: [
      () => ({ calls: [{ name: 'get_sequence', args: {} }, { name: 'search_transcript', args: { mediaId: 'm_int', query: 'um' } }] }),
      () => ({ calls: [{ name: 'get_words', args: { mediaId: 'm_int', from: 4.8, to: 6.2 } }] }),
      () => ({ calls: [{ name: 'remove_range', args: { from: 5.0, to: 5.4 } }] }),
      () => text('Cut the "Um" (5.0–5.4 s); "anyway." follows directly.'),
    ],
    checks: ({ host, before }) => {
      const seq = host.sequence();
      const removed = secs(before, sequenceDuration(before)) - secs(seq, sequenceDuration(seq));
      const v = videoClips(seq);
      // nothing of the "Um" (media 5.0–5.4) may remain; "anyway." (5.4–6.0) must
      const covers = (a: number, b: number) => v.some((c) => secs(seq, c.sourceIn) < b - 0.02 && secs(seq, c.sourceIn + c.duration) > a + 0.02);
      return [
        check('removed about 0.4 s', removed > 0.3 && removed < 0.6, `${removed.toFixed(2)} s`),
        check('the word "Um" is no longer on the timeline', !covers(5.0, 5.35)),
        check('the word "anyway." still is', covers(5.45, 5.95)),
        sound(host),
      ];
    },
  },
  {
    id: 'highlight-30s',
    title: 'Make a 30-second highlight from a long recording',
    prompt: 'Make me a 30 second highlight of the interview.',
    setup: () => undefined,
    script: [
      () => ({ calls: [{ name: 'get_overview', args: {} }, { name: 'get_transcript', args: { mediaId: 'm_int' } }, { name: 'get_scenes', args: { mediaId: 'm_int' } }] }),
      () => ({ calls: [{ name: 'add_clip', args: { mediaId: 'm_int', at: 0, sourceIn: 1, sourceOut: 12 } }, { name: 'add_clip', args: { mediaId: 'm_int', at: 11, sourceIn: 20, sourceOut: 31 } }, { name: 'add_clip', args: { mediaId: 'm_int', at: 22, sourceIn: 40, sourceOut: 48 } }] }),
      () => ({ calls: [{ name: 'validate', args: {} }] }),
      () => text('Built a 30 s highlight from three passages of the interview.'),
    ],
    checks: ({ host }) => {
      const seq = host.sequence();
      const d = secs(seq, sequenceDuration(seq));
      const v = videoClips(seq);
      return [
        check('about 30 s long (28–31)', d >= 28 && d <= 31, `${d.toFixed(2)} s`),
        check('built from several passages', v.length >= 2),
        check('contiguous: no gaps between clips', v.every((c, i) => i === 0 || c.start === v[i - 1]!.start + v[i - 1]!.duration)),
        check('has audio too', audioClips(seq).length >= v.length),
        sound(host),
      ];
    },
  },
  {
    id: 'captions-bold-pop',
    title: 'Add short-form captions from the transcript',
    prompt: 'Add bold pop captions in the style of TikTok.',
    setup: (h) => place(h, 'm_int', 0, 0, 8),
    script: [
      () => ({ calls: [{ name: 'get_sequence', args: {} }, { name: 'get_transcript', args: { mediaId: 'm_int', from: 0, to: 8 } }] }),
      () => ({ calls: [{ name: 'add_captions', args: { style: 'bold-pop', maxCharsPerLine: 20 } }, { name: 'get_captions', args: {} }] }),
      () => text('Added bold-pop captions from the transcript.'),
    ],
    checks: ({ host }) => {
      const seq = host.sequence();
      const caps = seq.tracks.filter((t) => t.kind === 'caption').flatMap((t) => trackItems(t).filter(isCaption));
      return [
        check('captions were created', caps.length >= 1),
        check('they use the requested style', caps.every((c) => c.styleId === 'bold-pop') && captionStyle('bold-pop').karaoke),
        check('captions carry the spoken words', caps.map((c) => c.words.map((w) => w.text).join(' ')).join(' ').toLowerCase().includes('hello')),
        check('captions do not overlap', caps.every((c, i) => i === 0 || c.start >= caps[i - 1]!.start + caps[i - 1]!.duration)),
        sound(host),
      ];
    },
  },
  {
    id: 'loudness-target',
    title: 'Bring dialogue to −16 LUFS using the measured loudness',
    prompt: 'Normalize the dialogue to -16 LUFS.',
    setup: (h) => place(h, 'm_int', 0, 0, 10),
    script: (h) => [
      () => ({ calls: [{ name: 'get_sequence', args: {} }, { name: 'get_loudness', args: { mediaId: 'm_int' } }] }),
      () => ({ calls: [{ name: 'set_clip', args: { clipId: audioClips(h.sequence())[0]!.id, gainDb: 8.1 } }] }),
      () => text('The interview measured −24.1 LUFS, so I raised it by 8.1 dB to reach −16 LUFS.'),
    ],
    checks: ({ host }) => {
      const gains = audioClips(host.sequence()).map((c) => c.audio.gainDb);
      return [check('audio gain ≈ +8.1 dB (target − measured)', gains.length > 0 && gains.every((g) => Math.abs(g - 8.1) < 0.6), `gains: ${gains.join(', ')}`), sound(host)];
    },
  },
  {
    id: 'dissolve-between-scenes',
    title: 'Add a dissolve between two clips',
    prompt: 'Put a one second dissolve between the first and second clip.',
    setup: (h) => {
      place(h, 'm_int', 0, 10, 15);
      place(h, 'm_int', 5, 30, 35);
    },
    script: (h) => [
      () => ({ calls: [{ name: 'get_sequence', args: {} }] }),
      () => ({ calls: [{ name: 'add_transition', args: { clipId: clipId(h, 0), type: 'dissolve', seconds: 1 } }] }),
      () => text('Added a 1 s cross dissolve at the cut.'),
    ],
    checks: ({ host }) => {
      const t = host.sequence().tracks.find((x) => x.name === 'V1')!.transitions;
      return [check('one dissolve exists', t.length === 1 && t[0]!.type === 'dissolve'), check('about one second long', t.length === 1 && Math.abs(secs(host.sequence(), t[0]!.duration) - 1) < 0.1), sound(host)];
    },
  },
  {
    id: 'question-no-edit',
    title: 'Answer a question without touching the timeline',
    prompt: 'How long is the timeline right now and which media is on it?',
    setup: (h) => place(h, 'm_int', 0, 0, 9),
    script: [() => ({ calls: [{ name: 'get_overview', args: {} }] }), () => text('The timeline is 9 seconds long and only uses interview.mp4.')],
    checks: ({ edits, summary, tools }) => [check('made no edits', edits === 0), check('looked before answering', tools.includes('get_overview') || tools.includes('get_sequence')), check('answered with the length', /\b9\b/.test(summary), summary)],
  },
  {
    id: 'ask-mode-denied',
    title: 'Respect a refused edit in Ask mode',
    prompt: 'Delete the first clip.',
    mode: 'ask',
    approve: () => false,
    setup: (h) => place(h, 'm_int', 0, 0, 6),
    script: (h) => [() => ({ calls: [{ name: 'get_sequence', args: {} }] }), () => ({ calls: [{ name: 'delete_clips', args: { clipIds: [clipId(h, 0)], ripple: true } }] }), () => text('You declined the deletion, so the timeline is unchanged.')],
    checks: ({ host, before, edits }) => [check('nothing changed', host.sequence() === before || JSON.stringify(videoClips(host.sequence()).map((c) => c.id)) === JSON.stringify(videoClips(before).map((c) => c.id))), check('no edits recorded', edits === 0)],
  },
  {
    id: 'recover-from-bad-id',
    title: 'Recover from a rejected edit (wrong clip id) instead of giving up',
    prompt: 'Cut the first clip in half.',
    setup: (h) => place(h, 'm_int', 0, 0, 10),
    script: (h) => [
      () => ({ calls: [{ name: 'split', args: { clipId: 'clip-1', at: 5 } }] }), // wrong id on purpose: the tool must explain
      () => ({ calls: [{ name: 'get_sequence', args: {} }] }),
      () => ({ calls: [{ name: 'split', args: { clipId: clipId(h, 0), at: 5 } }] }),
      () => text('Split the clip at 5 s.'),
    ],
    checks: ({ host }) => [check('the clip was split in two', videoClips(host.sequence()).length === 2), sound(host)],
  },
  {
    id: 'use-a-skill',
    title: 'Follow a skill when asked with /command',
    prompt: '/chapter-markers',
    setup: (h) => {
      place(h, 'm_int', 0, 0, 30);
      (h as { skills?: () => unknown[] }).skills = () => [{ name: 'chapter-markers', description: 'Add chapter markers based on topic changes in the transcript.', body: 'Read the transcript, add one marker per topic change with add_marker, then list the chapters.', source: 'builtin' }];
    },
    script: [
      () => ({ calls: [{ name: 'use_skill', args: { name: 'chapter-markers' } }, { name: 'get_transcript', args: { mediaId: 'm_int' } }] }),
      () => ({ calls: [{ name: 'add_marker', args: { time: 0, label: 'Intro' } }, { name: 'add_marker', args: { time: 5, label: 'The detour' } }] }),
      () => text('0:00 Intro\n0:05 The detour'),
    ],
    checks: ({ host, tools }): Check[] => [check('loaded the skill first', tools[0] === 'use_skill', tools.join(', ')), check('placed chapter markers', host.sequence().markers.length >= 2)],
  },
];
