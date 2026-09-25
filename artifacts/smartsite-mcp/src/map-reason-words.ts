/** P-446. Machine reason → plain sentence for the MCP map card. No imports. */

export function mapGroundReasonWords(reason: string): string {
  switch (reason) {
    case "ground_tile_cap":
      return "Aerial view is shown zoomed out because this parcel covers too much ground at closer zoom.";
    case "ground_anchor_unread":
      return "Aerial view is not shown yet because the map anchor was not included in this result.";
    case "ground_anchor_missing":
      return "Aerial view is not shown because no map anchor was read for this parcel.";
    case "ground_anchor_absent":
      return "Aerial view is not shown because county records carry no anchor point for this parcel.";
    case "ground_anchor_error":
      return "Aerial view is still loading or could not be read; the parcel outline is shown.";
    case "ground_anchor_skipped":
      return "Aerial view is not shown for this stub read; call again at node depth for imagery.";
    case "ground_no_ring":
      return "No parcel outline was returned to draw on the map.";
    case "ground_off_world":
    case "ground_anchor_off_world":
      return "Aerial view is not shown because the anchor lies outside the map.";
    case "multi_ground_extent":
      return "Set spans more than 5280 ft; rings drawn without imagery.";
    case "map_no_parcel_hits":
      return "No parcel matched this lookup, so there is no map to draw.";
    case "map_located_unbound":
      return "An address was found but no parcel is bound to it yet, so there is no parcel map.";
    case "map_wiring_failed":
      return "The parcel list could not be loaded for the map panel.";
    default:
      if (reason.startsWith("ground_anchor_")) {
        return "Aerial view is not shown (" + reason.replace(/^ground_anchor_/, "") + ").";
      }
      return reason.replace(/_/g, " ");
  }
}
