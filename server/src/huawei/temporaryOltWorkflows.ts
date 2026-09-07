/** Temporary, tightly scoped rules for OLTs not yet in the normal U2000 workflow. */

export const TEMPORARY_PUTTY_CONFIRMATION_OLT = "HANOVER";

export function isTemporaryHanoverWorkflow(values: {
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

/**
 * Hanover temporarily accepts an unverified location when its live read is
 * unavailable or returns no ONT. Other OLTs preserve the original result or
 * error so their strict activation checks remain unchanged.
 */
export async function readWithTemporaryHanoverFallback<T>(
  isHanoverWorkflow: boolean,
  readLiveValue: () => Promise<T | null>
) {
  try {
    const liveValue = await readLiveValue();
    return {
      liveValue,
      usedUnverifiedFallback: isHanoverWorkflow && liveValue === null,
      issue: null as string | null,
    };
  } catch (error) {
    if (!isHanoverWorkflow) throw error;
    return {
      liveValue: null,
      usedUnverifiedFallback: true,
      issue:
        error instanceof Error
          ? error.message
          : "The automated Hanover verification did not complete.",
    };
  }
}
