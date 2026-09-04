import assert from "node:assert/strict";
import test from "node:test";
import {
  isHanoverNoDescriptionPlaceholder,
  isHanoverPuttyConfirmationAllowed,
} from "../src/huawei/temporaryOltWorkflows.js";

test("PuTTY fallback requires the configured Hanover inventory row and exact IP", () => {
  assert.equal(
    isHanoverPuttyConfirmationAllowed({
      configuredNormalizedName: "HANOVER",
      configuredManagementIp: "192.168.1.5",
      submittedManagementIp: "192.168.1.5",
    }),
    true
  );
  assert.equal(
    isHanoverPuttyConfirmationAllowed({
      configuredNormalizedName: "HANOVER",
      configuredManagementIp: "192.168.1.5",
      submittedManagementIp: "192.168.1.99",
    }),
    false
  );
  assert.equal(
    isHanoverPuttyConfirmationAllowed({
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
