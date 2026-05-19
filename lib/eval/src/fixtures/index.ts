/**
 * Fixture canon for the eval harness. Each fixture is a
 * `FixtureGroundTruth` exported from its own file. New fixtures land
 * here without touching the CLI; the registry below is the only
 * lookup table the runner consults.
 *
 * Per dispatch §Coordination: this canon is durable — when ADR-008
 * factors the engine out, these fixtures port to hauska-engine as-is
 * (engagement ids may rebind to test-DB ids in the new repo).
 */

import type { FixtureGroundTruth } from "../types";
import { musgraveFixture } from "./musgrave";
import { seguinFixture } from "./seguin";
import { arenaRojaR1Fixture } from "./arenaRojaR1";

export const FIXTURES: ReadonlyArray<FixtureGroundTruth> = [
  musgraveFixture,
  seguinFixture,
  arenaRojaR1Fixture,
];

export const FIXTURE_BY_KEY: ReadonlyMap<string, FixtureGroundTruth> = new Map(
  FIXTURES.map((f) => [f.key, f]),
);

export { musgraveFixture, seguinFixture, arenaRojaR1Fixture };
