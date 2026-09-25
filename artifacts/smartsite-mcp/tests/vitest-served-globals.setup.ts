/**
 * INLINE_SHARED helpers read display vocabulary as browser globals; wire them for vitest.
 */
import {
  CITATION_DEGRADED,
  EDGE_WORDS,
  NO_BAKED_SNAPSHOT_PREFIX,
  NOT_IMPLEMENTED_PREFIX,
  NOT_ON_FILE_PREFIX,
  STATE_WORDS,
  UPGRADE_TO_OPEN,
  envelopeHuman,
} from "../src/mcp-app.js";

const g = globalThis as Record<string, unknown>;

g.CITATION_DEGRADED = CITATION_DEGRADED;
g.EDGE_WORDS = EDGE_WORDS;
g.STATE_WORDS = STATE_WORDS;
g.UPGRADE_TO_OPEN = UPGRADE_TO_OPEN;
g.NOT_ON_FILE_PREFIX = NOT_ON_FILE_PREFIX;
g.NOT_IMPLEMENTED_PREFIX = NOT_IMPLEMENTED_PREFIX;
g.NO_BAKED_SNAPSHOT_PREFIX = NO_BAKED_SNAPSHOT_PREFIX;
g.HUMAN_ATOM_PATH_PENDING = envelopeHuman("atom_path_pending");
