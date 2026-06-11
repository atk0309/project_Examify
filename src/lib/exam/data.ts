/* ============================================================================
   EXAMIFY — STATIC DATA
   ----------------------------------------------------------------------------
   - SUBJECTS: id, label, an icon key (see components/exam/icons.tsx), and an
     accent colour as OKLCH parts {l, c, h}. Storing chroma separately lets the
     saturation multiplier rescale every subject at once (c * sat).
   - QUESTIONS[subjectId][difficulty] is a list of PUBLIC questions — a
     discriminated union by `type`:
       · mcq:  { id, type:'mcq', q, choices }   (NO answer index here)
       · free: { id, type:'free', q }           (free-text; graded server-side)
     The correct answer index (mcq) and the rubric/maxScore (free) live in the
     SERVER-ONLY key store `answer-keys.server.ts`, keyed by question `id`, so
     they never ship to the browser.
   - This is a hand-authored SAMPLE bank (three starter subjects) meant to be
     replaced with your own content. See `docs/content-authoring.md` for the
     full authoring guide, including generating questions from your own source
     PDFs and the `provenance` convention in the key store.
   - To add a SUBJECT: add to SUBJECTS + a matching key in QUESTIONS + an icon.
     To add a DIFFICULTY: extend DIFFICULTIES + the matching QUESTIONS keys.
   - Every question needs a globally-unique `id` and a matching entry in
     ANSWER_KEYS (`answer-keys.server.ts`). See the bijection guard in
     `tests/unit/answer-keys.test.ts`.
   ========================================================================== */

import type { CSSProperties } from 'react';

export type DifficultyId = 'easy' | 'medium' | 'hard';

export type Subject = {
  id: string;
  label: string;
  icon: string;
  /** OKLCH lightness / chroma / hue parts for the per-subject accent. */
  l: number;
  c: number;
  h: number;
};

export type Difficulty = { id: DifficultyId; label: string; line: string };

/** A multiple-choice question. The correct index lives in ANSWER_KEYS, not here. */
export type McqQuestion = { id: string; type: 'mcq'; q: string; choices: string[] };
/** A free-text question. The rubric + maxScore live in ANSWER_KEYS, not here. */
export type FreeQuestion = { id: string; type: 'free'; q: string };
/** Public question shape shipped to the client — never carries answers/rubrics. */
export type Question = McqQuestion | FreeQuestion;

export type QuestionBank = Record<string, Partial<Record<DifficultyId, Question[]>>>;

export const EXAM_CONFIG = {
  length: 20, // questions per mini exam (falls back to bank size if smaller)
  shuffle: true, // shuffle question order each attempt
} as const;

export const DIFFICULTIES: Difficulty[] = [
  { id: 'easy', label: 'Easy', line: 'Warm up with the fundamentals.' },
  { id: 'medium', label: 'Medium', line: 'Solid practice at exam level.' },
  { id: 'hard', label: 'Hard', line: 'Stretch yourself with tougher problems.' },
];

/** Accent colours — palette 0 (muted, sophisticated). OKLCH parts. */
export const SUBJECTS: Subject[] = [
  { id: 'maths', label: 'Maths', icon: 'maths', l: 0.585, c: 0.062, h: 156 },
  {
    id: 'computer-science',
    label: 'Computer Science',
    icon: 'computer-science',
    l: 0.575,
    c: 0.08,
    h: 252,
  },
  { id: 'geography', label: 'Geography', icon: 'geography', l: 0.645, c: 0.085, h: 82 },
];

/** Saturation presets: muted · balanced · vivid (single chroma multiplier). */
export const SAT_MAP = { muted: 0.62, balanced: 1, vivid: 1.6 } as const;
export type Saturation = keyof typeof SAT_MAP;

/** Build runtime accent CSS custom properties from OKLCH parts + saturation. */
export function accentCSS(s: Subject, sat = 1): CSSProperties {
  const c = (s.c * sat).toFixed(4);
  return {
    '--accent': `oklch(${s.l} ${c} ${s.h})`,
    '--accent-ink': `oklch(${Math.max(s.l - 0.18, 0.34)} ${c} ${s.h})`,
    '--accent-tint': `oklch(0.955 ${(s.c * sat * 0.35).toFixed(4)} ${s.h})`,
    '--accent-soft': `oklch(0.9 ${(s.c * sat * 0.55).toFixed(4)} ${s.h})`,
  } as CSSProperties;
}

