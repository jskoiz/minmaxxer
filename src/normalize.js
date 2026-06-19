function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPercent(value) {
  const parsed = toNumber(value);
  if (parsed === null || parsed < 0 || parsed > 100) return null;
  return parsed;
}

function resetDescription(secondsUntilReset) {
  if (secondsUntilReset === null) return null;
  if (secondsUntilReset < 0) return "overdue";
  if (secondsUntilReset === 0) return "now";
  const minutes = Math.round(secondsUntilReset / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function normalizeWindow(raw, nowMs = Date.now()) {
  if (!raw) return null;
  const used = toPercent(raw.usedPercent ?? raw.used_percent);
  const windowMinutes = toNumber(raw.windowDurationMins ?? raw.window_minutes);
  const resetEpochSeconds = toNumber(raw.resetsAt ?? raw.resets_at);
  const resetsAt = resetEpochSeconds ? new Date(resetEpochSeconds * 1000) : null;
  const secondsUntilReset = resetsAt ? Math.round((resetsAt.getTime() - nowMs) / 1000) : null;

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

function windowRole(window) {
  if (!window) return "none";
  if (window.window_minutes === 300) return "session";
  if (window.window_minutes === 10080) return "weekly";
  return "unknown";
}

function normalizeSlots(primary, secondary) {
  const primaryRole = windowRole(primary);
  const secondaryRole = windowRole(secondary);

  if (primary && secondary) {
    if (
      (primaryRole === "weekly" && secondaryRole === "session") ||
      (primaryRole === "weekly" && secondaryRole === "unknown")
    ) {
      return { primary: secondary, secondary: primary };
    }
    return { primary, secondary };
  }

  if (primary && primaryRole === "weekly") return { primary: null, secondary: primary };
  if (secondary && (secondaryRole === "session" || secondaryRole === "unknown")) {
    return { primary: secondary, secondary: null };
  }
  return { primary, secondary };
}

export function normalizeRateLimitsPayload(payload, accountPayload = null, options = {}) {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const rateLimits = payload?.rateLimits ?? payload?.rate_limits ?? payload ?? {};
  const { primary, secondary } = normalizeSlots(
    normalizeWindow(rateLimits.primary, nowMs),
    normalizeWindow(rateLimits.secondary, nowMs),
  );
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
      status: "indeterminate",
      reason_code: "missing_window",
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
      pass: window.seconds_until_reset !== null &&
        window.seconds_until_reset >= 0 &&
        window.seconds_until_reset <= threshold,
      actual: window.seconds_until_reset,
      expected: threshold,
    });
  }

  if (checks.length === 0) {
    throw new Error("gate requires at least one condition");
  }

  const unavailable = checks.find((check) => check.actual === null || check.actual === undefined);
  if (unavailable) {
    return {
      pass: false,
      status: "indeterminate",
      reason_code: `missing_${unavailable.name}`,
      reason: `${lane}.${unavailable.name} is unavailable`,
      lane,
      checks,
      snapshot,
    };
  }

  const staleReset = checks.find((check) => check.name === "resets_within" && check.actual < 0);
  if (staleReset) {
    return {
      pass: false,
      status: "indeterminate",
      reason_code: "stale_reset",
      reason: `${lane}.resets_at is in the past`,
      lane,
      checks,
      snapshot,
    };
  }

  const pass = checks.every((check) => check.pass);
  const failed = checks.find((check) => !check.pass);
  return {
    pass,
    status: pass ? "pass" : "skip",
    reason_code: pass ? "all_conditions_passed" : failed.name,
    reason: pass ? "all conditions passed" : gateFailureReason(lane, failed),
    lane,
    checks,
    snapshot,
  };
}

function gateFailureReason(lane, check) {
  if (check.name === "remaining_at_least") {
    return `${lane}.remaining_percent=${check.actual} is below required ${check.expected}`;
  }
  if (check.name === "used_at_most") {
    return `${lane}.used_percent=${check.actual} is above allowed ${check.expected}`;
  }
  if (check.name === "resets_within") {
    return `${lane}.seconds_until_reset=${check.actual} is above allowed ${check.expected}`;
  }
  return "one or more conditions failed";
}
