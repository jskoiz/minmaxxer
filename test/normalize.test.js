import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDurationSeconds } from "../src/duration.js";
import { evaluateGate, normalizeRateLimitsPayload } from "../src/normalize.js";

describe("duration parsing", () => {
  it("parses compact durations", () => {
    assert.equal(parseDurationSeconds("30m"), 1800);
    assert.equal(parseDurationSeconds("5h"), 18000);
    assert.equal(parseDurationSeconds("3d"), 259200);
  });
});

describe("normalization", () => {
  const now = new Date("2026-06-19T00:00:00Z");

  it("maps Codex RPC primary and secondary windows to session and weekly lanes", () => {
    const snapshot = normalizeRateLimitsPayload({
      rateLimits: {
        primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 1781830800 },
        secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1782432000 },
        credits: { hasCredits: true, unlimited: false, balance: "12.5" },
        planType: "pro",
      },
    }, {
      account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
    }, {
      now,
      version: "0.1.0",
    });

    assert.equal(snapshot.account.email, null);
    assert.equal(snapshot.account.plan, "pro");
    assert.equal(snapshot.windows.session.used_percent, 35);
    assert.equal(snapshot.windows.weekly.remaining_percent, 40);
    assert.equal(snapshot.credits.balance, 12.5);
  });

  it("evaluates gates with AND semantics", () => {
    const snapshot = normalizeRateLimitsPayload({
      rateLimits: {
        secondary: { usedPercent: 55, windowDurationMins: 10080, resetsAt: 1782604800 },
      },
    }, null, { now });

    assert.equal(evaluateGate(snapshot, {
      lane: "weekly",
      remainingAtLeast: 40,
      resetsWithinSeconds: 10 * 24 * 60 * 60,
    }).pass, true);

    assert.equal(evaluateGate(snapshot, {
      lane: "weekly",
      remainingAtLeast: 50,
    }).pass, false);
  });
});