/* ---------------------------------------------------------------------------
   QUESTION BANK — hand-authored sample content (public fields only). Answers
   + rubrics live in answer-keys.server.ts, keyed by `id`. Note: a few ids
   (`maths-easy-1` first in its bank, `maths-hard-1`, `geography-medium-1`,
   `geography-medium-free-1/2`) are referenced by unit-test fixtures — keep
   them, or update the tests alongside (see docs/content-authoring.md).
   --------------------------------------------------------------------------- */
export const QUESTIONS: QuestionBank = {
  maths: {
    easy: [
      {
        id: 'maths-easy-1',
        type: 'mcq',
        q: 'What is 9 × 3?',
        choices: ['18', '24', '27', '36'],
      },
      {
        id: 'maths-easy-2',
        type: 'mcq',
        q: 'What is half of 18?',
        choices: ['6', '8', '9', '12'],
      },
      {
        id: 'maths-easy-3',
        type: 'mcq',
        q: 'Which of these numbers is even?',
        choices: ['7', '13', '21', '34'],
      },
      {
        id: 'maths-easy-4',
        type: 'mcq',
        q: 'What is 100 − 37?',
        choices: ['53', '63', '67', '73'],
      },
      {
        id: 'maths-easy-5',
        type: 'mcq',
        q: 'Which fraction is equal to one half?',
        choices: ['1/3', '2/4', '2/5', '3/4'],
      },
      {
        id: 'maths-easy-free-1',
        type: 'free',
        q: 'Explain how you would work out 15% of 200, then give the answer.',
      },
    ],
    medium: [
      {
        id: 'maths-medium-1',
        type: 'mcq',
        q: 'What is 3/4 written as a percentage?',
        choices: ['34%', '43%', '70%', '75%'],
      },
      {
        id: 'maths-medium-2',
        type: 'mcq',
        q: 'A rectangle is 4 cm wide and 6 cm long. What is its perimeter?',
        choices: ['10 cm', '20 cm', '24 cm', '26 cm'],
      },
      {
        id: 'maths-medium-3',
        type: 'mcq',
        q: 'What is 0.25 as a fraction in its simplest form?',
        choices: ['1/4', '2/5', '25/10', '1/3'],
      },
      {
        id: 'maths-medium-4',
        type: 'mcq',
        q: 'What is 7 × 8 − 6?',
        choices: ['50', '14', '56', '62'],
      },
      {
        id: 'maths-medium-5',
        type: 'mcq',
        q: 'Which number is a multiple of both 3 and 4?',
        choices: ['9', '16', '24', '32'],
      },
      {
        id: 'maths-medium-free-1',
        type: 'free',
        q: 'Explain the difference between the perimeter and the area of a shape.',
      },
    ],
    hard: [
      {
        id: 'maths-hard-1',
        type: 'mcq',
        q: 'Solve for x: 2x + 3 = 11',
        choices: ['3', '4', '5', '7'],
      },
      {
        id: 'maths-hard-2',
        type: 'mcq',
        q: 'What is the mean of 4, 6, 8 and 10?',
        choices: ['6', '7', '8', '28'],
      },
      {
        id: 'maths-hard-3',
        type: 'mcq',
        q: 'A shirt costs £40 in a sale with 20% off. What was the original price?',
        choices: ['£48', '£50', '£52', '£60'],
      },
      {
        id: 'maths-hard-4',
        type: 'mcq',
        q: 'What is 2⁵ (2 to the power of 5)?',
        choices: ['10', '16', '25', '32'],
      },
      {
        id: 'maths-hard-5',
        type: 'mcq',
        q: 'Which of these is a prime number?',
        choices: ['51', '57', '59', '63'],
      },
      {
        id: 'maths-hard-free-1',
        type: 'free',
        q: 'A train leaves at 09:40 and arrives at 11:15. Explain how to work out how long the journey took, then give the answer.',
      },
    ],
  },
  'computer-science': {
    easy: [
      {
        id: 'computer-science-easy-1',
        type: 'mcq',
        q: 'Which two digits does binary use?',
        choices: ['0 and 1', '1 and 2', '0 and 9', '1 and 10'],
      },
      {
        id: 'computer-science-easy-2',
        type: 'mcq',
        q: 'What does CPU stand for?',
        choices: [
          'Computer Power Unit',
          'Central Processing Unit',
          'Central Program Utility',
          'Core Print Unit',
        ],
      },
      {
        id: 'computer-science-easy-3',
        type: 'mcq',
        q: 'Which of these is an input device?',
        choices: ['Monitor', 'Printer', 'Keyboard', 'Speaker'],
      },
      {
        id: 'computer-science-easy-4',
        type: 'mcq',
        q: 'Which of these is an example of software?',
        choices: ['A web browser', 'A mouse', 'A hard drive', 'A USB cable'],
      },
      {
        id: 'computer-science-easy-5',
        type: 'mcq',
        q: 'What is the name for a set of step-by-step instructions a computer follows?',
        choices: ['A database', 'An algorithm', 'A network', 'A pixel'],
      },
      {
        id: 'computer-science-easy-free-1',
        type: 'free',
        q: 'Explain in your own words what an algorithm is, and give one everyday example.',
      },
    ],
    medium: [
      {
        id: 'computer-science-medium-1',
        type: 'mcq',
        q: 'What is the binary number 101 in decimal?',
        choices: ['3', '5', '7', '101'],
      },
      {
        id: 'computer-science-medium-2',
        type: 'mcq',
        q: 'Which of these units of storage is the largest?',
        choices: ['Kilobyte', 'Megabyte', 'Gigabyte', 'Byte'],
      },
      {
        id: 'computer-science-medium-3',
        type: 'mcq',
        q: 'What does RAM lose when the computer is switched off?',
        choices: ['Its contents', 'Its speed', 'Its size', 'Nothing'],
      },
      {
        id: 'computer-science-medium-4',
        type: 'mcq',
        q: 'In programming, what is a loop used for?',
        choices: [
          'Storing a single value',
          'Repeating instructions',
          'Drawing shapes',
          'Connecting to Wi-Fi',
        ],
      },
      {
        id: 'computer-science-medium-5',
        type: 'mcq',
        q: 'How many different values can one bit represent?',
        choices: ['1', '2', '8', '256'],
      },
      {
        id: 'computer-science-medium-free-1',
        type: 'free',
        q: 'Explain why computers store and process data in binary.',
      },
    ],
    hard: [
      {
        id: 'computer-science-hard-1',
        type: 'mcq',
        q: 'What is the binary number 1101 in decimal?',
        choices: ['11', '12', '13', '14'],
      },
      {
        id: 'computer-science-hard-2',
        type: 'mcq',
        q: 'How many different values can 10 bits represent (2¹⁰)?',
        choices: ['100', '512', '1000', '1024'],
      },
      {
        id: 'computer-science-hard-3',
        type: 'mcq',
        q: 'In the fetch–decode–execute cycle, which component decodes and executes instructions?',
        choices: ['The CPU', 'The hard drive', 'The power supply', 'The monitor'],
      },
      {
        id: 'computer-science-hard-4',
        type: 'mcq',
        q: 'What is the decimal number 9 in binary?',
        choices: ['1001', '1010', '1011', '1100'],
      },
      {
        id: 'computer-science-hard-5',
        type: 'mcq',
        q: 'Which of these is an example of secondary storage?',
        choices: ['RAM', 'CPU cache', 'A solid-state drive (SSD)', 'A register'],
      },
      {
        id: 'computer-science-hard-free-1',
        type: 'free',
        q: 'Explain the difference between hardware and software, giving one example of each.',
      },
    ],
  },
  geography: {
    easy: [
      {
        id: 'geography-easy-1',
        type: 'mcq',
        q: 'What is the capital city of France?',
        choices: ['Lyon', 'Marseille', 'Paris', 'Nice'],
      },
      {
        id: 'geography-easy-2',
        type: 'mcq',
        q: 'Which is the largest ocean on Earth?',
        choices: ['Atlantic', 'Indian', 'Arctic', 'Pacific'],
      },
      {
        id: 'geography-easy-3',
        type: 'mcq',
        q: 'How many continents are there?',
        choices: ['5', '6', '7', '8'],
      },
      {
        id: 'geography-easy-4',
        type: 'mcq',
        q: 'Which of these is a river?',
        choices: ['The Andes', 'The Nile', 'The Sahara', 'The Alps'],
      },
      {
        id: 'geography-easy-5',
        type: 'mcq',
        q: 'Which instrument is used to measure rainfall?',
        choices: ['Thermometer', 'Barometer', 'Rain gauge', 'Anemometer'],
      },
      {
        id: 'geography-easy-free-1',
        type: 'free',
        q: 'Name as many of the seven continents as you can.',
      },
    ],
    medium: [
      {
        id: 'geography-medium-1',
        type: 'mcq',
        q: 'What is the capital city of Australia?',
        choices: ['Sydney', 'Melbourne', 'Canberra', 'Perth'],
      },
      {
        id: 'geography-medium-2',
        type: 'mcq',
        q: 'Which line of latitude sits at 0°?',
        choices: ['The equator', 'The Tropic of Cancer', 'The prime meridian', 'The Arctic Circle'],
      },
      {
        id: 'geography-medium-3',
        type: 'mcq',
        q: 'What is erosion?',
        choices: [
          'The wearing away and removal of rock or soil',
          'The build-up of new rock layers',
          'The freezing of water in cracks',
          'The growth of river deltas',
        ],
      },
      {
        id: 'geography-medium-4',
        type: 'mcq',
        q: 'Which of these countries is in South America?',
        choices: ['Spain', 'Mexico', 'Peru', 'Portugal'],
      },
      {
        id: 'geography-medium-5',
        type: 'mcq',
        q: "What is the name for molten rock once it reaches the Earth's surface?",
        choices: ['Magma', 'Lava', 'Granite', 'Basalt'],
      },
      {
        id: 'geography-medium-free-1',
        type: 'free',
        q: 'Explain the difference between weather and climate.',
      },
      {
        id: 'geography-medium-free-2',
        type: 'free',
        q: 'Explain why many major cities are located near rivers. Give two reasons.',
      },
    ],
    hard: [
      {
        id: 'geography-hard-1',
        type: 'mcq',
        q: 'What is the capital city of Canada?',
        choices: ['Toronto', 'Vancouver', 'Montreal', 'Ottawa'],
      },
      {
        id: 'geography-hard-2',
        type: 'mcq',
        q: 'Where do most earthquakes happen?',
        choices: [
          'At the boundaries between tectonic plates',
          'In the middle of continents',
          'Only under oceans',
          'Near the equator',
        ],
      },
      {
        id: 'geography-hard-3',
        type: 'mcq',
        q: 'Which of these best describes a meander?',
        choices: ['A bend in a river', 'A waterfall', 'A glacier', 'A sand dune'],
      },
      {
        id: 'geography-hard-4',
        type: 'mcq',
        q: "Roughly what percentage of the Earth's surface is covered by water?",
        choices: ['50%', '60%', '70%', '90%'],
      },
      {
        id: 'geography-hard-5',
        type: 'mcq',
        q: 'Which biome is hot all year round with very high rainfall?',
        choices: ['Desert', 'Tundra', 'Tropical rainforest', 'Savanna'],
      },
      {
        id: 'geography-hard-free-1',
        type: 'free',
        q: 'Explain one advantage and one disadvantage of living near a river.',
      },
    ],
  },
};

