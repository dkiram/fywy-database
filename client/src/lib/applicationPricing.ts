// Each extra cable box adds the same monthly fee as the customer-profile add-on.
export const APPLICATION_EXTRA_BOX_MONTHLY = 1000;
export const APPLICATION_EXTRA_BOX_INSTALLATION = 2500;

export function applicationPrice(baseMonthly: string | number | null, baseInstallation: string | number | null, extraBoxes: number) {
  return {
    monthlyFee: (Number(baseMonthly || 0) + extraBoxes * APPLICATION_EXTRA_BOX_MONTHLY).toFixed(2),
    installationFee: (Number(baseInstallation || 0) + extraBoxes * APPLICATION_EXTRA_BOX_INSTALLATION).toFixed(2),
  };
}

export function changeApplicationBoxCount(monthlyFee: string, oldExtras: number, newExtras: number) {
  return Math.max(0, Number(monthlyFee || 0) + (newExtras - oldExtras) * APPLICATION_EXTRA_BOX_MONTHLY).toFixed(2);
}
