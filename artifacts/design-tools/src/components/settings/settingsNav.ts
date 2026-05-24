import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Building2,
  Database,
  Palette,
  Search,
  Share2,
  User,
} from "lucide-react";

export interface SettingsNavItem {
  id: string;
  label: string;
  href: string;
  description: string;
  icon: LucideIcon;
}

/** Routes grouped under the Settings area (sidebar highlights Settings for all). */
export const SETTINGS_AREA_PREFIXES = [
  "/settings",
  "/workspace",
  "/style-probe",
  "/health",
  "/dev/atoms",
] as const;

export function isSettingsAreaPath(path: string): boolean {
  return SETTINGS_AREA_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  {
    id: "account",
    label: "Account",
    href: "/settings",
    description: "Profile, email, and briefing PDF branding.",
    icon: User,
  },
  {
    id: "product",
    label: "Product settings",
    href: "/workspace",
    description: "Workspace defaults, jurisdictions, and publishing.",
    icon: Building2,
  },
  {
    id: "shared",
    label: "Shared with me",
    href: "/workspace/shared",
    description: "Engagements and assets shared into your workspace.",
    icon: Share2,
  },
  {
    id: "style-probe",
    label: "Style Probe",
    href: "/style-probe",
    description: "Token and component visual reference.",
    icon: Palette,
  },
  {
    id: "atoms",
    label: "Atom Inspector",
    href: "/dev/atoms",
    description: "Browse and validate atom registry entries.",
    icon: Database,
  },
  {
    id: "retrieval",
    label: "Retrieval Probe",
    href: "/dev/atoms/probe",
    description: "Test cortex retrieval against live atoms.",
    icon: Search,
  },
  {
    id: "health",
    label: "API Health",
    href: "/health",
    description: "Service connectivity and dependency status.",
    icon: Activity,
  },
];

export function isSettingsSubnavActive(href: string, path: string): boolean {
  if (href === "/dev/atoms") {
    return path === "/dev/atoms";
  }
  if (href === "/") return path === "/";
  return path === href || path.startsWith(`${href}/`);
}
