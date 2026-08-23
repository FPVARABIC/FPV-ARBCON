/**
 * SPLITTING A SOURCE FILE INTO WHAT RUNS AND WHAT ONLY DOCUMENTS.
 *
 * Several sweeps need this: the operator-vocabulary wall, the protocol
 * vocabulary wall, and the PID legacy sweep all ask "does this phrase
 * appear in EXECUTABLE code?", because the same word is welcome in a
 * comment explaining why it is gone and forbidden in a rendered string.
 *
 * It lives here rather than inside one of those suites so importing it
 * does not drag that suite's several hundred assertions into another
 * file's run.
 */
/**
 * Splits a source file into the half that executes and the half that
 * only documents, preserving every offset.
 *
 * Both halves are the same length as the input: whatever does not belong
 * to a half is blanked to spaces rather than removed. That is what makes
 * the per-file reconciliation below meaningful — a character cannot be
 * counted twice, and cannot vanish.
 *
 * Template literals are tracked through `${...}` because an interpolation
 * is ordinary code that may contain its own strings and comments, and a
 * naive backtick-to-backtick scan would swallow it.
 */
export function splitCodeAndComments(source: string): {
  readonly code: string;
  readonly comments: string;
} {
  const code: string[] = [];
  const comments: string[] = [];
  /** Non-empty while inside template literals; counts `{` depth per level. */
  const templateStack: number[] = [];
  let index = 0;
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' =
    'code';

  const emit = (character: string, isComment: boolean): void => {
    const blank = character === '\n' ? '\n' : ' ';
    code.push(isComment ? blank : character);
    comments.push(isComment ? character : blank);
  };

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (state === 'line') {
      emit(character, true);
      if (character === '\n') {
        state = 'code';
      }
      index += 1;
      continue;
    }

    if (state === 'block') {
      if (character === '*' && next === '/') {
        emit(character, true);
        emit(next, true);
        state = 'code';
        index += 2;
        continue;
      }
      emit(character, true);
      index += 1;
      continue;
    }

    if (state === 'single' || state === 'double' || state === 'template') {
      emit(character, false);
      if (character === '\\') {
        // Escaped character: consume it verbatim so a `\'` cannot end the
        // string and a `\\` cannot escape the quote that follows it.
        if (index + 1 < source.length) {
          emit(next, false);
        }
        index += 2;
        continue;
      }
      if (
        (state === 'single' && character === "'") ||
        (state === 'double' && character === '"') ||
        (state === 'template' && character === '`')
      ) {
        state = 'code';
        index += 1;
        continue;
      }
      if (state === 'template' && character === '$' && next === '{') {
        emit(next, false);
        // Back to real code until the matching brace closes.
        templateStack.push(0);
        state = 'code';
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    // state === 'code'
    if (character === '/' && next === '/') {
      emit(character, true);
      emit(next, true);
      state = 'line';
      index += 2;
      continue;
    }
    if (character === '/' && next === '*') {
      emit(character, true);
      emit(next, true);
      state = 'block';
      index += 2;
      continue;
    }
    emit(character, false);
    if (character === "'") {
      state = 'single';
    } else if (character === '"') {
      state = 'double';
    } else if (character === '`') {
      state = 'template';
    } else if (templateStack.length > 0 && character === '{') {
      templateStack[templateStack.length - 1] += 1;
    } else if (templateStack.length > 0 && character === '}') {
      if (templateStack[templateStack.length - 1] === 0) {
        templateStack.pop();
        state = 'template';
      } else {
        templateStack[templateStack.length - 1] -= 1;
      }
    }
    index += 1;
  }

  return {code: code.join(''), comments: comments.join('')};
}
