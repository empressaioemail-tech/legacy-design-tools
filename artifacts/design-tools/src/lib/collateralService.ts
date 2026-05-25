/**
 * Placid collateral export — live `/api/collateral/*` unless VITE_COLLATERAL_API=0.
 */
import {
  createApiCollateralIntegrationService,
  createMockCollateralIntegrationService,
} from "@workspace/portal-ui";

/** Live Placid API only when explicitly enabled (requires api-spec codegen). */
const useApi = import.meta.env.VITE_COLLATERAL_API === "1";

export const collateralIntegrationService = useApi
  ? createApiCollateralIntegrationService()
  : createMockCollateralIntegrationService();

/** Hide Canva Enterprise autofill primary path (upload-only backlog). */
export const canvaAutofillEnabled =
  import.meta.env.VITE_CANVA_AUTOFILL !== "0";