export function countQuestions(subjectId: string): number {
  const bank = QUESTIONS[subjectId] ?? {};
  return Object.values(bank).reduce((n, arr) => n + (arr?.length ?? 0), 0);
}

/**
 * Look up a public question by `id` within a specific subject + difficulty bank.
 * Used by the server-side scorer to resolve a submitted item's snapshot (and,
 * via the parallel ANSWER_KEYS entry, its correct answer / rubric).
 */
export function questionById(
  subjectId: string,
  difficulty: DifficultyId,
  id: string,
): Question | undefined {
  const bank = QUESTIONS[subjectId]?.[difficulty] ?? [];
  return bank.find((q) => q.id === id);
}

export function shuffle<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Build a mini exam: pick up to EXAM_CONFIG.length questions for the bank. */
export function buildExam(subjectId: string, difficulty: DifficultyId): Question[] {
  const bank = QUESTIONS[subjectId]?.[difficulty] ?? [];
  const list = EXAM_CONFIG.shuffle ? shuffle(bank) : bank.slice();
  return list.slice(0, Math.min(EXAM_CONFIG.length, list.length));
}

/**
 * Reconstruct an ordered `Question[]` from a persisted list of ids — used to
 * resume a saved in-progress exam back into the EXACT paper (and order) the user
 * was sitting, without re-shuffling via `buildExam`. Ids are looked up across the
 * whole subject bank (every difficulty), preserving the given order. Unknown ids
 * (the bank was edited since the session was saved) are DROPPED; the caller
 * compares the survivor count to the stored id count to decide whether the
 * session is still resumable or should be discarded. Pure + client-safe (no
 * answer keys) — only the public `QUESTIONS` bank is referenced.
 */
export function questionsByIds(subjectId: string, ids: string[]): Question[] {
  const banks = QUESTIONS[subjectId] ?? {};
  const byId = new Map<string, Question>();
  for (const list of Object.values(banks)) {
    for (const q of list ?? []) byId.set(q.id, q);
  }
  return ids.map((id) => byId.get(id)).filter((q): q is Question => q !== undefined);
}
