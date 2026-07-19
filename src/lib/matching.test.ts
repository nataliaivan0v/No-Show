import { describe, it, expect } from "vitest";
import {
  findMatch,
  spotTimeOfDay,
  type MatchSpot,
  type MatchCandidate,
} from "./matching";

// These tests exercise the pure matching decision (src/lib/matching.ts), which is a
// faithful re-expression of the SQL function public.notify_seeker_for_spot(). If you
// change the SQL matching rules, update matching.ts and these tests together.

// A baseline "Yoga, Level 2, morning" spot. Individual tests override fields as needed.
const baseSpot: MatchSpot = {
  class_type: "Yoga",
  class_level: "Level 2",
  scheduled_at: "2026-07-20T09:00:00Z", // 09:00 UTC -> morning
  poster_id: "poster-1",
};

// Helper to build a waitlist entry with sensible defaults.
function entry(overrides: Partial<MatchCandidate> & Pick<MatchCandidate, "id">): MatchCandidate {
  return {
    seeker_id: `seeker-${overrides.id}`,
    class_types: ["Yoga"],
    class_level: "Level 2",
    time_preferences: ["morning"],
    created_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

describe("spotTimeOfDay", () => {
  it("buckets the UTC hour into morning / afternoon / evening at the right boundaries", () => {
    expect(spotTimeOfDay("2026-07-20T00:00:00Z")).toBe("morning");
    expect(spotTimeOfDay("2026-07-20T11:59:00Z")).toBe("morning");
    expect(spotTimeOfDay("2026-07-20T12:00:00Z")).toBe("afternoon");
    expect(spotTimeOfDay("2026-07-20T16:59:00Z")).toBe("afternoon");
    expect(spotTimeOfDay("2026-07-20T17:00:00Z")).toBe("evening");
    expect(spotTimeOfDay("2026-07-20T23:59:00Z")).toBe("evening");
  });
});

describe("findMatch", () => {
  it("returns the exact match on class_type + level + time-of-day", () => {
    const seekers = [entry({ id: "1" })];
    expect(findMatch(baseSpot, seekers)?.id).toBe("1");
  });

  it("falls back to a class-type-only match when no exact match exists", () => {
    // Wrong level and wrong time -> not exact, but class_type still matches.
    const seekers = [
      entry({ id: "1", class_level: "Beginner", time_preferences: ["evening"] }),
    ];
    expect(findMatch(baseSpot, seekers)?.id).toBe("1");
  });

  it("returns null when no seeker wants the spot's class type", () => {
    const seekers = [
      entry({ id: "1", class_types: ["Spin", "HIIT"] }),
      entry({ id: "2", class_types: ["Boxing"] }),
    ];
    expect(findMatch(baseSpot, seekers)).toBeNull();
  });

  it("breaks ties by queue position — earliest created_at wins", () => {
    const seekers = [
      entry({ id: "late", created_at: "2026-07-05T00:00:00Z" }),
      entry({ id: "early", created_at: "2026-07-02T00:00:00Z" }),
      entry({ id: "mid", created_at: "2026-07-03T00:00:00Z" }),
    ];
    expect(findMatch(baseSpot, seekers)?.id).toBe("early");
  });

  it("prefers an exact match over an earlier class-type-only match (tier precedence)", () => {
    const seekers = [
      // Earlier in the queue, but wrong level -> only a tier-2 (fallback) match.
      entry({ id: "early-fallback", class_level: "Beginner", created_at: "2026-07-02T00:00:00Z" }),
      // Later in the queue, but an exact match on level + time.
      entry({ id: "later-exact", created_at: "2026-07-04T00:00:00Z" }),
    ];
    expect(findMatch(baseSpot, seekers)?.id).toBe("later-exact");
  });

  it("never matches the poster to their own spot", () => {
    const seekers = [entry({ id: "1", seeker_id: "poster-1" })];
    expect(findMatch(baseSpot, seekers)).toBeNull();
  });

  it("skips seekers already notified for the spot (cascade advances the queue)", () => {
    const seekers = [
      entry({ id: "1", seeker_id: "seeker-A", created_at: "2026-07-02T00:00:00Z" }),
      entry({ id: "2", seeker_id: "seeker-B", created_at: "2026-07-03T00:00:00Z" }),
    ];
    // A already got (and let go of) this spot -> next in line is B.
    expect(findMatch(baseSpot, seekers, ["seeker-A"])?.id).toBe("2");
  });

  it("treats null time_preferences as 'any time' for an exact match", () => {
    // No time preference set, correct level -> still a tier-1 exact match.
    const seekers = [entry({ id: "1", time_preferences: null })];
    expect(findMatch(baseSpot, seekers)?.id).toBe("1");
  });

  it("matches a spot's class_type against the seeker's multi-select class_types array", () => {
    const seekers = [entry({ id: "1", class_types: ["Spin", "Yoga", "Barre"] })];
    expect(findMatch(baseSpot, seekers)?.id).toBe("1");
  });

  it("treats a null-level spot as an exact match only for a null-level seeker, else falls back", () => {
    const nullLevelSpot: MatchSpot = { ...baseSpot, class_level: null };

    // A wants a specific level (not exact vs a null-level spot); B has no level (exact).
    // B is later in the queue but wins on the exact tier.
    const seekers = [
      entry({ id: "A-specific", class_level: "Level 2", created_at: "2026-07-02T00:00:00Z" }),
      entry({ id: "B-null", class_level: null, created_at: "2026-07-04T00:00:00Z" }),
    ];
    expect(findMatch(nullLevelSpot, seekers)?.id).toBe("B-null");

    // With only the specific-level seeker, there is no exact match -> tier-2 fallback.
    expect(findMatch(nullLevelSpot, [seekers[0]])?.id).toBe("A-specific");
  });
});
