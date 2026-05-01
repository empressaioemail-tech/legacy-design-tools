/**
 * Vendored Revit add-in request-signing snippet — Task #173.
 *
 * The production HMAC writer for `POST /api/bim-models/:id/divergence`
 * is the C# Revit add-in maintained by the Revit team. The api-server
 * route tests in `bim-models.test.ts` mint signatures with their own
 * inline helper, which is fine for "did the server's HMAC verifier
 * round-trip correctly" but cannot catch contract drift on the *add-in*
 * side: if the add-in renames a header or changes the canonical
 * `requestId.bimModelId` separator, the inline helper would silently
 * stay aligned with the server and the unit tests would still pass —
 * production would 401.
 *
 * This module is the contract anchor. It is a line-for-line TypeScript
 * port of the C# signing helper the Revit add-in ships in production
 * (`DivergenceRequestSigner.cs`, vendored as of Task #166). It is kept
 * deliberately separate from the test file so:
 *
 *   1. The test exercises this exact code path and not a server-aware
 *      shortcut. If the server side renames a header or changes the
 *      separator, the test will fail because this vendored snippet
 *      still emits the old shape.
 *
 *   2. The vendored constants (header names, separator, hash family,
 *      digest encoding) are the things to keep in sync with the C#
 *      source. The reviewer of a future Revit-team PR re-vendoring
 *      this file has a single small surface to compare against.
 *
 * If the Revit team ever changes the canonical signing input, the
 * header names, the hash family, or the digest encoding, this file
 * is the place to mirror that change AND update the server side in
 * `routes/bimModels.ts` — both halves of the contract have to move
 * together. The test in `bim-models-revit-contract.test.ts` is what
 * makes that breakage loud.
 *
 * --- Original C# (vendored, do not edit without re-syncing the
 * Revit add-in repo): ---
 *
 *   public static class DivergenceRequestSigner
 *   {
 *       public const string RequestIdHeader = "x-bim-model-request-id";
 *       public const string SignatureHeader = "x-bim-model-signature";
 *
 *       public static SignedDivergenceRequest Sign(
 *           string sharedSecret,
 *           string bimModelId,
 *           string requestId)
 *       {
 *           var canonical = $"{requestId}.{bimModelId}";
 *           using var hmac = new HMACSHA256(
 *               Encoding.UTF8.GetBytes(sharedSecret));
 *           var hashBytes = hmac.ComputeHash(
 *               Encoding.UTF8.GetBytes(canonical));
 *           var signatureHex = BitConverter
 *               .ToString(hashBytes)
 *               .Replace("-", string.Empty)
 *               .ToLowerInvariant();
 *           return new SignedDivergenceRequest(
 *               RequestIdHeader, requestId,
 *               SignatureHeader, signatureHex);
 *       }
 *   }
 */

import { createHmac } from "node:crypto";

/**
 * Header names the Revit add-in sets on every divergence POST.
 * Exported so the test can assert the server reads the *exact* header
 * names the add-in writes — a rename on either side would silently
 * 401 in production without this guard.
 */
export const REVIT_ADDIN_REQUEST_ID_HEADER = "x-bim-model-request-id";
export const REVIT_ADDIN_SIGNATURE_HEADER = "x-bim-model-signature";

/**
 * Canonical signing-input separator. The C# add-in formats the input
 * as `${requestId}.${bimModelId}` — exported so the test can prove
 * the server agrees on the separator without reaching into the
 * server's HMAC helper.
 */
export const REVIT_ADDIN_CANONICAL_SEPARATOR = ".";

export interface SignedDivergenceRequest {
  requestIdHeaderName: string;
  requestIdHeaderValue: string;
  signatureHeaderName: string;
  signatureHeaderValue: string;
}

/**
 * Produce the headers a real Revit-add-in divergence POST sets.
 *
 * Mirrors `DivergenceRequestSigner.Sign` line-for-line:
 *   - canonical input is `${requestId}${SEPARATOR}${bimModelId}`
 *   - HMAC-SHA256 over the UTF-8 bytes of the secret and the input
 *   - hex-digest, lowercased (matches `BitConverter.ToString`
 *     followed by `.Replace("-", "").ToLowerInvariant()`)
 */
export function signDivergenceRequest(args: {
  sharedSecret: string;
  bimModelId: string;
  requestId: string;
}): SignedDivergenceRequest {
  const canonical =
    `${args.requestId}${REVIT_ADDIN_CANONICAL_SEPARATOR}${args.bimModelId}`;
  const signatureHex = createHmac("sha256", args.sharedSecret)
    .update(canonical, "utf8")
    .digest("hex")
    .toLowerCase();
  return {
    requestIdHeaderName: REVIT_ADDIN_REQUEST_ID_HEADER,
    requestIdHeaderValue: args.requestId,
    signatureHeaderName: REVIT_ADDIN_SIGNATURE_HEADER,
    signatureHeaderValue: signatureHex,
  };
}
