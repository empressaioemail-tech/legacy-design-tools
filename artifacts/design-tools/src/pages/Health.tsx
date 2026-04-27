import { useHealthCheck } from "@workspace/api-client-react";

export function Health() {
  const { data, isLoading, error } = useHealthCheck();

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl mb-6">API Health</h1>
      
      <div className="sc-card p-6">
        {isLoading && <div className="sc-body">Checking API health...</div>}
        {error && (
          <div className="alert-block critical rounded-md">
            <div className="sc-medium">Health Check Failed</div>
            <div className="sc-body mt-1">{String(error)}</div>
          </div>
        )}
        {data && (
          <div className="alert-block success rounded-md">
            <div className="sc-medium">API is Online</div>
            <div className="sc-body mt-1">Status: {data.status}</div>
          </div>
        )}
      </div>
    </div>
  );
}
