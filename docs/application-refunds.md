# Application refunds

Apply `087_add_application_refunds.sql` before deploying the server/client changes. The migration does not change historical collections or previously voided payments.

A staff member opens an active, unactivated application with an unvoided payment, chooses **Request Refund**, records the date the full amount was handed back, and confirms the cash return. The amount comes from the original payment; the returning office and cashier come from the staff account. Accounts without an assigned office cannot submit a cash return.

**Refund Requests** on Applications lists pending requests. Head Office or Admin can approve, or reject with an explanation. Approval is atomic: it records a negative **Refund** payment on the money-return date, closes the application with reason **Refund**, cancels outstanding installation jobs, and records the reviewer in the audit trail. Rejection keeps the application and financial totals unchanged; a corrected request may be submitted. Pending approval blocks activation, match confirmation, closing, and new installation dispatch.

The original collection and receipt remain unchanged. Example: J$7,000 collected at Newport on Monday and handed back there Wednesday remains +J$7,000 Monday and becomes -J$7,000 Wednesday once approved, even if approval is Friday. The refund belongs to the returning cashier/office, not the approver. Daily totals and location totals include the negative transaction. Payments by Date and Payments by Location show Collected, Refunds (negative), and Net Total, including totals for any selected monthly date range.

Paid applications can no longer be closed using Not Serviced to silently void their collection. Existing payment voids remain the separate Admin-only correction workflow; pending/approved refund-linked payments cannot be voided or edited financially. Refund requests and their source payments are preserved by foreign keys, and a unique index plus transactional locks prevents duplicate refunds.

Validation: route tests cover approval permissions, date validation, duplicates, returning-office attribution, rejection, changed payments, job closure, and rollback on audit failure. PostgreSQL migration/integration validation is required before production deployment; mocked route tests do not execute SQL or database triggers.
