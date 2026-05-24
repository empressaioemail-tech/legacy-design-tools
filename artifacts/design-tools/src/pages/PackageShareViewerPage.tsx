import { useEffect, useState } from "react";
import { useParams } from "wouter";
import { AppShell } from "../components/AppShell";
import {
  fetchPackageShare,
  postShareComment,
} from "../components/engagement-detail/packages/packagesApi";
import type { PackageShareView } from "../components/engagement-detail/packages/types";

export function PackageShareViewerPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<PackageShareView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authorName, setAuthorName] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) return;
    void fetchPackageShare(token)
      .then(setData)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Share not found."),
      );
  }, [token]);

  const handleComment = async () => {
    if (!token || !authorName.trim() || !body.trim()) return;
    setSubmitting(true);
    try {
      await postShareComment(token, {
        authorName: authorName.trim(),
        body: body.trim(),
      });
      const refreshed = await fetchPackageShare(token);
      setData(refreshed);
      setBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Comment failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppShell title="Plan review">
      <div className="package-share-page" data-testid="package-share-page">
        {error ? (
          <p className="package-share-error">{error}</p>
        ) : !data ? (
          <p className="sc-meta">Loading…</p>
        ) : (
          <>
            <header className="package-share-head">
              <h1>{data.engagementName}</h1>
              <p className="sc-meta">
                {data.package.title} · Client plan review
              </p>
              {data.package.formSnapshot?.clientReviewNote ? (
                <p className="package-share-note">
                  {data.package.formSnapshot.clientReviewNote}
                </p>
              ) : null}
            </header>

            <section className="package-share-comments sc-card">
              <h2 className="sc-label">Comments</h2>
              <ul className="package-share-comment-list">
                {data.comments.map((c) => (
                  <li key={c.id}>
                    <strong>{c.authorName}</strong>
                    <span className="sc-meta">
                      {" "}
                      · {new Date(c.createdAt).toLocaleString()}
                    </span>
                    <p>{c.body}</p>
                  </li>
                ))}
              </ul>
              <div className="package-share-comment-form">
                <input
                  type="text"
                  placeholder="Your name"
                  value={authorName}
                  onChange={(e) => setAuthorName(e.target.value)}
                  data-testid="share-comment-author"
                />
                <textarea
                  rows={3}
                  placeholder="Your feedback on the plan set…"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  data-testid="share-comment-body"
                />
                <button
                  type="button"
                  className="sc-btn-primary"
                  disabled={submitting}
                  onClick={() => void handleComment()}
                  data-testid="share-comment-submit"
                >
                  {submitting ? "Sending…" : "Post comment"}
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}
