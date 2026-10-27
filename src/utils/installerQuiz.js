// The technical questions an installer answers after signing up. The installer never sees a score or which answers
// were right: the admin sees the summary and decides. The correct answers stay on the server.
const q = (id, topic, prompt, options, correct) => ({ id, topic, prompt, options: options.map((text, i) => ({ id: 'abcd'[i], text })), correct: 'abcd'[correct] });

export const QUIZ = [
  q('isolate', 'Safety', 'You are about to work on the wiring between the panels and the inverter at midday. What do you do first?',
    ['Cover the panels with a cloth and start working', 'Switch off and isolate the DC and AC sources, and still treat the panel wires as live while there is daylight', 'Wear rubber slippers and work quickly', 'Wait until the inverter beeps, then start'], 1),
  q('series', 'Wiring', 'Two panels, each 40 V and 10 A, are connected in series. What do you get across the pair?',
    ['40 V and 20 A', '80 V and 10 A', '80 V and 20 A', '40 V and 10 A'], 1),
  q('batteries-series', 'Wiring', 'Two 12 V 200 Ah batteries are connected in series. The bank becomes:',
    ['12 V 400 Ah', '24 V 200 Ah', '24 V 400 Ah', '12 V 200 Ah'], 1),
  q('battery-energy', 'Sizing', 'Roughly how much energy does one 12 V 200 Ah battery store?',
    ['240 Wh', '2.4 kWh', '24 kWh', '200 kWh'], 1),
  q('inverter-size', 'Sizing', 'A customer runs 2,400 W of appliances at once. Before allowing for motors starting up, what is the smallest sensible inverter?',
    ['1 kVA', '1.5 kVA', '2 kVA', '3 kVA'], 3),
  q('surge', 'Troubleshooting', 'A customer says the inverter trips on overload each time the fridge starts, although the fridge uses only 150 W when running. Most likely cause?',
    ['The fridge motor draws a short, much larger current at start-up that exceeds what the inverter can supply', 'The panels are too clean', 'The battery is too full', 'The fridge is too cold'], 0),
  q('cable', 'Wiring', 'Why does the cable thickness matter between the battery and the inverter?',
    ['It does not matter if the cable is new', 'Cables that are too thin overheat and lose voltage, which can cause trips, damage or fire', 'Thicker cables make the battery last longer', 'Only the colour matters'], 1),
  q('breaker', 'Protection', 'Where should a correctly rated DC fuse or breaker be placed in a battery-to-inverter connection?',
    ['Nowhere: it wastes power', 'Close to the battery, in the positive line', 'Only on the inverter output', 'Only on the panels'], 1),
  q('earthing', 'Protection', 'What is the main purpose of properly earthing the array frames and the inverter?',
    ['To make the system produce more power', 'To give fault current and lightning or surge energy a safe path, protecting people and equipment', 'To keep the batteries charged', 'To remove the need for breakers'], 1),
  q('mppt', 'Components', 'Compared with a PWM charge controller, what is the main advantage of an MPPT controller?',
    ['It is cheaper', 'It tracks the panel\'s best operating point and so harvests more energy, especially when the panel voltage is higher than the battery voltage', 'It does not need a battery', 'It makes panels face the sun'], 1),
  q('voc', 'Wiring', 'The panels in a string produce an open-circuit voltage (Voc) higher than the inverter\'s maximum input voltage. What happens?',
    ['Nothing, the inverter limits it by itself', 'The inverter can be damaged, so the string must be redesigned and cold-weather voltage rise allowed for', 'The battery charges faster', 'The panels turn off'], 1),
  q('orientation', 'Installation', 'In Nigeria, which way should fixed roof or ground panels normally face, for the best yearly energy?',
    ['North', 'South, at a modest tilt (roughly 10 to 15 degrees)', 'West, flat', 'East, vertical'], 1),
  q('mixing', 'Batteries', 'Can you add a new battery to an old bank, or mix different types or capacities in one bank?',
    ['Yes, it always works', 'No: batteries in one bank should be the same type, capacity and age, or the weaker ones drag down and damage the rest', 'Only on Sundays', 'Yes, if the colours match'], 1),
  q('ventilation', 'Batteries', 'Why must lead-acid (flooded) batteries be in a ventilated place away from sparks?',
    ['They give off hydrogen gas that can explode', 'They are heavy', 'They need sunlight', 'They are noisy'], 0),
  q('height', 'Safety', 'You are installing panels on a roof. Which is the safest practice?',
    ['Work alone and quickly', 'Use a secured ladder, fall protection, and work with a second person, and stay off wet or weak roofing', 'Carry panels one-handed while climbing', 'Work in the rain to keep cool'], 1),
  q('handover', 'Customer care', 'The system is installed and working. What should you do before you leave?',
    ['Leave quietly to save time', 'Test every circuit under load, show the customer how it works and what the lights or readings mean, and note anything they must not do', 'Ask the customer to test it later', 'Switch the breakers off and leave'], 1),
];

const byId = new Map(QUIZ.map((x) => [x.id, x]));

// What the installer sees: the questions without the answers.
export const publicQuiz = () => QUIZ.map(({ id, topic, prompt, options }) => ({ id, topic, prompt, options }));

// `answers` maps a question id to an option id. Unanswered counts as wrong. Returns what the admin needs to review.
export function scoreQuiz(answers) {
  const detail = QUIZ.map((qn) => {
    const chosen = answers?.[qn.id] ?? null;
    return { id: qn.id, topic: qn.topic, prompt: qn.prompt, chosen, chosenText: qn.options.find((o) => o.id === chosen)?.text ?? null, correct: chosen === qn.correct, correctText: qn.options.find((o) => o.id === qn.correct).text };
  });
  return { score: detail.filter((d) => d.correct).length, total: QUIZ.length, detail };
}

export const validQuizAnswers = (answers) => Boolean(answers) && QUIZ.every((qn) => qn.options.some((o) => o.id === answers[qn.id]));
export const quizQuestion = (id) => byId.get(id);
