/**
 * R1 embedded-static mount host adapter.
 * Contract + lifecycle only — no report embed instances in Wave 2.
 */

import type {
  LayerAllocation,
  MapRenderer,
  MapRendererFactory,
  ReportEmbedContext,
  ReportEmbedLifecycle,
  ReportEmbedMapHost,
} from "./contract.js";
import { defaultAllocationKey, resolveLayerAllocation } from "./layerAllocation.js";

export interface EmbeddedStaticHostOptions {
  tier?: "free" | "pro" | "max";
  createRenderer: MapRendererFactory;
}

export function createEmbeddedStaticHost(
  options: EmbeddedStaticHostOptions,
): ReportEmbedLifecycle & {
  getRenderer(): MapRenderer | null;
  getAllocation(): LayerAllocation | null;
} {
  const tier = options.tier ?? "free";
  let renderer: MapRenderer | null = null;
  let allocation: LayerAllocation | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let hostRef: ReportEmbedMapHost | null = null;
  let viewState: Record<string, unknown> | null = null;

  const lifecycle: ReportEmbedLifecycle = {
    onMount(host, ctx) {
      hostRef = host;
      const allocationKey =
        ctx.allocationKey ?? defaultAllocationKey(ctx.appId, ctx.reportType);
      allocation = resolveLayerAllocation({
        appId: ctx.appId,
        reportType: ctx.reportType,
        tier,
        allocationKey,
      });

      renderer = options.createRenderer(host, { ...ctx, allocationKey }, allocation);
      renderer.mount(host.mountSlot);
      renderer.bindContext(ctx);
      renderer.setLayerVisibility(new Set(allocation.defaultOn));

      resizeObserver = new ResizeObserver(() => {
        if (!renderer || !hostRef) return;
        const { width, height } = hostRef.mountSlot.getBoundingClientRect();
        renderer.resize(width, height);
      });
      resizeObserver.observe(host.mountSlot);

      return renderer;
    },

    onSlotResize() {
      if (!renderer || !hostRef) return;
      const { width, height } = hostRef.mountSlot.getBoundingClientRect();
      renderer.resize(width, height);
    },

    onVisibilityChange(visible) {
      if (!renderer) return;
      if (!visible && renderer.getViewState) {
        viewState = renderer.getViewState();
      } else if (visible && viewState && renderer.setViewState) {
        renderer.setViewState(viewState);
      }
    },

    onUnmount() {
      resizeObserver?.disconnect();
      resizeObserver = null;
      renderer?.destroy();
      renderer = null;
      allocation = null;
      hostRef = null;
      viewState = null;
    },
  };

  return {
    ...lifecycle,
    getRenderer: () => renderer,
    getAllocation: () => allocation,
  };
}
