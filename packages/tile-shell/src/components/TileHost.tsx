import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Mount-once + portal-into-active-slot host (adapted from the trading app's
 * FocusShell portal trick).
 *
 * Each tile's React element is created ONCE, keyed by tile id, and rendered into
 * a stable hidden "park" node. Its live DOM is then moved into whichever slot
 * currently hosts it (a grid cell, a list section, or a floating pane) via a ref
 * registry. Because the React element instance never changes identity as the
 * layout reflows, reorder / resize / edit<->view / dock-out never remount a
 * heavy tile (map, chart). Removing a tile from the active set unmounts it.
 *
 * The slot components (TileWrapper body, FloatingTileLayer body) register their
 * target node under the tile id; TileHost portals the element into that node, or
 * into the park node when no slot is registered.
 */

type SlotRegistry = {
  register: (id: string, node: HTMLElement | null) => void;
  version: number;
};

/** Imperative registry shared between TileHost and the slot components. */
export function createSlotRegistry(): {
  registry: SlotRegistry;
  get: (id: string) => HTMLElement | null;
  subscribe: (fn: () => void) => () => void;
} {
  const nodes = new Map<string, HTMLElement>();
  const subs = new Set<() => void>();
  let version = 0;
  const registry: SlotRegistry = {
    register(id, node) {
      if (node) nodes.set(id, node);
      else nodes.delete(id);
      version++;
      subs.forEach((f) => f());
    },
    get version() {
      return version;
    },
  };
  return {
    registry,
    get: (id) => nodes.get(id) ?? null,
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function TileHost({
  activeIds,
  render,
  getSlot,
  subscribe,
}: {
  /** Tile ids that should be mounted (union of grid + list + floating). */
  activeIds: string[];
  /** Render a tile's element once, by id. */
  render: (id: string) => ReactNode;
  /** Resolve the current slot DOM node for a tile id (or null → park). */
  getSlot: (id: string) => HTMLElement | null;
  /** Subscribe to slot-registry changes so portals re-target on reflow. */
  subscribe: (fn: () => void) => () => void;
}) {
  const parkRef = useRef<HTMLDivElement>(null);
  const [, force] = useState(0);

  // Re-render whenever a slot registers/unregisters so portals re-target.
  useEffect(() => subscribe(() => force((n) => n + 1)), [subscribe]);

  return (
    <>
      <div ref={parkRef} data-testid="tile-park" style={{ display: "none" }} />
      {activeIds.map((id) => {
        const target = getSlot(id) ?? parkRef.current;
        if (!target) return null;
        return (
          <PortalOnce key={id} target={target}>
            {render(id)}
          </PortalOnce>
        );
      })}
    </>
  );
}

/** Portals children into `target`; the child instance is preserved across
 * target changes because the key (tile id) is stable in TileHost. */
function PortalOnce({
  target,
  children,
}: {
  target: HTMLElement;
  children: ReactNode;
}) {
  return createPortal(children, target);
}
