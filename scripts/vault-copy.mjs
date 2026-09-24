/**
 * The three candidate-PIN verdicts, spelled once.
 *
 * `secret_verdict` in `src-tauri/src/credentials.rs` composes these sentences from
 * the alphabet a six-character PIN uses and the arithmetic behind `M_COST_KIB`.
 * Both scripts need the same three answers back from their stand-in for Rust, and
 * a wording kept in two places is exactly the copy that drifts — so the *text*
 * lives here, and the stand-ins pick one by shape.
 *
 * It has to arrive as data rather than as a helper: a mock is passed to
 * `evaluateOnNewDocument`, which serialises the function, so nothing in this file
 * is in scope inside it. `SECRET_SENTENCES` is handed in as the mock's argument.
 */
export const SECRET_SENTENCES = {
  weak:
    'Weak: 6 digits — 1,000,000 combinations, about 7 days on one core or 21 hours across eight. ' +
    'One letter makes that number useless.',
  average:
    'Average: 6 letters — 308,915,776 combinations, about 6 years on one core or 9 months across eight. ' +
    'One digit makes that number useless.',
  strong:
    'Strong: 6 letters and digits — 2,176,782,336 combinations, about 41 years on one core or 5 years across eight.'
};
