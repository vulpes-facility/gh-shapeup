import { ShapeUpError } from '../src/domain.mjs';
import { annotation, main } from '../src/board-action.mjs';

main().catch(error => {
  // Never log tokens, API response bodies, the Markdown inputs, Authorization headers, or fetch errors.
  console.log(annotation('error', error instanceof ShapeUpError ? error.message
    : 'Internal error in the board Action. Check the issue and the board before running it again.'));
  process.exitCode = 1;
});
