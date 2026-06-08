/**
 * Command deprecation notices.
 *
 * 0.2.0 renames the command surface (see CHANGELOG). Old commands keep working
 * but print a one-time stderr warning pointing to the replacement. Hard removal
 * is targeted for 0.3.0.
 */

const REMOVAL_VERSION = '0.3.0';
const warned = new Set<string>();

/**
 * Print a deprecation warning to stderr once per process for a given command.
 * Safe to call at the top of a command action.
 */
export function warnDeprecated(oldCmd: string, newCmd: string, removalVersion: string = REMOVAL_VERSION): void {
  if (warned.has(oldCmd)) return;
  warned.add(oldCmd);
  process.stderr.write(
    `\x1b[33mwarning:\x1b[0m \`subnet ${oldCmd}\` is deprecated and will be removed in ${removalVersion}. ` +
    `Use \`subnet ${newCmd}\` instead.\n`,
  );
}
