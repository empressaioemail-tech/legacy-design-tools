/**
 * CRLF-safe OpenAPI patch for Canva endpoints (AGENTS.md).
 */
import fs from "node:fs";
import path from "node:path";

const specPath = path.resolve("lib/api-spec/openapi.yaml");
let raw = fs.readFileSync(specPath, "utf8");
const usesCrlf = raw.includes("\r\n");
const content = raw.replace(/\r\n/g, "\n");

const tagBlock = `  - name: canva
    description: |
      Canva Connect — OAuth, engagement asset export, brand templates,
      and async design push jobs for Client materials (Deliver tab).
`;


raw = fs.readFileSync(specPath, "utf8");
const normalized = raw.replace(/\r\n/g, "\n");

const pathsBlock = `
  /canva/connection:
    get:
      operationId: getCanvaConnection
      tags: [canva]
      summary: Canva connection status
      responses:
        "200":
          description: Connection status
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/CanvaConnectionStatus"
    delete:
      operationId: disconnectCanva
      tags: [canva]
      summary: Disconnect Canva
      responses:
        "204":
          description: Disconnected

  /canva/oauth/start:
    post:
      operationId: startCanvaOAuth
      tags: [canva]
      summary: Start Canva OAuth (PKCE)
      responses:
        "200":
          description: Redirect URL
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/CanvaOAuthStartResponse"
        "503":
          description: OAuth not configured
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"

  /canva/oauth/callback:
    get:
      operationId: canvaOAuthCallback
      tags: [canva]
      summary: Canva OAuth callback (browser redirect)
      parameters:
        - name: code
          in: query
          schema:
            type: string
        - name: state
          in: query
          schema:
            type: string
        - name: error
          in: query
          schema:
            type: string
      responses:
        "302":
          description: Redirect to app after connect

  /canva/brand-templates:
    get:
      operationId: listCanvaBrandTemplates
      tags: [canva]
      summary: Brand templates for autofill
      responses:
        "200":
          description: Templates
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/CanvaBrandTemplate"

  /canva/push-jobs/{jobId}:
    get:
      operationId: getCanvaPushJob
      tags: [canva]
      summary: Poll Canva push job
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
                $ref: "#/components/schemas/CanvaPushJob"
        "404":
          description: Not found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"

  /engagements/{engagementId}/canva/assets:
    get:
      operationId: listEngagementCanvaAssets
      tags: [canva]
      summary: Selectable engagement assets for Canva
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
                  $ref: "#/components/schemas/CanvaSelectableAsset"
        "404":
          description: Not found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"

  /engagements/{engagementId}/canva/designs:
    get:
      operationId: listEngagementCanvaDesigns
      tags: [canva]
      summary: Past Canva pushes for an engagement
      parameters:
        - name: engagementId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Design history
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/CanvaDesignPush"
        "404":
          description: Not found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"

  /engagements/{engagementId}/canva/push:
    post:
      operationId: startEngagementCanvaPush
      tags: [canva]
      summary: Start async Canva push job
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
              $ref: "#/components/schemas/CanvaPushRequest"
      responses:
        "202":
          description: Job accepted
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/CanvaPushJobIdResponse"
        "400":
          description: Invalid body
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "401":
          description: Canva not connected
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
    CanvaOAuthStartResponse:
      type: object
      required: [url]
      properties:
        url:
          type: string
          format: uri

    CanvaConnectionStatusDisconnected:
      type: object
      required: [state]
      properties:
        state:
          type: string
          enum: [disconnected]

    CanvaConnectionStatusConnected:
      type: object
      required: [state, displayName, connectedAt]
      properties:
        state:
          type: string
          enum: [connected]
        displayName:
          type: string
        avatarUrl:
          type: string
          format: uri
        connectedAt:
          type: string

    CanvaConnectionStatusExpired:
      type: object
      required: [state]
      properties:
        state:
          type: string
          enum: [expired]
        displayName:
          type: string

    CanvaConnectionStatusEnterpriseRequired:
      type: object
      required: [state, message]
      properties:
        state:
          type: string
          enum: [enterprise_required]
        message:
          type: string

    CanvaConnectionStatus:
      oneOf:
        - $ref: "#/components/schemas/CanvaConnectionStatusDisconnected"
        - $ref: "#/components/schemas/CanvaConnectionStatusConnected"
        - $ref: "#/components/schemas/CanvaConnectionStatusExpired"
        - $ref: "#/components/schemas/CanvaConnectionStatusEnterpriseRequired"

    CanvaAssetKind:
      type: string
      enum: [render, floorplan, sheet, site-context, metadata]

    CanvaSelectableAsset:
      type: object
      required: [id, kind, label, fileType, exportable]
      properties:
        id:
          type: string
        kind:
          $ref: "#/components/schemas/CanvaAssetKind"
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

    CanvaTemplateSlotText:
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

    CanvaTemplateSlotImage:
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

    CanvaTemplateSlot:
      oneOf:
        - $ref: "#/components/schemas/CanvaTemplateSlotText"
        - $ref: "#/components/schemas/CanvaTemplateSlotImage"

    CanvaBrandTemplate:
      type: object
      required: [id, name, thumbnailUrl, tags, pageCount, slots]
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
        pageCount:
          type: integer
        slots:
          type: array
          items:
            $ref: "#/components/schemas/CanvaTemplateSlot"

    CanvaPushJobStep:
      type: string
      enum: [preparing, uploading, creating, ready, failed]

    CanvaPushJobError:
      type: object
      required: [code, message]
      properties:
        code:
          type: string
          enum: [upload, template, auth]
        message:
          type: string

    CanvaPushJob:
      type: object
      required: [jobId, step, progressLabel]
      properties:
        jobId:
          type: string
          format: uuid
        step:
          $ref: "#/components/schemas/CanvaPushJobStep"
        progressLabel:
          type: string
        designUrl:
          type: string
          format: uri
        designThumbnailUrl:
          type: string
        error:
          $ref: "#/components/schemas/CanvaPushJobError"

    CanvaPushJobIdResponse:
      type: object
      required: [jobId]
      properties:
        jobId:
          type: string
          format: uuid

    CanvaDesignPushStatus:
      type: string
      enum: [uploading, ready, failed, edited_in_canva]

    CanvaDesignPush:
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
          $ref: "#/components/schemas/CanvaDesignPushStatus"
        thumbnailUrl:
          type: string
        designUrl:
          type: string
          format: uri
        sourceAssetIds:
          type: array
          items:
            type: string

    CanvaPushRequest:
      type: object
      required: [engagementId, templateId, assetIds, slotMapping, textFields]
      properties:
        engagementId:
          type: string
          format: uuid
        templateId:
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
        uploadAssetsOnly:
          type: boolean
`;

let out = normalized;

if (!out.includes("/canva/connection:")) {
  const pathAnchor = "\n  /engagements/{id}/briefing:";
  if (!out.includes(pathAnchor)) {
    throw new Error("paths anchor not found");
  }
  out = out.replace(pathAnchor, pathsBlock + pathAnchor);
}

if (!out.includes("CanvaConnectionStatus:")) {
  const schemaAnchor = "\n    EngagementPackageRecord:";
  if (!out.includes(schemaAnchor)) {
    throw new Error("schemas anchor not found");
  }
  out = out.replace(schemaAnchor, schemasBlock + schemaAnchor);
}

if (!out.includes("name: canva")) {
  const tagAnchor = "paths:";
  const idx = out.indexOf(tagAnchor);
  if (idx < 0) throw new Error("paths: anchor not found");
  out = out.slice(0, idx) + tagBlock + out.slice(idx);
}

const final = usesCrlf ? out.replace(/\n/g, "\r\n") : out;
fs.writeFileSync(specPath, final);
console.log("openapi canva patch applied");
