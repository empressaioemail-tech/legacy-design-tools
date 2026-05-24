import { Link, useLocation } from "wouter";
import {
  SETTINGS_NAV_ITEMS,
  isSettingsSubnavActive,
} from "./settingsNav";

export function SettingsSubnav() {
  const [location] = useLocation();

  return (
    <nav
      className="cockpit-settings-subnav"
      aria-label="Settings sections"
      data-testid="settings-subnav"
    >
      <div className="cockpit-settings-subnav-title">Settings</div>
      <ul className="cockpit-settings-subnav-list">
        {SETTINGS_NAV_ITEMS.map((item) => {
          const active = isSettingsSubnavActive(item.href, location);
          const Icon = item.icon;
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                className="cockpit-settings-subnav-item"
                data-active={active ? "true" : "false"}
                data-testid={`settings-nav-${item.id}`}
              >
                <span className="cockpit-settings-subnav-icon" aria-hidden="true">
                  <Icon size={18} />
                </span>
                <span className="cockpit-settings-subnav-text">
                  <span className="cockpit-settings-subnav-label">{item.label}</span>
                  <span className="cockpit-settings-subnav-desc">{item.description}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
