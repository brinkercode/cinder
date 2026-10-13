// Fake Workers AI binding for the clef backends: answer(model, body) gets the catalog model ID, the System One
// request and the run options, and returns System One answers (or throws, as a failed call). @1 reads them from the
// prompt; @2 speaks Clef's own API as Workers AI publishes it ({model, state, questions: {type, instructions, criteria}}
// in, typed answers out), translated back here so tests read and write System One.
// Instructions are the question, then its guide after a blank line: tests read the question as prompt.
const fromClefQuestions = (questions) => Object.fromEntries(Object.entries(questions).map(([n, q]) => [n, q.type === "choice"
  ? { kind: "choice", prompt: q.instructions.split("\n\n")[0], options: Object.keys(q.criteria) } : { kind: "noul", prompt: q.instructions.split("\n\n")[0] }]));
const toClefAnswers = (answers) => Object.fromEntries(Object.entries(answers ?? {}).map(([n, a]) => [n, a && typeof a === "object"
  ? { type: "choice", choice: Object.entries(a).sort((x, y) => y[1] - x[1])[0]?.[0], probabilities: a, confidence: 1 } : { type: "noul", noul: a }]));
export const fakeClefAI = (answer) => ({
  run: async (model, input, options) => input.messages
    ? { response: { answers: await answer(model, JSON.parse(input.messages.at(-1).content), options) } }
    : { model: input.model, answers: toClefAnswers(await answer(model, { state: input.state, questions: fromClefQuestions(input.questions) }, options)), usage: { input_tokens: 0, output_tokens: 0 } },
});
