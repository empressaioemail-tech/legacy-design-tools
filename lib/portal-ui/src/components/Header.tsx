import { Bell, Search } from "lucide-react";

export interface HeaderSearch {
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
}

export interface HeaderProps {
  title?: string;
  search?: HeaderSearch;
}

export function Header({ title, search }: HeaderProps) {
  return (
    <header
      style={{
        height: 64,
        position: "sticky",
        top: 0,
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 24px",
        background: "color-mix(in srgb, var(--bg-elevated) 85%, transparent)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        borderBottom: "1px solid var(--border-default)",
      }}
    >
      <div
        style={{
          fontFamily: "Oxygen, sans-serif",
          fontSize: 18,
          fontWeight: 700,
          color: "var(--text-primary)",
        }}
      >
        {title}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {search && (
          <div
            style={{
              position: "relative",
              width: 240,
              height: 32,
            }}
          >
            <Search
              size={13}
              style={{
                position: "absolute",
                top: "50%",
                left: 12,
                transform: "translateY(-50%)",
                color: "var(--text-muted)",
                pointerEvents: "none",
              }}
            />
            <input
              type="text"
              placeholder={search.placeholder ?? "Search"}
              {...(search.value !== undefined ? { value: search.value } : {})}
              {...(search.onChange
                ? { onChange: (e) => search.onChange!(e.target.value) }
                : {})}
              style={{
                width: "100%",
                height: 32,
                padding: "0 12px 0 32px",
                background: "var(--bg-input)",
                border: "1px solid var(--border-default)",
                borderRadius: 16,
                color: "var(--text-primary)",
                fontFamily: "Inter, sans-serif",
                fontSize: 12,
                outline: "none",
                transition: "border-color 0.15s",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = "var(--border-focus)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "var(--border-default)";
              }}
            />
          </div>
        )}
        <button
          type="button"
          aria-label="Notifications"
          style={{
            width: 32,
            height: 32,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "1px solid var(--border-default)",
            borderRadius: 6,
            color: "var(--text-secondary)",
            cursor: "pointer",
            transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--depth-hover-bg)";
            e.currentTarget.style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--text-secondary)";
          }}
        >
          <Bell size={14} />
        </button>
      </div>
    </header>
  );
}
