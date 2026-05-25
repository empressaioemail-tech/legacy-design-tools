/**
 * Canva integration entry point for design-tools.
 * Uses live `/api/canva/*` routes unless `VITE_CANVA_API=0`.
 */
import {
  createApiCanvaIntegrationService,
  createMockCanvaIntegrationService,
} from "@workspace/portal-ui";

const useApi =
  typeof import.meta.env.VITE_CANVA_API === "undefined" ||
  import.meta.env.VITE_CANVA_API !== "0";

export const canvaIntegrationService = useApi
  ? createApiCanvaIntegrationService()
  : createMockCanvaIntegrationService();
