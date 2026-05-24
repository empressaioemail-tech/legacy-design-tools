import type { ReactNode } from "react";
import { SettingsSubnav } from "./SettingsSubnav";

/**
 * Two-column settings shell: section subnav + page content.
 * Used for /settings and all workspace/dev tool routes folded under Settings.
 */
export function SettingsAreaLayout({ children }: { children: ReactNode }) {
  return (
    <div className="cockpit-settings-layout" data-testid="settings-area-layout">
      <SettingsSubnav />
      <div className="cockpit-settings-content">{children}</div>
    </div>
  );
}
