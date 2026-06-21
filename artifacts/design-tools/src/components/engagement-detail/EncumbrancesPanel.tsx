import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReadContract } from "@workspace/api-client-react";
import { ReadContractChrome } from "@workspace/portal-ui";
import { FileText, Upload, CheckCircle2, ExternalLink } from "lucide-react";

interface EncumbrancesResponse {
  instruments: Array<{
    id: string;
    instrument: {
      instrumentType: string;
      sourceAdapter: string;
      verificationStatus: string;
    };
    pdfUrl: string;
    uploadOriginalFilename: string | null;
  }>;
  clauses: Array<{
    id: string;
    instrumentId: string;
    clause: {
      clausePath: string;
      bodyText: string;
      confidence: number;
      readContract?: ReadContract | null;
      legalWeight: "recorded" | "advisory";
      reasoningSummary?: string;
      sourceCitation: string;
      humanVerifiedAt?: string;
    };
  }>;
}

export interface PrivateRestrictionsBriefingProp {
  summary: string;
  confidence: number;
  readContract?: ReadContract | null;
  evaluatedAt: string;
  items: unknown[];
}

async function fetchEncumbrances(engagementId: string): Promise<EncumbrancesResponse> {
  const res = await fetch(`/api/engagements/${engagementId}/encumbrances`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("encumbrances_fetch_failed");
  return res.json() as Promise<EncumbrancesResponse>;
}

function encumbrancesQueryKey(engagementId: string) {
  return ["engagement-encumbrances", engagementId] as const;
}

export function EncumbrancesPanel({
  engagementId,
  privateRestrictions,
}: {
  engagementId: string;
  privateRestrictions?: PrivateRestrictionsBriefingProp | null;
}) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: encumbrancesQueryKey(engagementId),
    queryFn: () => fetchEncumbrances(engagementId),
  });

  const onUpload = useCallback(
    async (file: File) => {
      setUploading(true);
      setUploadError(null);
      try {
        const form = new FormData();
        form.append("file", file, file.name);
        const res = await fetch(
          `/api/engagements/${engagementId}/encumbrances/upload`,
          { method: "POST", body: form, credentials: "include" },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "upload_failed");
        }
        await queryClient.invalidateQueries({
          queryKey: encumbrancesQueryKey(engagementId),
        });
        await queryClient.invalidateQueries({
          queryKey: [`/api/engagements/${engagementId}/briefing`],
        });
      } catch (e) {
        setUploadError(e instanceof Error ? e.message : "upload_failed");
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [engagementId, queryClient],
  );

  const onVerify = useCallback(
    async (clauseId: string) => {
      const res = await fetch(
        `/api/engagements/${engagementId}/encumbrances/clauses/${clauseId}/verify`,
        { method: "PATCH", credentials: "include" },
      );
      if (!res.ok) return;
      await queryClient.invalidateQueries({
        queryKey: encumbrancesQueryKey(engagementId),
      });
      await queryClient.invalidateQueries({
        queryKey: [`/api/engagements/${engagementId}/briefing`],
      });
    },
    [engagementId, queryClient],
  );

  const instruments = data?.instruments ?? [];
  const clauses = data?.clauses ?? [];
  const empty = !isLoading && instruments.length === 0;

  return (
    <section
      className="encumbrances-panel sc-card p-4"
      data-testid="encumbrances-panel"
      aria-label="Recorded encumbrances"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="site-details-subheading mb-1">Encumbrances</h3>
          <p className="sc-meta text-xs">
            Private recorded restrictions (deed, CC&amp;R, plat). Not municipal code.
          </p>
        </div>
        <button
          type="button"
          className="sc-btn-ghost sc-btn-sm"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          data-testid="encumbrances-upload-cta"
        >
          <Upload size={14} aria-hidden />
          {uploading ? "Uploading…" : "Upload PDF"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          data-testid="encumbrances-file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onUpload(f);
          }}
        />
      </div>

      {uploadError ? (
        <p className="text-xs text-red-600 mb-2" role="alert">
          Upload failed: {uploadError}
        </p>
      ) : null}
      {error ? <p className="sc-meta text-xs">Could not load encumbrances.</p> : null}

      {empty ? (
        <div
          className="encumbrances-empty rounded-md border border-dashed p-4 text-center"
          data-testid="encumbrances-empty"
        >
          <FileText size={28} className="mx-auto mb-2 opacity-40" aria-hidden />
          <p className="sc-meta text-sm mb-2">
            Upload a title commitment, CC&amp;R, or deed restriction PDF to extract
            clause candidates for this parcel.
          </p>
          <button
            type="button"
            className="sc-btn-primary sc-btn-sm"
            onClick={() => fileRef.current?.click()}
          >
            Upload recorded instrument
          </button>
        </div>
      ) : null}

      {instruments.length > 0 ? (
        <div className="mb-4" data-testid="encumbrances-instruments">
          <h4 className="text-xs font-medium sc-meta uppercase tracking-wide mb-2">
            Instruments
          </h4>
          <ul className="space-y-2">
            {instruments.map((inst) => (
              <li
                key={inst.id}
                className="flex items-center justify-between gap-2 text-sm border rounded-md px-3 py-2"
              >
                <span>
                  <span className="font-medium">
                    {inst.uploadOriginalFilename ?? inst.instrument.instrumentType}
                  </span>
                  <span className="sc-meta text-xs block">
                    {inst.instrument.instrumentType} · {inst.instrument.sourceAdapter}
                  </span>
                </span>
                <a
                  href={inst.pdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sc-btn-ghost sc-btn-sm shrink-0"
                >
                  <ExternalLink size={14} aria-hidden /> PDF
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {clauses.length > 0 ? (
        <div data-testid="encumbrances-clauses">
          <h4 className="text-xs font-medium sc-meta uppercase tracking-wide mb-2">
            Clauses
          </h4>
          <ul className="space-y-3">
            {clauses.map((c) => (
              <li key={c.id} className="border rounded-md p-3 text-sm">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <span className="font-medium">{c.clause.clausePath}</span>
                  <span className="sc-meta text-xs flex flex-col items-end gap-1">
                    <span>
                      {c.clause.legalWeight === "recorded" ? "Recorded" : "Advisory"}
                    </span>
                    {c.clause.readContract ? (
                      <ReadContractChrome
                        readContract={c.clause.readContract}
                        testIdPrefix={`encumbrance-clause-${c.id}`}
                        showConsequence={false}
                      />
                    ) : null}
                  </span>
                </div>
                <p className="sc-meta text-xs mb-2">{c.clause.sourceCitation}</p>
                <p className="text-sm leading-relaxed mb-2">{c.clause.bodyText}</p>
                {c.clause.humanVerifiedAt ? (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                    <CheckCircle2 size={12} aria-hidden />
                    Human verified
                  </span>
                ) : (
                  <button
                    type="button"
                    className="sc-btn-ghost sc-btn-sm"
                    onClick={() => void onVerify(c.id)}
                    data-testid={`encumbrance-verify-${c.id}`}
                  >
                    Mark verified
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {privateRestrictions ? (
        <div className="mt-4 pt-4 border-t" data-testid="private-restrictions-briefing">
          <h4 className="text-xs font-medium sc-meta uppercase tracking-wide mb-2">
            Private restrictions (briefing)
          </h4>
          {privateRestrictions.readContract ? (
            <div className="mb-2">
              <ReadContractChrome
                readContract={privateRestrictions.readContract}
                testIdPrefix="private-restrictions-briefing"
                showConsequence={false}
              />
            </div>
          ) : null}
          <p className="text-sm">{privateRestrictions.summary}</p>
        </div>
      ) : null}
    </section>
  );
}
