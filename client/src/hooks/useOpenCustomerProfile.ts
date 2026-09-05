import { useCallback } from "react";
import {
  useLocation,
  useNavigate,
  type Location,
} from "react-router";

export type CustomerReturnContext = {
  to: string;
  label: string;
  locationKey: string;
};

type CustomerNavigationState = {
  customerReturn?: CustomerReturnContext;
};

const returnLabels: Array<[string, string]> = [
  ["/customers", "Customer Search"],
  ["/reports", "Reports & Analytics"],
  ["/account-operations", "Account Operations"],
  ["/applications", "Applications"],
  ["/service-requests", "Service Tickets"],
  ["/pole-boxes", "Pole Boxes"],
  ["/activity-history", "Activity History"],
  ["/payments", "Daily Payments"],
];

function isSafeReturnPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return false;
  }

  const pathname = value.split(/[?#]/, 1)[0];
  return returnLabels.some(([path]) => pathname === path);
}

export function getCustomerReturnContext(state: unknown): CustomerReturnContext | null {
  if (!state || typeof state !== "object") return null;
  const candidate = (state as CustomerNavigationState).customerReturn;
  if (
    !candidate ||
    !isSafeReturnPath(candidate.to) ||
    typeof candidate.locationKey !== "string"
  ) {
    return null;
  }

  const pathname = candidate.to.split(/[?#]/, 1)[0];
  const label = returnLabels.find(([path]) => path === pathname)?.[1];
  return label ? { ...candidate, label } : null;
}

export function customerProfileState(location: Location): CustomerNavigationState {
  // Moving between service accounts on a customer profile must retain the
  // original list as the destination, rather than turning the previous
  // service account into the Back button's destination.
  const inherited = getCustomerReturnContext(location.state);
  if (inherited) return { customerReturn: inherited };

  const label = returnLabels.find(([path]) => path === location.pathname)?.[1];
  if (!label) return {};

  return {
    customerReturn: {
      to: `${location.pathname}${location.search}${location.hash}`,
      label,
      locationKey: location.key,
    },
  };
}

/** Opens a customer while recording the exact list view that launched it. */
export function useOpenCustomerProfile() {
  const navigate = useNavigate();
  const location = useLocation();

  return useCallback(
    (customerId: number | string) => {
      navigate(`/customers/${customerId}`, {
        state: customerProfileState(location),
      });
    },
    [location, navigate]
  );
}
