import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import {
  CreateSnapshotBody,
  CreateSnapshotHeader,
  GetSnapshotParams,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";

interface StoredSnapshot {
  id: string;
  projectName: string;
  receivedAt: string;
  payload: Record<string, unknown>;
}

const snapshots = new Map<string, StoredSnapshot>();

let snapshotSecret = process.env["SNAPSHOT_SECRET"];
if (!snapshotSecret) {
  if (process.env["NODE_ENV"] === "production") {
    logger.fatal(
      "SNAPSHOT_SECRET env var is required in production. Refusing to start.",
    );
    process.exit(1);
  }
  snapshotSecret = "dev-snapshot-secret-" + randomUUID();
  logger.warn(
    "SNAPSHOT_SECRET not set; generated a temporary one for this dev process. Configure SNAPSHOT_SECRET env var before deploying.",
  );
}

const router: IRouter = Router();

router.get("/snapshots", (_req: Request, res: Response) => {
  const list = Array.from(snapshots.values())
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .map(({ id, projectName, receivedAt }) => ({
      id,
      projectName,
      receivedAt,
    }));
  res.json(list);
});

router.post("/snapshots", (req: Request, res: Response) => {
  const headerParse = CreateSnapshotHeader.safeParse({
    "x-snapshot-secret": req.header("x-snapshot-secret"),
  });
  if (
    !headerParse.success ||
    headerParse.data["x-snapshot-secret"] !== snapshotSecret
  ) {
    res.status(401).json({ error: "Invalid snapshot secret" });
    return;
  }

  const bodyParse = CreateSnapshotBody.safeParse(req.body);
  if (!bodyParse.success) {
    res.status(400).json({ error: "projectName is required" });
    return;
  }

  const id = randomUUID();
  const receivedAt = new Date().toISOString();
  const payload = (req.body ?? {}) as Record<string, unknown>;
  const stored: StoredSnapshot = {
    id,
    projectName: bodyParse.data.projectName,
    receivedAt,
    payload,
  };
  snapshots.set(id, stored);

  res.status(201).json({ id, receivedAt });
});

router.get("/snapshots/:id", (req: Request, res: Response) => {
  const params = GetSnapshotParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const snap = snapshots.get(params.data.id);
  if (!snap) {
    res.status(404).json({ error: "Snapshot not found" });
    return;
  }
  res.json(snap);
});

export function getSnapshot(id: string): StoredSnapshot | undefined {
  return snapshots.get(id);
}

export default router;
