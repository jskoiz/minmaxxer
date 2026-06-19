const DURATION_RE = /^(\d+(?:\.\d+)?)(s|m|h|d)$/i;

export function parseDurationSeconds(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("duration must be a string like 30m, 5h, or 3d");
  }

  const match = value.trim().match(DURATION_RE);
  if (!match) {
    throw new Error(`invalid duration: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
  }[unit];

  return Math.round(amount * multiplier);
}
