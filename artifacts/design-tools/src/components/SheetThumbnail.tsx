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
      className="cockpit-sheet-thumb"
    >
      <div
        className="cockpit-sheet-thumb-image"
        style={{ aspectRatio: String(aspectRatio || 1) }}
      >
        {errored ? (
          <div className="cockpit-sheet-thumb-unavailable">
            preview unavailable
          </div>
        ) : (
          <img
            src={url}
            alt={`${sheet.sheetNumber} ${sheet.sheetName}`}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setErrored(true)}
            className="cockpit-sheet-thumb-img"
            data-loaded={loaded ? "true" : "false"}
          />
        )}
      </div>
      <div className="cockpit-sheet-thumb-footer">
        <span className="cockpit-sheet-thumb-number">{sheet.sheetNumber}</span>
        <span
          className="cockpit-sheet-thumb-name"
          title={sheet.sheetName}
        >
          {sheet.sheetName}
        </span>
      </div>
    </button>
  );
}
