import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createCollateralAssetToken,
  verifyCollateralAssetToken,
} from "../lib/collateral/exportSignedUrl";

describe("collateral exportSignedUrl", () => {
  const prev = process.env.COLLATERAL_SIGNING_SECRET;

  beforeEach(() => {
    process.env.COLLATERAL_SIGNING_SECRET = "test-signing-secret-32chars-min!!";
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.COLLATERAL_SIGNING_SECRET;
    else process.env.COLLATERAL_SIGNING_SECRET = prev;
  });

  it("accepts a valid token for matching job and asset", () => {
    const now = Date.now();
    const token = createCollateralAssetToken({
      jobId: "11111111-1111-1111-1111-111111111111",
      assetKey: "render:22222222-2222-2222-2222-222222222222",
      now,
    });
    const payload = verifyCollateralAssetToken(
      token,
      "render:22222222-2222-2222-2222-222222222222",
    );
    expect(payload).toMatchObject({
      jobId: "11111111-1111-1111-1111-111111111111",
      assetKey: "render:22222222-2222-2222-2222-222222222222",
    });
    expect(payload!.exp).toBeGreaterThan(now);
  });

  it("rejects expired tokens", () => {
    const past = Date.now() - 20 * 60 * 1000;
    const token = createCollateralAssetToken({
      jobId: "11111111-1111-1111-1111-111111111111",
      assetKey: "sheet:abc",
      now: past,
    });
    expect(verifyCollateralAssetToken(token, "sheet:abc")).toBeNull();
  });

  it("rejects wrong asset key", () => {
    const token = createCollateralAssetToken({
      jobId: "11111111-1111-1111-1111-111111111111",
      assetKey: "sheet:one",
    });
    expect(verifyCollateralAssetToken(token, "sheet:two")).toBeNull();
  });

  it("rejects tampered signature", () => {
    const token = createCollateralAssetToken({
      jobId: "11111111-1111-1111-1111-111111111111",
      assetKey: "sheet:one",
    });
    const tampered = token.slice(0, -4) + "xxxx";
    expect(verifyCollateralAssetToken(tampered, "sheet:one")).toBeNull();
  });
});
