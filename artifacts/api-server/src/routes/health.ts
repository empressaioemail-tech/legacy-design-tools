import { Router, type IRouter, type RequestHandler } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const healthHandler: RequestHandler = (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
};

// /healthz is canonical; /health is a back-compat alias for callers expecting
// the unsuffixed convention (k8s/AWS-style probes vs. classic monitoring URLs).
router.get("/healthz", healthHandler);
router.get("/health", healthHandler);

export default router;
