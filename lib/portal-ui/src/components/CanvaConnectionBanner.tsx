/**
 * Canva account connection states (stub — no OAuth yet).
 *
 * Expected API: GET /api/canva/connection, POST /api/canva/oauth/start
 */
import type { ReactNode } from "react";
import { AlertTriangle, ExternalLink, Link2, Unlink } from "lucide-react";
import type { CanvaConnectionStatus } from "../canva/types";

export function CanvaConnectionBanner({
  status,
  onConnect,
  onDisconnect,
  onReconnect,
  connecting = false,
}: {
  status: CanvaConnectionStatus;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onReconnect?: () => void;
  /** Disables connect/reconnect while OAuth or dev-connect is in flight. */
  connecting?: boolean;
}) {
  if (status.state === "connected") {
    return (
      <div
        className="canva-connection-banner canva-connection-banner--connected"
        data-testid="canva-connection-banner"
        data-state="connected"
      >
        <Link2 size={16} aria-hidden />
        <span className="canva-connection-banner-text">
          Connected as <strong>{status.displayName}</strong>
          {status.connectedAt ? ` · ${status.connectedAt}` : null}
        </span>
        <button
          type="button"
          className="sc-btn-ghost sc-btn-sm"
          data-testid="canva-disconnect"
          onClick={onDisconnect}
        >
          <Unlink size={14} aria-hidden /> Disconnect
        </button>
        <span className="canva-connection-powered" data-testid="canva-powered-by">
          Powered by Canva
        </span>
      </div>
    );
  }

  if (status.state === "expired") {
    return (
      <StatusBanner
        testId="canva-connection-banner"
        state="expired"
        tone="warning"
        icon={<AlertTriangle size={16} />}
        title="Canva session expired"
        body="Reconnect to continue generating client materials."
        action={
          <button
            type="button"
            className="sc-btn-primary sc-btn-sm"
            data-testid="canva-reconnect"
            disabled={connecting}
            onClick={onReconnect ?? onConnect}
          >
            {connecting ? "Connecting…" : "Reconnect Canva"}
          </button>
        }
      />
    );
  }

  if (status.state === "enterprise_required") {
    return (
      <StatusBanner
        testId="canva-connection-banner"
        state="enterprise_required"
        tone="info"
        icon={<ExternalLink size={16} />}
        title="Brand template autofill requires Canva Enterprise"
        body={status.message}
        action={
          <a
            href="https://www.canva.com/enterprise/"
            target="_blank"
            rel="noopener noreferrer"
            className="sc-btn-ghost sc-btn-sm"
            data-testid="canva-enterprise-docs"
          >
            Learn about Enterprise <ExternalLink size={12} aria-hidden />
          </a>
        }
      />
    );
  }

  return (
    <StatusBanner
      testId="canva-connection-banner"
      state="disconnected"
      tone="neutral"
      icon={<Link2 size={16} />}
      title="Connect your Canva account"
      body="Push renders, plans, and sheet exports into branded templates for client review."
      action={
        <button
          type="button"
          className="sc-btn-primary sc-btn-sm"
          data-testid="canva-connect"
          disabled={connecting || !onConnect}
          onClick={onConnect}
        >
          {connecting ? "Connecting…" : "Connect Canva account"}
        </button>
      }
    />
  );
}

function StatusBanner({
  testId,
  state,
  tone,
  icon,
  title,
  body,
  action,
}: {
  testId: string;
  state: string;
  tone: "warning" | "info" | "neutral";
  icon: ReactNode;
  title: string;
  body: string;
  action: ReactNode;
}) {
  return (
    <div
      className={`canva-connection-banner canva-connection-banner--${tone}`}
      data-testid={testId}
      data-state={state}
    >
      <div className="canva-connection-banner-icon">{icon}</div>
      <div className="canva-connection-banner-copy">
        <div className="canva-connection-banner-title">{title}</div>
        <p className="canva-connection-banner-body">{body}</p>
      </div>
      <div className="canva-connection-banner-actions" data-testid="canva-connection-banner-actions">
        {action}
      </div>
    </div>
  );
}
