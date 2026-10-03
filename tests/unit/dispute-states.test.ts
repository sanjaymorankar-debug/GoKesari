/**
 * The dispute lifecycle's transition table (GS-058).
 *
 * Pure, so it is tested here rather than through the database. The point of
 * these cases is the two properties a lifecycle has to have and which are easy
 * to lose when states are added: every state can reach a terminal one, and no
 * terminal state can be left.
 */
import { describe, expect, it } from "vitest";

import {
  DISPUTE_LEVELS,
  DISPUTE_OUTCOMES,
  DISPUTE_STATUSES,
  DISPUTE_STATUS_LABELS,
  DISPUTE_TERMINAL,
  DISPUTE_TRANSITIONS,
  canMoveDispute,
  isDisputeTerminal,
  outcomeRequiresRefund,
  type DisputeStatus,
} from "@/lib/dispute-states";

describe("dispute transition table", () => {
  it("labels every status and level", () => {
    for (const s of DISPUTE_STATUSES) {
      expect(DISPUTE_STATUS_LABELS[s], s).toBeTruthy();
    }
    expect(DISPUTE_LEVELS).toEqual(["L1", "L2"]);
  });

  it("lets no terminal status move anywhere", () => {
    for (const s of DISPUTE_TERMINAL) {
      expect(DISPUTE_TRANSITIONS[s], s).toEqual([]);
      expect(isDisputeTerminal(s), s).toBe(true);
    }
  });

  it("can reach a terminal status from every live status", () => {
    // Breadth-first: a live state with no path to RESOLVED/REJECTED/WITHDRAWN
    // would be a case nobody could ever close.
    for (const start of DISPUTE_STATUSES) {
      if (isDisputeTerminal(start)) continue;
      const seen = new Set<DisputeStatus>([start]);
      const queue: DisputeStatus[] = [start];
      let reached = false;
      while (queue.length > 0 && !reached) {
        const here = queue.shift()!;
        for (const next of DISPUTE_TRANSITIONS[here]) {
          if (isDisputeTerminal(next)) {
            reached = true;
            break;
          }
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect(reached, `${start} cannot reach a terminal status`).toBe(true);
    }
  });

  it("lets every live status escalate, and lets an escalated case carry on", () => {
    for (const s of DISPUTE_STATUSES) {
      if (isDisputeTerminal(s) || s === "ESCALATED") continue;
      expect(canMoveDispute(s, "ESCALATED"), `${s} → ESCALATED`).toBe(true);
    }
    // Escalation must not be a dead end: a second-line reviewer has to be able
    // to investigate, propose and resolve from there.
    expect(canMoveDispute("ESCALATED", "INVESTIGATING")).toBe(true);
    expect(canMoveDispute("ESCALATED", "RESOLUTION_PROPOSED")).toBe(true);
    expect(canMoveDispute("ESCALATED", "RESOLVED")).toBe(true);
  });

  it("only allows a proposal to be revisited, not a skipped triage", () => {
    expect(canMoveDispute("RESOLUTION_PROPOSED", "INVESTIGATING")).toBe(true);
    // OPEN cannot jump straight to a resolution: a case is triaged first.
    expect(canMoveDispute("OPEN", "RESOLUTION_PROPOSED")).toBe(false);
    expect(canMoveDispute("OPEN", "RESOLVED")).toBe(false);
  });

  it("names which outcomes move money", () => {
    expect(DISPUTE_OUTCOMES).toContain("REFUND_FULL");
    expect(outcomeRequiresRefund("REFUND_FULL")).toBe(true);
    expect(outcomeRequiresRefund("REFUND_PARTIAL")).toBe(true);
    expect(outcomeRequiresRefund("NO_REFUND")).toBe(false);
    expect(outcomeRequiresRefund("REPLACEMENT_AGREED")).toBe(false);
  });
});
