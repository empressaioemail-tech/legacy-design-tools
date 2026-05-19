import { Component, type ErrorInfo, type ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertOctagon } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

const ISSUE_URL = "https://github.com/empressaioemail-tech/legacy-design-tools/issues/new";

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[design-tools] unhandled render error", error, info);
  }

  private handleRefresh = (): void => {
    window.location.reload();
  };

  private handleReport = (): void => {
    const { error } = this.state;
    const title = `Render error: ${error?.message ?? "unknown"}`;
    const body = [
      "**What happened**",
      "",
      "(describe what you were doing when this surfaced)",
      "",
      "**Error**",
      "",
      "```",
      error?.stack ?? error?.message ?? "no stack captured",
      "```",
      "",
      `**Page**: ${window.location.href}`,
    ].join("\n");
    const url = new URL(ISSUE_URL);
    url.searchParams.set("title", title);
    url.searchParams.set("body", body);
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        data-testid="error-boundary-fallback"
        className="min-h-screen w-full flex items-center justify-center bg-gray-50 p-4"
      >
        <Card className="w-full max-w-lg">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 mb-4">
              <AlertOctagon className="h-7 w-7 text-red-500" />
              <h1 className="text-xl font-bold text-gray-900">
                Something went wrong
              </h1>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              The page hit an unexpected error and stopped rendering. Refreshing
              usually clears it. If you keep seeing this on the same page, send
              a report so it can be fixed.
            </p>
            <details className="mb-4 text-xs text-gray-500">
              <summary className="cursor-pointer select-none">
                Error details
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-gray-100 p-2 font-mono text-[11px]">
                {error.message}
              </pre>
            </details>
            <div className="flex gap-2">
              <Button
                onClick={this.handleRefresh}
                data-testid="error-boundary-refresh"
              >
                Refresh page
              </Button>
              <Button
                variant="outline"
                onClick={this.handleReport}
                data-testid="error-boundary-report"
              >
                Report
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}
