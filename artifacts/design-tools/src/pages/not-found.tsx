import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";

export default function NotFound() {
  return (
    <div
      role="alert"
      data-testid="not-found-page"
      className="min-h-screen w-full flex items-center justify-center bg-gray-50"
    >
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-2 items-center">
            <AlertCircle className="h-7 w-7 text-red-500" />
            <h1 className="text-2xl font-bold text-gray-900">
              404 — Page not found
            </h1>
          </div>

          <p className="mt-4 mb-4 text-sm text-gray-600">
            The page you requested doesn't exist (or no longer does). Head back
            to your projects.
          </p>

          <Link href="/">
            <Button data-testid="not-found-back-home">Back to projects</Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
