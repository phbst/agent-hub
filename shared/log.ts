const sensitiveKey = /key|password|secret|token|authorization|credential/i;

function clean(value: unknown, key = ""): unknown {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => clean(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, clean(child, childKey)]));
  }
  return value;
}

export function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify(clean({ timestamp: new Date().toISOString(), event, ...fields }))}\n`);
}
