// Terminal UI helpers: ANSI colors (TTY/NO_COLOR aware), status badges matching the web palette,
// and tables that align correctly with CJK double-width characters.

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

const wrap = (open: number, close = 39) => (text: string): string =>
  useColor ? `[${open}m${text}[${close}m` : text;

export const bold = (text: string): string => (useColor ? `[1m${text}[22m` : text);
export const dim = (text: string): string => (useColor ? `[2m${text}[22m` : text);
export const green = wrap(32);
export const red = wrap(31);
export const yellow = wrap(33);
export const blue = wrap(34);
export const cyan = wrap(36);
export const gray = wrap(90);

const statusColors: Record<string, (text: string) => string> = {
  done: green, online: green,
  running: blue, claimed: blue,
  pending: yellow, assigned: yellow, waiting_input: yellow, pending_approval: yellow, timeout: yellow, offline: gray,
  failed: red, cancelled: red, revoked: red,
};

export function badge(status: string): string {
  const paint = statusColors[status] ?? gray;
  return paint(`● ${status}`);
}

const ansiPattern = /\[[0-9;]*m/g;

// Rough display width: CJK and full-width characters occupy two columns.
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text.replace(ansiPattern, "")) {
    const code = char.codePointAt(0)!;
    width += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0x20000 && code <= 0x3fffd)) ? 2 : 1;
  }
  return width;
}

export function padEndVisual(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

export function truncateVisual(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  let result = "";
  let width = 0;
  for (const char of text) {
    const next = width + displayWidth(char);
    if (next > max - 1) break;
    result += char;
    width = next;
  }
  return `${result}…`;
}

export interface TableColumn {
  header: string;
  max?: number;
}

export function table(columns: TableColumn[], rows: string[][]): string {
  const prepared = rows.map((row) => row.map((cell, index) => {
    const max = columns[index]?.max;
    return max ? truncateVisual(cell, max) : cell;
  }));
  const widths = columns.map((column, index) =>
    Math.max(displayWidth(column.header), ...prepared.map((row) => displayWidth(row[index] ?? ""))));
  const padCell = (cell: string, index: number): string => {
    const padding = widths[index]! - displayWidth(cell);
    return cell + (padding > 0 ? " ".repeat(padding) : "");
  };
  const lines = [dim(columns.map((column, index) => padCell(column.header, index)).join("  "))];
  for (const row of prepared) lines.push(row.map(padCell).join("  "));
  return lines.join("\n");
}

export function heading(text: string): string {
  return `\n${bold(text)}`;
}

export function kv(pairs: Array<[string, string]>): string {
  const width = Math.max(...pairs.map(([label]) => displayWidth(label)));
  return pairs.map(([label, value]) => `${dim(padEndVisual(label, width))}  ${value}`).join("\n");
}

export const ok = (text: string): string => `${green("✔")} ${text}`;
export const err = (text: string): string => `${red("✘")} ${text}`;
export const note = (text: string): string => dim(text);
