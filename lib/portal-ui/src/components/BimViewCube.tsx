import {
  ViewCubeWidget,
  type ViewCubeWidgetProps,
  type ViewCubeRegionId,
} from "./ViewCubeWidget";

export type { ViewCubeRegionId } from "./viewCubeModel";

/** @deprecated Prefer {@link ViewCubeWidgetProps}. */
export interface BimViewCubeProps
  extends Omit<ViewCubeWidgetProps, "onSelectRegion"> {
  /** Legacy face-only callback — maps to {@link ViewCubeWidgetProps.onSelectRegion}. */
  onSelectFace?: (face: ViewCubeRegionId) => void;
  onSelectRegion?: (region: ViewCubeRegionId) => void;
}

/**
 * @deprecated Use {@link ViewCubeWidget} — adapter for legacy `onSelectFace` callers.
 */
export function BimViewCube({
  onSelectFace,
  onSelectRegion,
  ...rest
}: BimViewCubeProps) {
  return (
    <ViewCubeWidget
      {...rest}
      onSelectRegion={(region) => {
        onSelectRegion?.(region);
        onSelectFace?.(region);
      }}
    />
  );
}

export { ViewCubeWidget, type ViewCubeWidgetProps } from "./ViewCubeWidget";
