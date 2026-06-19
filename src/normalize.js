function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resetDescription(secondsUntilReset) {
  if (secondsUntilReset === null) return null;
  if (secondsUntilReset <= 0) return "now";
  const minutes = Math.round(secondsUntilReset / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function normalizeWindow(raw, nowMs = Date.now()) {
  if (!raw) return null;
  const used = toNumber(raw.usedPercent ?? raw.used_percent);
  const windowMinutes = toNumber(raw.windowDurationMins ?? raw.window_minutes);
  const resetEpochSeconds = toNumber(raw.resetsAt ?? raw.resets_at);
  const resetsAt = resetEpochSeconds ? new Date(resetEpochSeconds * 1000) : null;
  const secondsUntilReset = resetsAt ? Math.max(0, Math.round((resetsAt.getTime() - nowMs) / 1000)) : null;

  return {
    used_percent: used,
    remaining_percent: used === null ? null : Math.max(0, 100 - used),
    window_minutes: windowMinutes,
    resets_at: resetsAt ? resetsAt.toISOString() : null,
    seconds_until_reset: secondsUntilReset,
    reset_in: resetDescription(secondsUntilReset),
  };
}

function laneForWindow(window, fallback) {
  if (!window) return fallback;
  if (window.window_minutes === 300) return "session";
  if (window.window_minutes === 10080) return "weekly";
  return fallback;
}

export function normalizeRateLimitsPayload(payload, accountPayload = null, options = {}) {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const rateLimits = payload?.rateLimits ?? payload?.rate_limits ?? payload ?? {};
  const primary = normalizeWindow(rateLimits.primary, nowMs);
  const secondary = normalizeWindow(rateLimits.secondary, nowMs);
  const windows = {};

  if (primary) windows[laneForWindow(primary, "primary")] = primary;
  if (secondary) windows[laneForWindow(secondary, "secondary")] = secondary;

  const account = accountPayload?.account ?? null;
  const chatgptAccount = account?.type?.toLowerCase?.() === "chatgpt" ? account : null;
  const includeAccount = options.includeAccount === true;

  return {
    tool: "autocondition",
    version: options.version ?? "0.0.0",
    source: "codex-cli-rpc",
    updated_at: now.toISOString(),
    account: {
      type: account?.type ?? null,
      plan: chatgptAccount?.planType ?? rateLimits.planType ?? null,
      email: includeAccount ? chatgptAccount?.email ?? null : null,
    },
    windows,
    credits: normalizeCredits(rateLimits.credits),
  };
}

export function normalizeCredits(raw) {
  if (!raw) return null;
  return {
    has_credits: Boolean(raw.hasCredits ?? raw.has_credits),
    unlimited: Boolean(raw.unlimited),
    balance: toNumber(raw.balance),
  };
}

export function evaluateGate(snapshot, options) {
  const lane = options.lane ?? "weekly";
  const window = snapshot.windows?.[lane];
  if (!window) {
    return {
      pass: false,
      reason: `missing ${lane} window`,
      lane,
    };
  }

  const checks = [];
  if (options.remainingAtLeast !== undefined) {
    const threshold = Number(options.remainingAtLeast);
    checks.push({
      name: "remaining_at_least",
      pass: window.remaining_percent !== null && window.remaining_percent >= threshold,
      actual: window.remaining_percent,
      expected: threshold,
    });
  }
  if (options.usedAtMost !== undefined) {
    const threshold = Number(options.usedAtMost);
    checks.push({
      name: "used_at_most",
      pass: window.used_percent !== null && window.used_percent <= threshold,
      actual: window.used_percent,
      expected: threshold,
    });
  }
  if (options.resetsWithinSeconds !== undefined) {
    const threshold = Number(options.resetsWithinSeconds);
    checks.push({
      name: "resets_within",
      pass: window.seconds_until_reset !== null && window.seconds_until_reset <= threshold,
      actual: window.seconds_until_reset,
      expected: threshold,
    });
  }

  if (checks.length === 0) {
    throw new Error("gate requires at least one condition");
  }

  const pass = checks.every((check) => check.pass);
  return {
    pass,
    reason: pass ? "all conditions passed" : "one or more conditions failed",
    lane,
    checks,
    snapshot,
  };
}
