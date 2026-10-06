import type { QuestionDraft } from '../generation/schema'

// One valid draft of every item type, used by tests and the ADAPT parser check.
const base = {
  concept_label: 'Photosynthesis',
  explanation: 'Plants take in carbon dioxide and release oxygen; see \\(6\\,CO_2 + 6\\,H_2O \\rightarrow C_6H_{12}O_6 + 6\\,O_2\\).',
  bloom: 'remember' as const,
  difficulty: 'easy' as const,
  citation_paragraphs: [0, 1],
}

export const SAMPLE_DRAFTS: QuestionDraft[] = [
  {
    ...base,
    item_type: 'multiple_choice',
    title: 'Gas absorbed in photosynthesis',
    stem: 'Which gas do plants absorb during photosynthesis?\n\nChoose the best answer & explain to yourself why "x < y" fails.',
    choices: [
      { text: 'Oxygen', correct: false, feedback: 'Oxygen is released, not absorbed.' },
      { text: 'Carbon dioxide', correct: true, feedback: null },
      { text: 'Nitrogen', correct: false, feedback: null },
      { text: '<b>Helium</b>', correct: false, feedback: null },
    ],
  },
  {
    ...base,
    item_type: 'true_false',
    title: 'Oxygen is a product',
    stem: 'Oxygen is a product of photosynthesis.',
    answer: true,
  },
  {
    ...base,
    item_type: 'multiple_answers',
    title: 'Inputs of photosynthesis',
    stem: 'Select all inputs of photosynthesis.',
    choices: [
      { text: 'Water', correct: true, feedback: null },
      { text: 'Carbon dioxide', correct: true, feedback: null },
      { text: 'Glucose', correct: false, feedback: 'Glucose is a product.' },
    ],
  },
  {
    ...base,
    item_type: 'numerical',
    title: 'Oxygen molecules per glucose',
    stem: 'How many \\(O_2\\) molecules are released per glucose molecule formed?',
    answer: 6,
    tolerance: 0.1,
    units: null,
  },
  {
    ...base,
    item_type: 'matching',
    title: 'Match the molecules',
    stem: 'Match each formula to its molecule.',
    pairs: [
      { prompt: 'CO2', match: 'Carbon dioxide' },
      { prompt: 'H2O', match: 'Water' },
      { prompt: 'O2', match: 'Oxygen' },
    ],
    distractors: ['Nitrogen'],
  },
  {
    ...base,
    item_type: 'fill_in_blank',
    title: 'Pigment name',
    stem: 'The green pigment that captures light is called ____.',
    answer: 'chlorophyll',
    alternates: ['chlorophyll a'],
  },
  {
    ...base,
    item_type: 'dropdowns',
    title: 'Inputs and outputs',
    stem: 'Plants absorb [gasin] and release [gasout].',
    blanks: [
      { id: 'gasin', correct: 'carbon dioxide', distractors: ['oxygen', 'nitrogen'] },
      { id: 'gasout', correct: 'oxygen', distractors: ['carbon dioxide'] },
    ],
  },
  {
    ...base,
    item_type: 'essay',
    title: 'Why leaves are green',
    stem: 'Explain why most leaves appear green.',
    model_answer: 'Chlorophyll absorbs red and blue light and reflects green light.',
    bloom: 'understand',
  },
  {
    ...base,
    item_type: 'math',
    title: 'Rate of oxygen release',
    stem: 'A leaf releases {{v}} mL of oxygen in {{t}} minutes. At what average rate does it release oxygen?',
    explanation: 'Rate is volume over time: \\(r = \\frac{ {{v}} }{ {{t}} }\\) = {{answer}} mL/min, about {{v/t*60}} mL per hour.',
    variables: [
      { name: 'v', min: 2, max: 12, step: 0.5 },
      { name: 't', min: 4, max: 20, step: 1 },
    ],
    constraints: ['v < t'],
    answer_formula: 'v / t',
    tolerance_percent: 1,
    units: 'mL/min',
    bloom: 'apply',
  },
]
