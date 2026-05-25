import { useEffect, useRef, useState } from "react";
import { FileUp, Link2, Paperclip } from "lucide-react";
import { useEngagementsStore } from "../../store/engagements";
import { DraftBadge, SourceChip } from "../cockpit/QualityChips";

/**
 * QA-50 — Client materials on the engagement (upload / link / note).
 * Persists via attached-documents API; chat uses list_client_materials.
 */
export function ClientMaterialsSection({
  engagementId,
}: {
  engagementId: string;
}) {
  const attachedDocuments =
    useEngagementsStore(
      (s) => s.attachedDocumentsByEngagement[engagementId],
    ) ?? [];
  const uploading = useEngagementsStore(
    (s) => s.uploadingDocumentByEngagement[engagementId],
  );
  const uploadError = useEngagementsStore(
    (s) => s.documentUploadErrorByEngagement[engagementId],
  );
  const loadAttachedDocuments = useEngagementsStore(
    (s) => s.loadAttachedDocuments,
  );
  const uploadAttachedDocument = useEngagementsStore(
    (s) => s.uploadAttachedDocument,
  );

  const [linkUrl, setLinkUrl] = useState("");
  const [linkTitle, setLinkTitle] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadAttachedDocuments(engagementId);
  }, [engagementId, loadAttachedDocuments]);

  const handleFile = async (file: File) => {
    await uploadAttachedDocument(engagementId, file);
  };

  const handleAddLink = async () => {
    const url = linkUrl.trim();
    if (!url) return;
    const title = linkTitle.trim() || "Client link";
    const body = `Source URL (unverified):\n${url}\n`;
    const file = new File([body], `${title.slice(0, 48)}.txt`, {
      type: "text/plain",
    });
    await uploadAttachedDocument(engagementId, file);
    setLinkUrl("");
    setLinkTitle("");
  };

  return (
    <section
      className="sc-card flex flex-col gap-3"
      data-testid="client-materials-section"
    >
      <div className="sc-card-header">
        <span className="sc-label">CLIENT MATERIALS</span>
        <DraftBadge hint="Draft — operator verifies before relying on AI reads" />
      </div>
      <p className="sc-meta opacity-70">
        PDFs, photos, pasted links, and notes the in-app agent can list via{" "}
        <code>list_client_materials</code>.
      </p>

      <div className="client-materials-actions flex flex-wrap gap-2">
        <button
          type="button"
          className="sc-btn-ghost sc-btn-sm"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          data-testid="client-materials-upload"
        >
          <FileUp size={14} /> Upload file
        </button>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept=".pdf,application/pdf,image/*,.txt,.md,text/plain"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = "";
          }}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="sc-meta flex items-center gap-1">
          <Link2 size={12} /> Paste link or image URL
        </label>
        <input
          type="url"
          className="sc-input"
          placeholder="https://…"
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
          data-testid="client-materials-link-input"
        />
        <input
          type="text"
          className="sc-input"
          placeholder="Label (optional)"
          value={linkTitle}
          onChange={(e) => setLinkTitle(e.target.value)}
        />
        <button
          type="button"
          className="sc-btn-primary sc-btn-sm self-start"
          disabled={!linkUrl.trim()}
          onClick={() => void handleAddLink().catch(() => {})}
          data-testid="client-materials-link-save"
        >
          Save link
        </button>
      </div>

      {uploadError && (
        <p className="sc-meta" style={{ color: "var(--danger-text)" }}>
          {uploadError}
        </p>
      )}

      {attachedDocuments.length > 0 ? (
        <ul className="flex flex-col gap-1" data-testid="client-materials-list">
          {attachedDocuments.map((doc) => (
            <li
              key={doc.id}
              className="flex items-center gap-2 sc-meta"
              data-testid={`client-material-${doc.id}`}
            >
              <Paperclip size={12} />
              <span>{doc.title}</span>
              <SourceChip label={doc.documentType} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="sc-meta opacity-60">No client materials yet.</p>
      )}
    </section>
  );
}
