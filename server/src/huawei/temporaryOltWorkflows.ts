/** Temporary, tightly scoped rules for OLTs not yet in the normal U2000 workflow. */

export const TEMPORARY_PUTTY_CONFIRMATION_OLT = "HANOVER";

export function isHanoverPuttyConfirmationAllowed(values: {
  configuredNormalizedName: string | null | undefined;
  configuredManagementIp: string | null | undefined;
  submittedManagementIp: string;
}) {
  return (
    values.configuredNormalizedName === TEMPORARY_PUTTY_CONFIRMATION_OLT &&
    values.configuredManagementIp === values.submittedManagementIp
  );
}

export function isHanoverNoDescriptionPlaceholder(
  isHanoverWorkflow: boolean,
  description: string | null | undefined
) {
  return (
    isHanoverWorkflow &&
    description?.normalize("NFKC").trim().toLocaleLowerCase("en-US") ===
      "ont_no_description"
  );
}
