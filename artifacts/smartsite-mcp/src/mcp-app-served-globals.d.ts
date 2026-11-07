/**
 * P-456 / A-301. Names injected into the served MCP App script as `var X=…`.
 * INLINE_SHARED functions reference these as free globals so esbuild production
 * bundles never rename them (no module binding with the same name as
 * @empressaio/atom-contract/display exports).
 */
declare const CITATION_DEGRADED: string;
declare const EDGE_WORDS: Record<string, string>;
declare const STATE_WORDS: Record<string, string>;
declare const UPGRADE_TO_OPEN: string;
declare const NOT_ON_FILE_PREFIX: string;
declare const NOT_IMPLEMENTED_PREFIX: string;
declare const NO_BAKED_SNAPSHOT_PREFIX: string;
declare const HUMAN_ATOM_PATH_PENDING: string;
