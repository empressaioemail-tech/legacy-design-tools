/**
 * CRLF-safe OpenAPI patch for Placid collateral endpoints (AGENTS.md).
 */
import fs from "node:fs";
import path from "node:path";

const specPath = path.resolve("lib/api-spec/openapi.yaml");
let raw = fs.readFileSync(specPath, "utf8");
const usesCrlf = raw.includes("\r\n");
const normalized = raw.replace(/\r\n/g, "\n");

const tagBlock = `  - name: collateral
    description: |
      Placid headless PDF export — engagement assets, signed public fetch,
      async collateral export jobs for Client materials (Deliver tab).
`;

const pathsBlock = `
  /collateral/templates:
    get:
      operationId: listCollateralTemplates
      tags: [collateral]
      summary: Collateral template packs
      responses:
        "200":
          description: Template packs
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/CollateralTemplatePack"

  /collateral/fetch/{token}/{assetKey}:
    get:
      operationId: fetchCollateralSignedAsset
      tags: [collateral]
      summary: Signed public asset bytes for Placid (no session)
      parameters:
        - name: token
          in: path
          required: true
          schema:
            type: string
        - name: assetKey
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Asset bytes
          content:
            image/png:
              schema:
                type: string
                format: binary
        "403":
          description: Invalid or expired token
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "404":
          description: Asset not found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"

  /collateral/export-jobs/{jobId}:
    get:
      operationId: getCollateralExportJob
      tags: [collateral]
      summary: Poll collateral export job
      parameters:
        - name: jobId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Job status
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/CollateralExportJob"
        "404":
          description: Not found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"

  /engagements/{engagementId}/collateral/assets:
    get:
      operationId: listEngagementCollateralAssets
      tags: [collateral]
      summary: Selectable engagement assets for PDF export
      parameters:
        - name: engagementId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Assets
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/CollateralSelectableAsset"
        "404":
          description: Not found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"

  /engagements/{engagementId}/collateral/exports:
    get:
      operationId: listEngagementCollateralExports
      tags: [collateral]
      summary: Past PDF exports for an engagement
      parameters:
        - name: engagementId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Export history
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/CollateralExportRecord"
        "404":
          description: Not found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"

  /engagements/{engagementId}/collateral/export:
    post:
      operationId: startEngagementCollateralExport
      tags: [collateral]
      summary: Start async Placid PDF export job
      parameters:
        - name: engagementId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CollateralExportRequest"
      responses:
        "202":
          description: Job accepted
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/CollateralExportJobIdResponse"
        "400":
          description: Invalid body
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "503":
          description: Signing or Placid not configured
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "404":
          description: Engagement not found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
`;

const schemasBlock = `
    CollateralTemplateSlotText:
      type: object
      required: [key, type, label]
      properties:
        key:
          type: string
        type:
          type: string
          enum: [text]
        label:
          type: string
        defaultValue:
          type: string

    CollateralTemplateSlotImage:
      type: object
      required: [key, type, label, accepts]
      properties:
        key:
          type: string
        type:
          type: string
          enum: [image]
        label:
          type: string
        accepts:
          type: array
          items:
            type: string
            enum: [render, floorplan, sheet, site-context]

    CollateralTemplatePack:
      type: object
      required: [id, name, thumbnailUrl, tags, pageCountEstimate, slots, creditsPerPage]
      properties:
        id:
          type: string
        name:
          type: string
        thumbnailUrl:
          type: string
        tags:
          type: array
          items:
            type: string
        pageCountEstimate:
          type: integer
        creditsPerPage:
          type: integer
        slots:
          type: array
          items:
            oneOf:
              - $ref: "#/components/schemas/CollateralTemplateSlotText"
              - $ref: "#/components/schemas/CollateralTemplateSlotImage"

    CollateralSelectableAsset:
      type: object
      required: [id, kind, label, fileType, exportable]
      properties:
        id:
          type: string
        kind:
          type: string
          enum: [render, floorplan, sheet, site-context, metadata]
        label:
          type: string
        fileType:
          type: string
        thumbnailUrl:
          type: string
        exportable:
          type: boolean
        disabledReason:
          type: string
        sourceTab:
          type: string

    CollateralExportJobStep:
      type: string
      enum: [preparing, resolving_assets, rendering, ready, failed]

    CollateralExportJobError:
      type: object
      required: [code, message]
      properties:
        code:
          type: string
          enum: [assets, placid, config]
        message:
          type: string

    CollateralExportJob:
      type: object
      required: [jobId, step, progressLabel]
      properties:
        jobId:
          type: string
          format: uuid
        step:
          $ref: "#/components/schemas/CollateralExportJobStep"
        progressLabel:
          type: string
        downloadUrl:
          type: string
          format: uri
        thumbnailUrl:
          type: string
        creditsEstimated:
          type: integer
        creditsActual:
          type: integer
        error:
          $ref: "#/components/schemas/CollateralExportJobError"

    CollateralExportJobIdResponse:
      type: object
      required: [jobId]
      properties:
        jobId:
          type: string
          format: uuid
        creditsEstimated:
          type: integer
        placidConfigured:
          type: boolean

    CollateralExportRecordStatus:
      type: string
      enum: [rendering, ready, failed]

    CollateralExportRecord:
      type: object
      required: [id, createdAt, templateName, status, sourceAssetIds]
      properties:
        id:
          type: string
          format: uuid
        createdAt:
          type: string
        templateName:
          type: string
        status:
          $ref: "#/components/schemas/CollateralExportRecordStatus"
        thumbnailUrl:
          type: string
        downloadUrl:
          type: string
          format: uri
        sourceAssetIds:
          type: array
          items:
            type: string
        creditsCharged:
          type: integer

    CollateralExportRequest:
      type: object
      required: [engagementId, templatePackId, assetIds, slotMapping, textFields]
      properties:
        engagementId:
          type: string
          format: uuid
        templatePackId:
          type: string
        assetIds:
          type: array
          items:
            type: string
        slotMapping:
          type: object
          additionalProperties:
            type: string
        textFields:
          type: object
          additionalProperties:
            type: string
        sheetAssetIds:
          type: array
          items:
            type: string
`;

let out = normalized;

if (!out.includes("/collateral/templates:")) {
  const pathAnchor = "\n  /canva/connection:";
  if (!out.includes(pathAnchor)) {
    throw new Error("paths anchor not found (expected /canva/connection:)");
  }
  out = out.replace(pathAnchor, pathsBlock + pathAnchor);
}

if (!out.includes("CollateralTemplatePack:")) {
  const schemaAnchor = "\n    CanvaOAuthStartResponse:";
  if (!out.includes(schemaAnchor)) {
    throw new Error("schemas anchor not found");
  }
  out = out.replace(schemaAnchor, schemasBlock + schemaAnchor);
}

if (!out.includes("name: collateral")) {
  const tagAnchor = "paths:";
  const idx = out.indexOf(tagAnchor);
  if (idx < 0) throw new Error("paths: anchor not found");
  out = out.slice(0, idx) + tagBlock + out.slice(idx);
}

const final = usesCrlf ? out.replace(/\n/g, "\r\n") : out;
fs.writeFileSync(specPath, final);
console.log("openapi collateral patch applied");
