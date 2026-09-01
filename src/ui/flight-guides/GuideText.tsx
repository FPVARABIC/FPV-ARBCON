/**
 * Renders the guide's own inline notation, and nothing more.
 *
 * The reviewed text carries exactly two marks: `**bold**` for the phrase
 * that must not be skimmed past, and `` `code` `` for a Betaflight
 * identifier or a literal value. Both are meaning, not decoration - the
 * bold in "**Acro صحيح تمامًا للوووب**" is the sentence's whole point,
 * and `feedforward_boost` is a name the reader will type somewhere.
 *
 * This is NOT a markdown renderer and must not grow into one. Anything
 * beyond these two marks belongs in the guide package as prose, where it
 * is reviewed, rather than as syntax the app learns to interpret.
 *
 * DIRECTION. Arabic prose with Latin identifiers inside it, so every
 * paragraph declares rtl - the app-wide default would give it that
 * anyway, but a paragraph that states its own direction cannot be
 * re-decided by whatever happens to be its first strong character.
 */
import React from 'react';
import {StyleSheet, Text} from 'react-native';
import type {TextStyle} from 'react-native';

import {PROSE_MEASURE, colors, typography} from '../theme';

/** `**bold**` and `` `code` `` split into their own spans. */
const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`)/g;

export function GuideText({
  children,
  style,
  testID,
}: {
  readonly children: string;
  readonly style?: TextStyle | readonly TextStyle[];
  readonly testID?: string;
}): React.JSX.Element {
  const paragraphs = children.split('\n\n').filter(part => part.trim().length > 0);
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <Text
          key={`${index}-${paragraph.slice(0, 24)}`}
          style={[styles.body, style]}
          testID={index === 0 ? testID : undefined}>
          {paragraph.split(TOKEN).map((part, partIndex) => {
            const key = `${partIndex}-${part.slice(0, 16)}`;
            if (part.startsWith('**') && part.endsWith('**')) {
              return (
                <Text key={key} style={styles.strong}>
                  {part.slice(2, -2)}
                </Text>
              );
            }
            if (part.startsWith('`') && part.endsWith('`')) {
              return (
                <Text key={key} style={styles.code}>
                  {part.slice(1, -1)}
                </Text>
              );
            }
            return part;
          })}
        </Text>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  body: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'right',
    writingDirection: 'rtl', maxWidth: PROSE_MEASURE},
  strong: {fontWeight: '700', color: colors.textPrimary},
  /* An identifier the reader will type. Left-to-right because that is
     what it is, and it must not be reordered by the Arabic around it. */
  code: {...typography.mono, color: colors.accentStrong, writingDirection: 'ltr'},
});
