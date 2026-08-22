import type { ParsedOnt } from "./parseOntLog.js";

export type CustomerNameRow = {
  customerId: number;
  name: string;
};

export type ExactOntMatch = {
  customer: CustomerNameRow;
  ont: ParsedOnt;
};

export type OntMatchReview = {
  reason:
    | "missing_customer_description"
    | "no_exact_customer_name"
    | "duplicate_customer_name"
    | "multiple_onts_for_customer";
  ont: ParsedOnt;
  candidateCustomerIds: number[];
};

/**
 * Normalize only formatting that cannot change who a person is. Deliberately
 * do not remove punctuation, reorder names, or accept fuzzy similarity: a
 * slightly different name must go to review instead of the wrong customer's
 * disconnect target.
 */
export function normalizeExactCustomerName(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");
}

/**
 * Return only one-name/one-customer/one-ONT matches. Everything ambiguous is
 * kept in the review list and can never reach the automatic import path.
 */
export function matchOntsToCustomers(
  onts: ParsedOnt[],
  customers: CustomerNameRow[]
) {
  const customersByName = new Map<string, CustomerNameRow[]>();
  for (const customer of customers) {
    const normalizedName = normalizeExactCustomerName(customer.name);
    if (!normalizedName) continue;
    const sameName = customersByName.get(normalizedName) ?? [];
    sameName.push(customer);
    customersByName.set(normalizedName, sameName);
  }

  const preliminary: ExactOntMatch[] = [];
  const review: OntMatchReview[] = [];

  for (const ont of onts) {
    if (!ont.description?.trim()) {
      review.push({
        reason: "missing_customer_description",
        ont,
        candidateCustomerIds: [],
      });
      continue;
    }

    const candidates =
      customersByName.get(normalizeExactCustomerName(ont.description)) ?? [];
    if (candidates.length === 0) {
      review.push({
        reason: "no_exact_customer_name",
        ont,
        candidateCustomerIds: [],
      });
      continue;
    }
    if (candidates.length > 1) {
      review.push({
        reason: "duplicate_customer_name",
        ont,
        candidateCustomerIds: candidates.map((customer) => customer.customerId),
      });
      continue;
    }

    preliminary.push({ customer: candidates[0], ont });
  }

  // One customer linked to two ONTs is unsafe even when both descriptions are
  // exact. Withhold every ONT for that customer so a person can resolve it.
  const matchesByCustomer = new Map<number, ExactOntMatch[]>();
  for (const match of preliminary) {
    const sameCustomer = matchesByCustomer.get(match.customer.customerId) ?? [];
    sameCustomer.push(match);
    matchesByCustomer.set(match.customer.customerId, sameCustomer);
  }

  const safeMatches: ExactOntMatch[] = [];
  for (const matches of matchesByCustomer.values()) {
    if (matches.length === 1) {
      safeMatches.push(matches[0]);
      continue;
    }
    for (const match of matches) {
      review.push({
        reason: "multiple_onts_for_customer",
        ont: match.ont,
        candidateCustomerIds: [match.customer.customerId],
      });
    }
  }

  return { safeMatches, review };
}
