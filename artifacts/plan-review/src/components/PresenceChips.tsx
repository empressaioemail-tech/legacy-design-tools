/**
 * PLR-9 — Presence chips rendered in the SubmissionDetailModal
 * header. One chip per distinct reviewer currently subscribed to
 * the submission's SSE channel. When the EventSource is reconnecting
 * the chip cluster greys out so the reviewer can tell the live feed
 * is paused.
 */

import type { PresenceUser } from "../lib/useSubmissionLiveEvents";

function initialsFor(user: PresenceUser): string {
  const name = (user.displayName ?? user.id).trim();
  if (!name) return "?";
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const p = parts[0]!;
    return p.slice(0, 2).toUpperCase();
  }
  return ((parts[0]![0] ?? "") + (parts[1]![0] ?? "")).toUpperCase();
}

export interface PresenceChipsProps {
  presence: PresenceUser[];
  connected: boolean;
}

export function PresenceChips({ presence, connected }: PresenceChipsProps) {
  if (presence.length === 0) {
    return (
      <div
        data-testid="presence-chips"
        data-presence-count={0}
        data-presence-connected={connected ? "true" : "false"}
        style={{ display: "none" }}
      />
    );
  }
  return (
    <div
      data-testid="presence-chips"
      data-presence-count={presence.length}
      data-presence-connected={connected ? "true" : "false"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        opacity: connected ? 1 : 0.5,
        transition: "opacity 200ms ease",
      }}
      aria-label={`${presence.length} reviewer${presence.length === 1 ? "" : "s"} viewing`}
    >
      {presence.map((u) => (
        <span
          key={u.id}
          data-testid={`presence-chip-${u.id}`}
          title={u.displayName ?? u.id}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            borderRadius: 999,
            background: "var(--bg-input, #2a2a2a)",
            border: "1px solid var(--border-default, #444)",
            color: "var(--text-primary, #eee)",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.02em",
          }}
        >
          {initialsFor(u)}
        </span>
      ))}
    </div>
  );
}
