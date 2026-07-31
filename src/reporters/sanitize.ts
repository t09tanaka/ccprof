const OSC_STRING =
  /(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u001B\\|\u009C|$)/gu;
const ST_STRING =
  /(?:\u001B[\u0050\u0058\u005E\u005F]|[\u0090\u0098\u009E\u009F])[\s\S]*?(?:\u001B\\|\u009C|$)/gu;
const CSI_SEQUENCE =
  /(?:\u001B\[|\u009B)[0-?]*[ -/]*(?:[@-~]|$)/gu;
const ESC_SEQUENCE = /\u001B[ -/]*[0-~]/gu;
const ESC_CHARACTER = /\u001B/gu;
const C0_C1_CONTROL = /[\u0000-\u001F\u007F-\u009F]/gu;

/**
 * Removes terminal control strings and escape sequences from text before it
 * reaches a human-readable reporter. JSON output deliberately bypasses this
 * boundary so its structural values remain unchanged.
 */
export function sanitizeHumanText(value: string): string {
  return value
    .replace(OSC_STRING, " ")
    .replace(ST_STRING, " ")
    .replace(CSI_SEQUENCE, "")
    .replace(ESC_SEQUENCE, "")
    .replace(ESC_CHARACTER, "")
    .replace(C0_C1_CONTROL, " ");
}
