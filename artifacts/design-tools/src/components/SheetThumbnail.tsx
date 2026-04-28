import { useState } from "react";
import type { SheetSummary } from "@workspace/api-client-react";

interface SheetThumbnailProps {
  sheet: SheetSummary;
  onClick: () => void;
}

export function SheetThumbnail({ sheet, onClick }: SheetThumbnailProps) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const aspectRatio =
    sheet.thumbnailWidth > 0 && sheet.thumbnailHeight > 0
      ? sheet.thumbnailWidth / sheet.thumbnailHeight
      : 1;
  const url = `${import.meta.env.BASE_URL}api/sheets/${sheet.id}/thumbnail.png`;

  return (
    <button
      type="button"
      onClick={onClick}
      className="sc-card sc-card-clickable"
      style={{
        padding: 0,
        background: "var(--bg-card)",
        border: "1px solid var(--border-default)",
        textAlign: "left",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: "100%",
          aspectRatio: String(aspectRatio || 1),
          background: "var(--bg-input)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {errored ? (
          <div
            className="sc-meta opacity-50"
            style={{ padding: 12, textAlign: "center" }}
          >
            preview unavailable
          </div>
        ) : (
          <img
            src={url}
            alt={`${sheet.sheetNumber} ${sheet.sheetName}`}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setErrored(true)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              opacity: loaded ? 1 : 0,
              transition: "opacity 0.18s ease-out",
              background: "white",
            }}
          />
        )}
      </div>
      <div
        className="sc-card-footer"
        style={{
          padding: "8px 10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          borderTop: "1px solid var(--border-default)",
        }}
      >
        <span
          className="sc-medium"
          style={{
            color: "var(--text-primary)",
            fontSize: 12,
            flexShrink: 0,
          }}
        >
          {sheet.sheetNumber}
        </span>
        <span
          className="sc-meta"
          style={{
            color: "var(--text-secondary)",
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
          title={sheet.sheetName}
        >
          {sheet.sheetName}
        </span>
      </div>
    </button>
  );
}
