import { CortexIcon, CortexWordmark } from "./CortexBrand";

export function CockpitNavBrand({
  logoUrl,
  firmDisplayName,
  variant,
}: {
  logoUrl?: string | null;
  firmDisplayName?: string;
  variant: "wordmark" | "icon";
}) {
  const url = logoUrl?.trim();
  if (url) {
    const h = variant === "icon" ? 22 : 24;
    return (
      <img
        src={url}
        alt={firmDisplayName?.trim() || "Firm logo"}
        className={
          variant === "icon" ? "cockpit-nav-brand-img-icon" : "cockpit-nav-brand-img"
        }
        style={{
          height: h,
          maxWidth: variant === "icon" ? h : 160,
          objectFit: "contain",
        }}
        data-testid="cockpit-nav-firm-logo"
      />
    );
  }
  return variant === "icon" ? (
    <CortexIcon size={22} />
  ) : (
    <CortexWordmark height={24} className="cockpit-nav-brand-mark" />
  );
}
