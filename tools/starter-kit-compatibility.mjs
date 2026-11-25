import assert from "node:assert/strict";

export function assertStarterKitCompatibility(manifest, lock) {
  const kit = manifest.verifiedRestoreKit === undefined ? manifest.engine : manifest.verifiedRestoreKit;
  assert.ok(kit && typeof kit === "object", "Starter restore kit metadata is missing.");
  assert.equal(kit.kitVersion, lock.version, "Starter data and selected kit versions differ.");
  assert.equal(kit.archiveSha256, lock.archiveSha256, "Starter data and selected kit checksums differ.");
  assert.equal(kit.engineRevision, lock.engineRevision, "Starter data and selected Engine revisions differ.");
}
