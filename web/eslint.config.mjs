// The linter for web/: the family base (tools-common's eslint.base.mjs,
// copied into build/ by `npm run build-copy` and checked against the pinned
// version by `just bundle-fresh`). Defect classes only, no opinions. no-undef
// stays on for .ts, as it always was here, and every .ts is in tsconfig.json,
// so none is linted in a default project.
import base from './build/eslint.base.mjs';

export default base({
  root: import.meta.dirname,
  testFiles: [],
  ambientGlobals: false,
});
