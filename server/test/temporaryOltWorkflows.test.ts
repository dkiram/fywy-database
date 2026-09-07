import assert from "node:assert/strict";
import test from "node:test";
import {
  isHanoverNoDescriptionPlaceholder,
  isTemporaryHanoverWorkflow,
  readWithTemporaryHanoverFallback,
} from "../src/huawei/temporaryOltWorkflows.js";

test("automatic unverified fallback requires the configured Hanover row and exact IP", () => {
  assert.equal(
    isTemporaryHanoverWorkflow({
      configuredNormalizedName: "HANOVER",
      configuredManagementIp: "192.168.1.5",
      submittedManagementIp: "192.168.1.5",
    }),
    true
  );
  assert.equal(
    isTemporaryHanoverWorkflow({
      configuredNormalizedName: "HANOVER",
      configuredManagementIp: "192.168.1.5",
      submittedManagementIp: "192.168.1.99",
    }),
    false
  );
  assert.equal(
    isTemporaryHanoverWorkflow({
      configuredNormalizedName: "MANDEVILLE",
      configuredManagementIp: "192.168.1.5",
      submittedManagementIp: "192.168.1.5",
    }),
    false
  );
});

test("only Hanover's exact no-description marker receives the automatic override", () => {
  assert.equal(isHanoverNoDescriptionPlaceholder(true, "ONT_NO_DESCRIPTION"), true);
  assert.equal(isHanoverNoDescriptionPlaceholder(true, " ont_no_description "), true);
  assert.equal(isHanoverNoDescriptionPlaceholder(false, "ONT_NO_DESCRIPTION"), false);
  assert.equal(isHanoverNoDescriptionPlaceholder(true, "Leroy Muir"), false);
  assert.equal(isHanoverNoDescriptionPlaceholder(true, null), false);
});

test("Hanover continues unverified when the live read returns no ONT", async () => {
  const result = await readWithTemporaryHanoverFallback(true, async () => null);
  assert.equal(result.liveValue, null);
  assert.equal(result.usedUnverifiedFallback, true);
  assert.equal(result.issue, null);
});

test("Hanover continues unverified when the live read throws", async () => {
  const result = await readWithTemporaryHanoverFallback(true, async () => {
    throw new Error("OLT connection unavailable");
  });
  assert.equal(result.liveValue, null);
  assert.equal(result.usedUnverifiedFallback, true);
  assert.equal(result.issue, "OLT connection unavailable");
});

test("other OLTs still reject a failed live read", async () => {
  await assert.rejects(
    () =>
      readWithTemporaryHanoverFallback(false, async () => {
        throw new Error("OLT connection unavailable");
      }),
    /OLT connection unavailable/
  );
});
