export function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(
      /\b(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))\s*[=:]\s*[^\s]+/gi,
      "[redacted]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
}

export function truncateText(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (
    end > 0 &&
    encoder.encode(value.slice(0, end)).byteLength > maxBytes - 3
  ) {
    end -= 1;
  }
  return `${value.slice(0, end)}...`;
}
