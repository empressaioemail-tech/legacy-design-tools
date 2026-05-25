/**
 * Splices packages + intake OpenAPI blocks into openapi.yaml with CRLF preservation.
 * Run: node scripts/splice-openapi-packages-intake.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.resolve(__dirname, "../lib/api-spec/openapi.yaml");

const raw = fs.readFileSync(specPath, "utf8");
const nl = raw.includes("\r\n") ? "\r\n" : "\n";
const content = raw.replace(/\r\n/g, "\n");

function out(s) {
  return s.replace(/\n/g, nl);
}

const postEngagements = `
    post:
      operationId: createEngagement
      tags: [engagements]
      summary: Create engagement (intake / new project)
      description: |
        Creates a new engagement. Optional intake fields are persisted in
        \`site_context_raw.intake\` and surfaced on \`clientBrief\` in list/detail
        responses.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CreateEngagementBody"
      responses:
        "201":
          description: Created engagement summary
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/EngagementSummary"
        "400":
          description: Invalid request body
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
`;

const packagesPaths = `
  /engagements/{engagementId}/packages:
    get:
      operationId: listEngagementPackages
      tags: [packages]
      summary: List packages for an engagement
      parameters:
        - name: engagementId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Packages newest-first by updatedAt
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/EngagementPackageRecord"
        "404":
          description: Not found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
    post:
      operationId: createEngagementPackage
      tags: [packages]
      summary: Create a package draft
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
              $ref: "#/components/schemas/CreateEngagementPackageBody"
      responses:
        "201":
          description: Created package
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/EngagementPackageRecord"
        "400":
          description: Invalid body
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

  /packages/{packageId}:
    patch:
      operationId: updateEngagementPackage
      tags: [packages]
      summary: Update a package draft
      parameters:
        - name: packageId
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
              $ref: "#/components/schemas/UpdateEngagementPackageBody"
      responses:
        "200":
          description: Updated package
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/EngagementPackageRecord"
        "400":
          description: Invalid body
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "404":
          description: Package not found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"

  /packages/{packageId}/share:
    post:
      operationId: createPackageShare
      tags: [packages]
      summary: Create or reuse a share link for a package
      parameters:
        - name: packageId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "201":
          description: Share token
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/PackageShareTokenResponse"
        "404":
          description: Package not found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"

  /packages/{packageId}/comments:
    get:
      operationId: listPackageShareComments
      tags: [packages]
      summary: List comments on a package share (authenticated)
      parameters:
        - name: packageId
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "200":
          description: Comments
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/PackageShareComment"

  /package-shares/{token}:
    get:
      operationId: getPackageShare
      tags: [packages]
      summary: Public share viewer payload
      parameters:
        - name: token
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Share view with hydrated assets
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/PackageShareView"
        "404":
          description: Share not found or expired
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"

  /package-shares/{token}/comments:
    post:
      operationId: postPackageShareComment
      tags: [packages]
      summary: Post a comment on a public share link
      parameters:
        - name: token
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/PostPackageShareCommentBody"
      responses:
        "201":
          description: Created comment
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/PackageShareComment"
        "400":
          description: Invalid body
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "404":
          description: Share not found
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
`;

const intakePatchProps = `
                clientEmail:
                  type: string
                  nullable: true
                  description: Client email captured at intake; stored in site_context_raw.intake.
                clientNotes:
                  type: string
                  nullable: true
                  description: Client notes / brief; stored in site_context_raw.intake.
                intakeSource:
                  type: string
                  nullable: true
                  description: Intake channel (link, file, paste, email).
                sourceExcerpt:
                  type: string
                  nullable: true
                  description: Raw excerpt from intake agent (max 8000 chars).
`;

const clientBriefOnSummary = `
        clientBrief:
          oneOf:
            - $ref: "#/components/schemas/ClientBrief"
            - type: "null"
          description: Client context captured at intake, when present.
`;

const schemas = `
    ClientBrief:
      type: object
      properties:
        clientName:
          type: string
          nullable: true
        clientEmail:
          type: string
          nullable: true
        clientNotes:
          type: string
          nullable: true
        intakeSource:
          type: string
          nullable: true
        capturedAt:
          type: string
          format: date-time
          nullable: true
      required:
        - clientName
        - clientEmail
        - clientNotes
        - intakeSource
        - capturedAt

    CreateEngagementBody:
      type: object
      required: [name]
      properties:
        name:
          type: string
        address:
          type: string
          nullable: true
        jurisdiction:
          type: string
          nullable: true
        projectType:
          type: string
          nullable: true
        intakeSource:
          type: string
          nullable: true
        applicantFirm:
          type: string
          nullable: true
        clientEmail:
          type: string
          nullable: true
        clientNotes:
          type: string
          nullable: true
        sourceExcerpt:
          type: string
          nullable: true

    PackageTemplateId:
      type: string
      enum:
        - client-presentation
        - client-review
        - publisher-handoff
        - jurisdiction-manifest

    PackageStatus:
      type: string
      enum:
        - draft
        - exported
        - shared
        - handed-off
        - closed

    PackageSelection:
      type: object
      properties:
        includeIntake:
          type: boolean
        includeBriefing:
          type: boolean
        renderIds:
          type: array
          items:
            type: string
            format: uuid
        videoIds:
          type: array
          items:
            type: string
            format: uuid
        sheetIds:
          type: array
          items:
            type: string
            format: uuid
        heroRenderId:
          type: string
          format: uuid
          nullable: true

    PackageFormSnapshot:
      type: object
      additionalProperties: true
      properties:
        publisherIntake:
          type: object
          additionalProperties: true
        clientHeadline:
          type: string
        clientTalkingPoints:
          type: string
        clientReviewNote:
          type: string

    EngagementPackageRecord:
      type: object
      properties:
        id:
          type: string
          format: uuid
        engagementId:
          type: string
          format: uuid
        template:
          $ref: "#/components/schemas/PackageTemplateId"
        status:
          $ref: "#/components/schemas/PackageStatus"
        title:
          type: string
        snapshotId:
          type: string
          format: uuid
          nullable: true
        selection:
          $ref: "#/components/schemas/PackageSelection"
        formSnapshot:
          oneOf:
            - $ref: "#/components/schemas/PackageFormSnapshot"
            - type: "null"
        clientReviewDeadline:
          type: string
          format: date-time
          nullable: true
        linkedSubmissionId:
          type: string
          format: uuid
          nullable: true
        exportedAt:
          type: string
          format: date-time
          nullable: true
        shareToken:
          type: string
          nullable: true
        createdAt:
          type: string
          format: date-time
        updatedAt:
          type: string
          format: date-time
      required:
        - id
        - engagementId
        - template
        - status
        - title
        - snapshotId
        - selection
        - formSnapshot
        - clientReviewDeadline
        - linkedSubmissionId
        - exportedAt
        - shareToken
        - createdAt
        - updatedAt

    CreateEngagementPackageBody:
      type: object
      required: [template]
      properties:
        template:
          $ref: "#/components/schemas/PackageTemplateId"
        title:
          type: string
        status:
          $ref: "#/components/schemas/PackageStatus"
        snapshotId:
          type: string
          format: uuid
          nullable: true
        selection:
          $ref: "#/components/schemas/PackageSelection"
        formSnapshot:
          oneOf:
            - $ref: "#/components/schemas/PackageFormSnapshot"
            - type: "null"
        clientReviewDeadline:
          type: string
          format: date-time
          nullable: true
        linkedSubmissionId:
          type: string
          format: uuid
          nullable: true

    UpdateEngagementPackageBody:
      type: object
      properties:
        template:
          $ref: "#/components/schemas/PackageTemplateId"
        title:
          type: string
        status:
          $ref: "#/components/schemas/PackageStatus"
        snapshotId:
          type: string
          format: uuid
          nullable: true
        selection:
          $ref: "#/components/schemas/PackageSelection"
        formSnapshot:
          oneOf:
            - $ref: "#/components/schemas/PackageFormSnapshot"
            - type: "null"
        clientReviewDeadline:
          type: string
          format: date-time
          nullable: true
        linkedSubmissionId:
          type: string
          format: uuid
          nullable: true

    PackageShareTokenResponse:
      type: object
      properties:
        token:
          type: string
        shareUrl:
          type: string
      required: [token, shareUrl]

    PackageShareComment:
      type: object
      properties:
        id:
          type: string
          format: uuid
        authorName:
          type: string
        body:
          type: string
        sheetId:
          type: string
          format: uuid
          nullable: true
        createdAt:
          type: string
          format: date-time
      required: [id, authorName, body, sheetId, createdAt]

    PostPackageShareCommentBody:
      type: object
      required: [authorName, body]
      properties:
        authorName:
          type: string
        body:
          type: string
        sheetId:
          type: string
          format: uuid
          nullable: true

    PackageShareAssetRender:
      type: object
      properties:
        id:
          type: string
          format: uuid
        kind:
          type: string
        label:
          type: string
        previewUrl:
          type: string
          nullable: true
      required: [id, kind, label, previewUrl]

    PackageShareAssetSheet:
      type: object
      properties:
        id:
          type: string
          format: uuid
        sheetNumber:
          type: string
        sheetName:
          type: string
        thumbnailUrl:
          type: string
      required: [id, sheetNumber, sheetName, thumbnailUrl]

    PackageShareAssets:
      type: object
      properties:
        heroRender:
          oneOf:
            - $ref: "#/components/schemas/PackageShareAssetRender"
            - type: "null"
        renders:
          type: array
          items:
            $ref: "#/components/schemas/PackageShareAssetRender"
        videos:
          type: array
          items:
            $ref: "#/components/schemas/PackageShareAssetRender"
        sheets:
          type: array
          items:
            $ref: "#/components/schemas/PackageShareAssetSheet"
      required: [heroRender, renders, videos, sheets]

    PackageShareView:
      type: object
      properties:
        engagementName:
          type: string
        package:
          $ref: "#/components/schemas/EngagementPackageRecord"
        assets:
          $ref: "#/components/schemas/PackageShareAssets"
        comments:
          type: array
          items:
            $ref: "#/components/schemas/PackageShareComment"
      required: [engagementName, package, assets, comments]
`;

let next = content;

if (!next.includes("operationId: createEngagement\n")) {
  const anchor = "                  $ref: \"#/components/schemas/EngagementSummary\"\n\n  /engagements/match:";
  if (!next.includes(anchor)) {
    throw new Error("POST /engagements anchor not found");
  }
  next = next.replace(anchor, `                  $ref: \"#/components/schemas/EngagementSummary\"${postEngagements}\n\n  /engagements/match:`);
}

if (!next.includes("operationId: listEngagementPackages")) {
  const anchor = "  /engagements/{id}/briefing:\n    get:";
  if (!next.includes(anchor)) {
    throw new Error("packages paths anchor not found");
  }
  next = next.replace(anchor, `${packagesPaths}\n  /engagements/{id}/briefing:\n    get:`);
}

if (!next.includes("clientEmail:") || !next.includes("description: Client email captured at intake")) {
  const anchor =
    "                    populate a real recipient row on the comment letter.\n      responses:";
  if (!next.includes(anchor)) {
    throw new Error("PATCH intake anchor not found");
  }
  next = next.replace(anchor, `                    populate a real recipient row on the comment letter.${intakePatchProps}\n      responses:`);
}

if (!next.includes("clientBrief:")) {
  const summaryPropsAnchor =
    "            Null when no contact has been captured yet.\n      required:\n        - id\n        - name\n        - jurisdiction\n        - address\n        - status\n        - createdAt\n        - updatedAt\n        - snapshotCount\n        - latestSnapshot\n        - site\n        - revitCentralGuid\n        - revitDocumentPath\n        - applicantFirm\n        - architectOfRecord\n\n    EngagementDetail:";
  if (!next.includes(summaryPropsAnchor)) {
    throw new Error("EngagementSummary clientBrief props anchor not found");
  }
  next = next.replace(
    summaryPropsAnchor,
    `            Null when no contact has been captured yet.${clientBriefOnSummary}\n      required:\n        - id\n        - name\n        - jurisdiction\n        - address\n        - status\n        - createdAt\n        - updatedAt\n        - snapshotCount\n        - latestSnapshot\n        - site\n        - revitCentralGuid\n        - revitDocumentPath\n        - applicantFirm\n        - architectOfRecord\n\n    EngagementDetail:`,
  );

  const detailPropsAnchor =
    "            Null when no contact has been captured yet.\n      required:\n        - id\n        - name\n        - jurisdiction\n        - address\n        - status\n        - createdAt\n        - updatedAt\n        - snapshotCount\n        - latestSnapshot\n        - snapshots\n        - site\n        - revitCentralGuid\n        - revitDocumentPath\n        - applicantFirm\n        - architectOfRecord\n\n    ArchitectOfRecordContact:";
  if (!next.includes(detailPropsAnchor)) {
    throw new Error("EngagementDetail clientBrief props anchor not found");
  }
  next = next.replace(
    detailPropsAnchor,
    `            Null when no contact has been captured yet.${clientBriefOnSummary}\n      required:\n        - id\n        - name\n        - jurisdiction\n        - address\n        - status\n        - createdAt\n        - updatedAt\n        - snapshotCount\n        - latestSnapshot\n        - snapshots\n        - site\n        - revitCentralGuid\n        - revitDocumentPath\n        - applicantFirm\n        - architectOfRecord\n\n    ArchitectOfRecordContact:`,
  );
}

if (!next.includes("ClientBrief:")) {
  const anchor = "    ArchitectOfRecordContact:\n      type: object";
  if (!next.includes(anchor)) {
    throw new Error("schemas anchor not found");
  }
  next = next.replace(anchor, `${schemas}\n    ArchitectOfRecordContact:\n      type: object`);
}

fs.writeFileSync(specPath, out(next), "utf8");
console.log("openapi.yaml updated (packages + intake)");
