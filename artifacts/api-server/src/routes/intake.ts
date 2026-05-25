/**
 * QA-27 — intake material parsing (draft-only, source-attributed).
 *
 *   POST /api/intake/parse
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { requireServiceTokenOrSession } from "../middlewares/serviceAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const INTAKE_MODES = ["link", "file", "paste", "email"] as const;
type IntakeMode = (typeof INTAKE_MODES)[number];

export interface IntakeParseResult {
  projectName: string;
  address: string;
  jurisdiction: string;
  projectType: string;
  clientName: string;
  clientEmail: string;
  clientNotes: string;
  unverifiedFields: string[];
  sources: Array<{ kind: string; label: string }>;
  aiOriginated: true;
  draftOnly: true;
}

router.use(requireServiceTokenOrSession);

router.post("/intake/parse", async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const mode = body.mode;
  const rawContent =
    typeof body.rawContent === "string" ? body.rawContent.trim() : "";
  const sourceUrl =
    typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";

  if (!INTAKE_MODES.includes(mode as IntakeMode)) {
    res.status(400).json({ error: "invalid_mode" });
    return;
  }
  if (!rawContent && !sourceUrl) {
    res.status(400).json({ error: "empty_intake_material" });
    return;
  }

  const material =
    rawContent ||
    sourceUrl ||
    "(no content)";

  try {
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      temperature: 0,
      system: [
        "You extract draft project intake fields from architect client material.",
        "Return ONLY valid JSON matching the schema.",
        "Every extracted fact must be marked unverified until the operator confirms.",
        "Include a sources array describing where each fact came from.",
        "Never present guesses as confirmed facts.",
      ].join(" "),
      messages: [
        {
          role: "user",
          content: [
            `Intake mode: ${mode}`,
            sourceUrl ? `Source URL: ${sourceUrl}` : "",
            "Material:",
            material.slice(0, 12_000),
            "",
            "JSON schema:",
            JSON.stringify({
              projectName: "string",
              address: "string",
              jurisdiction: "string",
              projectType:
                "new_build|renovation|addition|tenant_improvement|other|empty string",
              clientName: "string",
              clientEmail: "string",
              clientNotes: "string",
              unverifiedFields: ["field names you could not confirm"],
              sources: [{ kind: "string", label: "string" }],
            }),
          ].join("\n"),
        },
      ],
    });

    const textBlock = resp.content.find((b) => b.type === "text");
    const text =
      textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) {
      res.status(502).json({ error: "intake_parse_invalid_response" });
      return;
    }
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Record<
      string,
      unknown
    >;

    const result: IntakeParseResult = {
      projectName:
        typeof parsed.projectName === "string" ? parsed.projectName : "",
      address: typeof parsed.address === "string" ? parsed.address : "",
      jurisdiction:
        typeof parsed.jurisdiction === "string" ? parsed.jurisdiction : "",
      projectType:
        typeof parsed.projectType === "string" ? parsed.projectType : "",
      clientName:
        typeof parsed.clientName === "string" ? parsed.clientName : "",
      clientEmail:
        typeof parsed.clientEmail === "string" ? parsed.clientEmail : "",
      clientNotes:
        typeof parsed.clientNotes === "string" ? parsed.clientNotes : "",
      unverifiedFields: Array.isArray(parsed.unverifiedFields)
        ? parsed.unverifiedFields.filter((f): f is string => typeof f === "string")
        : ["address", "jurisdiction", "projectType"],
      sources: Array.isArray(parsed.sources)
        ? parsed.sources
            .filter(
              (s): s is { kind: string; label: string } =>
                !!s &&
                typeof s === "object" &&
                typeof (s as { kind?: unknown }).kind === "string" &&
                typeof (s as { label?: unknown }).label === "string",
            )
            .map((s) => ({ kind: s.kind, label: s.label }))
        : [
            {
              kind: String(mode).toUpperCase(),
              label: sourceUrl || "pasted material",
            },
          ],
      aiOriginated: true,
      draftOnly: true,
    };

    res.json(result);
  } catch (err) {
    logger.error({ err, mode }, "intake parse failed");
    res.status(500).json({ error: "intake_parse_failed" });
  }
});

export default router;
