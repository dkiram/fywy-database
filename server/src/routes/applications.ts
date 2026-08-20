/** Implements application intake, matching, service activation, and closure decisions. */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { pool } from "../db.js";
import { insertStatusHistory } from "./accounts.js";
import { loadReceipt } from "./payments.js";

// Application workflow API, including the MVP 3 activation handoff from an
// approved application to an active customer account.
const applicationsRouter = Router();

// These are the only application states that may still receive a decision.
const activeStatuses = [
  "pending",
  "legacy_unresolved",
  "match_review",
] as const;

function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!req.session.employee) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  next();
}

function requireApplicationDecisionRole(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const employee = req.session.employee;
  if (!employee) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  if (!['admin', 'head_office'].includes(employee.role)) {
    return res.status(403).json({
      error: "Only Admin and Head Office can decide applications.",
    });
  }
  next();
}

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

// Whether an imported row may still be decided. Every caller separately
// requires an active status, so this is only ever asked about pending,
// match_review and legacy_unresolved rows.
//
// Until Aug 2026 this also demanded a 2026 application_date on legacy rows,
// which froze the whole legacy_unresolved backlog - roughly half the active
// queue showed no buttons at all and could never be cleared. Head office works
// those by hand now. The date test was redundant besides: migration 020 only
// ever assigns match_review to 2026 rows in the first place, so the extra
// condition could not admit anything, and would silently strand a row if that
// ever stopped being true.
function isImportedDecisionAllowed(application: {
  legacy_source: unknown;
  status: unknown;
}) {
  if (!application.legacy_source) return true;

  return (
    application.status === "match_review" ||
    application.status === "legacy_unresolved"
  );
}

function parseApplicationId(req: Request, res: Response) {
  const value = req.params.applicationId;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    res.status(400).json({ error: "Invalid application ID." });
    return null;
  }
  return Number(value);
}

applicationsRouter.get("/packages", requireAuth, async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        package_id,
        name,
        default_monthly_charge,
        -- Drives the installation fee prefilled on the New Application form.
        installation_fee,
        service_type,
        plan_tier,
        speed_mbps
      FROM public.packages
      WHERE is_active = TRUE
      ORDER BY display_order, package_id;
    `);
    res.json({ packages: result.rows });
  } catch (error) {
    console.error("Could not load packages:", error);
    res.status(500).json({ error: "Could not load packages." });
  }
});

// Load the searchable, five-row application work queue and its summary counts.
applicationsRouter.get("/applications", requireAuth, async (req, res) => {
  try {
    const search = cleanText(req.query.search);
    const view = cleanText(req.query.view) || "active";
    const searchPattern = `%${search}%`;
    const requestedPage = Math.max(
      Number.parseInt(cleanText(req.query.page), 10) || 1,
      1
    );
    const limit = 5;

    const viewClauses: Record<string, string> = {
      active: `
        (
          a.status = 'pending'
          OR a.status = 'match_review'
          OR (
            a.status = 'legacy_unresolved'
            AND a.legacy_source IS DISTINCT FROM 'Copy of ApplicationTBL'
          )
        )
      `,
      pending: "a.status = 'pending'",
      review: "a.status = 'match_review'",
      serviced: "a.status = 'serviced'",
      closed: "a.status IN ('cancelled', 'declined')",
      unresolved: "a.status = 'legacy_unresolved'",
      // Applications confirmed to be an existing customer. Deliberately absent
      // from every other view, including 'active' and 'review', so confirming
      // one clears it off the queue. Still reachable here and under 'all'.
      confirmed: "a.status = 'confirmed_existing'",
      all: "TRUE",
    };
    const viewClause = viewClauses[view] ?? viewClauses.active;

    const countResult = await pool.query(
      `
      SELECT COUNT(*)::INTEGER AS total
      FROM public.applications a
      WHERE ${viewClause}
        AND (
          $1 = ''
          OR a.application_id::TEXT ILIKE $2
          OR COALESCE(a.legacy_application_id::TEXT, '') ILIKE $2
          OR a.name ILIKE $2
          OR COALESCE(a.telephone, '') ILIKE $2
          OR COALESCE(a.address, '') ILIKE $2
        );
      `,
      [search, searchPattern]
    );
    const total = countResult.rows[0].total as number;
    const totalPages = Math.max(Math.ceil(total / limit), 1);
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * limit;

    const applicationsResult = await pool.query(
      `
      SELECT
        a.application_id,
        a.legacy_application_id,
        a.legacy_source,
        a.name,
        a.alias,
        a.address,
        a.occupation,
        a.telephone,
        a.email,
        a.id_type,
        a.id_number,
        a.package_id,
        a.monthly_fee,
        a.application_date,
        a.activation_date,
        a.adult_channel,
        a.additional_box,
        a.pole_box_number,
        a.port_number,
        a.status,
        a.customer_id,
        a.suggested_customer_id,
        a.match_method,
        a.closure_reason,
        a.match_confirmed_at,
        p.name AS package_name,
        suggested.name AS suggested_customer_name,
        linked.name AS linked_customer_name,
        CONCAT_WS(' ', confirmer.first_name, confirmer.last_name)
          AS match_confirmed_by_name,
        fee.payment_id AS installation_payment_id,
        fee.amount_paid AS installation_amount,
        fee.receipt_number AS installation_receipt_number,
        (fee.voided_at IS NOT NULL) AS installation_voided,
        (
          a.status = ANY($3::TEXT[])
          AND a.application_date <
            (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE - 14
        ) AS is_overdue
      FROM public.applications a
      LEFT JOIN public.packages p
        ON a.package_id = p.package_id
      LEFT JOIN public.customers suggested
        ON a.suggested_customer_id = suggested.customer_id
      LEFT JOIN public.customers linked
        ON a.customer_id = linked.customer_id
      LEFT JOIN public.employees confirmer
        ON a.match_confirmed_by_employee_id = confirmer.employee_id
      -- The installation fee taken with this application, if any. A live one
      -- is preferred over a voided one so the drawer shows what is actually
      -- outstanding; the partial unique index guarantees at most one live row.
      LEFT JOIN LATERAL (
        SELECT payment_id, amount_paid, receipt_number, voided_at
        FROM public.payments
        WHERE application_id = a.application_id
        ORDER BY voided_at NULLS FIRST, payment_id
        LIMIT 1
      ) fee ON TRUE
      WHERE ${viewClause}
        AND (
          $1 = ''
          OR a.application_id::TEXT ILIKE $2
          OR COALESCE(a.legacy_application_id::TEXT, '') ILIKE $2
          OR a.name ILIKE $2
          OR COALESCE(a.telephone, '') ILIKE $2
          OR COALESCE(a.address, '') ILIKE $2
        )
      ORDER BY
        CASE
          WHEN a.status = 'pending' THEN 0
          WHEN a.status = 'match_review' THEN 1
          WHEN a.status = 'legacy_unresolved' THEN 2
          ELSE 3
        END,
        a.application_date DESC,
        a.application_id DESC
      LIMIT $4
      OFFSET $5;
      `,
      [search, searchPattern, activeStatuses, limit, offset]
    );

    const summaryResult = await pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE status = 'pending'
             OR status = 'match_review'
             OR (
               status = 'legacy_unresolved'
               AND legacy_source IS DISTINCT FROM 'Copy of ApplicationTBL'
             )
        )::INTEGER AS active,
        COUNT(*) FILTER (
          WHERE status IN ('cancelled', 'declined')
        )::INTEGER AS closed,
        COUNT(*) FILTER (
          WHERE status = 'confirmed_existing'
        )::INTEGER AS confirmed,
        COUNT(*) FILTER (
          WHERE (
            status = 'pending'
            OR status = 'match_review'
            OR (
              status = 'legacy_unresolved'
              AND legacy_source IS DISTINCT FROM 'Copy of ApplicationTBL'
            )
          )
          AND application_date <
            (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE - 14
        )::INTEGER AS overdue
      FROM public.applications;
    `);

    res.json({
      applications: applicationsResult.rows,
      summary: summaryResult.rows[0],
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error("Could not load applications:", error);
    res.status(500).json({ error: "Could not load applications." });
  }
});

applicationsRouter.post("/applications", requireAuth, async (req, res) => {
  const employee = req.session.employee!;
  const name = cleanText(req.body.name);
  const address = cleanText(req.body.address);
  const telephone = cleanText(req.body.telephone);
  const packageIdText = String(req.body.packageId ?? "").trim();
  const monthlyFeeText = String(req.body.monthlyFee ?? "").trim();
  const applicationDate = cleanText(req.body.applicationDate);
  const additionalBoxText = String(req.body.additionalBox ?? "0").trim();
  // Cash taken across the counter when the form is filled in. The client
  // prefills it from the chosen package; an empty value or a zero means no
  // money changed hands and no payment is recorded.
  const installationFeeSupplied = req.body.installationFee !== undefined;
  const installationFeeText = String(req.body.installationFee ?? "").trim();

  if (!name || !address || !telephone) {
    return res.status(400).json({
      error: "Name, address, and telephone are required.",
    });
  }
  if (
    !/^\d+$/.test(packageIdText) ||
    Number(packageIdText) < 1 ||
    Number(packageIdText) > 32767
  ) {
    return res.status(400).json({ error: "Select a valid package." });
  }
  if (
    !/^\d+(\.\d{1,2})?$/.test(monthlyFeeText) ||
    Number(monthlyFeeText) > 999999999999
  ) {
    return res.status(400).json({ error: "Enter a valid monthly fee." });
  }
  if (
    !/^\d+$/.test(additionalBoxText) ||
    Number(additionalBoxText) > 32767
  ) {
    return res.status(400).json({ error: "Enter a valid additional-box count." });
  }
  if (applicationDate && !/^\d{4}-\d{2}-\d{2}$/.test(applicationDate)) {
    return res.status(400).json({ error: "Enter a valid application date." });
  }
  if (
    installationFeeSupplied &&
    installationFeeText !== "" &&
    (!/^\d+(\.\d{1,2})?$/.test(installationFeeText) ||
      Number(installationFeeText) > 999999999999)
  ) {
    return res.status(400).json({ error: "Enter a valid installation fee." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Validate the foreign key explicitly so users receive a useful 400 error.
    const packageResult = await client.query(
      `SELECT package_id, installation_fee
       FROM public.packages WHERE package_id = $1;`,
      [Number(packageIdText)]
    );
    if (packageResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Selected package does not exist." });
    }

    // The package fee is the default; an explicit value from the counter wins,
    // including an explicit blank when nothing was collected.
    const feeText = installationFeeSupplied
      ? installationFeeText
      : String(packageResult.rows[0].installation_fee ?? "").trim();
    const collectingFee = feeText !== "" && Number(feeText) > 0;

    // A payment has to say which office took it. Branch staff without an
    // office assigned cannot record money anywhere in this application, and
    // silently dropping the fee would lose it.
    if (collectingFee && employee.role === "branch" && employee.locationId === null) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Your employee account needs a branch before recording the installation fee.",
      });
    }

    const result = await client.query(
      `
      INSERT INTO public.applications (
        name,
        alias,
        address,
        occupation,
        telephone,
        email,
        id_type,
        id_number,
        package_id,
        monthly_fee,
        application_date,
        adult_channel,
        additional_box,
        status,
        submitted_by_employee_id
      )
      VALUES (
        $1, NULLIF($2, ''), $3, NULLIF($4, ''), $5,
        NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''),
        $9, $10,
        COALESCE(NULLIF($11, '')::DATE,
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE),
        $12, $13, 'pending', $14
      )
      RETURNING application_id, status, application_date;
      `,
      [
        name,
        cleanText(req.body.alias),
        address,
        cleanText(req.body.occupation),
        telephone,
        cleanText(req.body.email),
        cleanText(req.body.idType),
        cleanText(req.body.idNumber),
        Number(packageIdText),
        monthlyFeeText,
        applicationDate,
        req.body.adultChannel === true,
        Number(additionalBoxText),
        employee.employeeId,
      ]
    );
    const application = result.rows[0];

    await client.query(
      `
      INSERT INTO public.audit_logs (
        employee_id, actor_name, action, entity_type, entity_id,
        field_name, old_value, new_value, occurred_at
      )
      VALUES ($1, $2, 'Created application', 'application', $3,
        'status', NULL, 'pending', CURRENT_TIMESTAMP);
      `,
      [
        employee.employeeId,
        `${employee.firstName} ${employee.lastName}`,
        String(application.application_id),
      ]
    );

    // The installation fee is collected when the application is taken, so it
    // belongs in today's takings for the office that took it - not in the
    // takings for whatever later day somebody gets around to activating the
    // account. It hangs off the application until then.
    //
    // payment_date is today in Jamaica even when the application itself is
    // backdated, because it is the day the money arrived. That matches the
    // rule for every other payment: the date is what happened, and a
    // discrepancy goes in the note rather than in the date.
    let installationPayment = null;
    if (collectingFee) {
      const paymentResult = await client.query(
        `
        INSERT INTO public.payments (
          application_id,
          payment_type,
          amount_paid,
          payment_date,
          location,
          cashier_name,
          recorded_by_employee_id,
          location_id,
          note,
          recorded_at
        )
        VALUES (
          $1, 'Installation Fee', $2,
          (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE,
          $3, $4, $5, $6, $7, CURRENT_TIMESTAMP
        )
        RETURNING payment_id;
        `,
        [
          application.application_id,
          feeText,
          employee.locationName ?? "Unassigned location",
          `${employee.firstName} ${employee.lastName}`,
          employee.employeeId,
          employee.locationId,
          `Installation fee collected with application #${application.application_id}`,
        ]
      );
      const paymentId = Number(paymentResult.rows[0].payment_id);

      // Separate statement on purpose: an UPDATE in the same WITH clause as the
      // INSERT reads the pre-insert snapshot and matches nothing.
      await client.query(
        `
        UPDATE public.payments
        SET receipt_number =
          'SPCL-' || TO_CHAR(payment_date, 'YYYYMMDD') || '-' ||
          LPAD(payment_id::TEXT, 9, '0')
        WHERE payment_id = $1;
        `,
        [paymentId]
      );

      // No ledger entry. Installation is one-off work with no matching charge
      // on the account, exactly as when a cashier records one against an
      // existing customer - crediting it would hand somebody a balance they
      // were never owed. And there is no account to credit yet regardless.
      await client.query(
        `
        INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, reason, occurred_at
        )
        VALUES ($1, $2, 'Recorded installation fee with application', 'payment',
          $3, 'amount_paid', NULL, $4, $5, CURRENT_TIMESTAMP);
        `,
        [
          employee.employeeId,
          `${employee.firstName} ${employee.lastName}`,
          String(paymentId),
          feeText,
          `Collected with application #${application.application_id}`,
        ]
      );

      installationPayment = await loadReceipt(client, paymentId);
    }

    await client.query("COMMIT");
    res.status(201).json({ application, installationPayment });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Could not create application:", error);
    res.status(500).json({ error: "Could not create application." });
  } finally {
    client.release();
  }
});

applicationsRouter.patch(
  "/applications/:applicationId/activate",
  requireAuth,
  requireApplicationDecisionRole,
  async (req, res) => {
    const applicationId = parseApplicationId(req, res);
    if (applicationId === null) return;

    const employee = req.session.employee!;
    const requestedCustomerId = req.body.customerId;
    const createNew = req.body.createNew === true;
    const note = cleanText(req.body.note);
    const requestedActivationDate = cleanText(req.body.activationDate);

    if (note.length > 500) {
      return res.status(400).json({
        error: "The activation note must be 500 characters or fewer.",
      });
    }
    if (
      requestedActivationDate &&
      !/^\d{4}-\d{2}-\d{2}$/.test(requestedActivationDate)
    ) {
      return res.status(400).json({ error: "Choose a valid activation date." });
    }

    if (requestedCustomerId != null && !/^\d+$/.test(String(requestedCustomerId))) {
      return res.status(400).json({ error: "Invalid customer selection." });
    }
    if (requestedCustomerId != null && createNew) {
      return res.status(400).json({
        error: "Choose either an existing customer or a new customer.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Lock the application for the entire decision so it cannot be activated
      // by two employees at once.
      const applicationResult = await client.query(
        `SELECT * FROM public.applications WHERE application_id = $1 FOR UPDATE;`,
        [applicationId]
      );
      const application = applicationResult.rows[0];
      if (!application) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Application not found." });
      }
      if (!isImportedDecisionAllowed(application)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "Only imported 2026 Match Review applications can be decided.",
        });
      }
      if (!activeStatuses.includes(application.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "This application has already been decided.",
        });
      }

      const packageIdText = String(
        req.body.packageId ?? application.package_id ?? ""
      ).trim();
      const monthlyFeeText = String(
        req.body.monthlyFee ?? application.monthly_fee ?? ""
      ).trim();
      const poleBoxNumber =
        cleanText(req.body.poleBoxNumber) || application.pole_box_number || "";
      const portNumber =
        cleanText(req.body.portNumber) || application.port_number || "";

      // Package and rate are confirmed at activation time because installation
      // details may have changed since the application was submitted.
      if (!/^\d+$/.test(packageIdText)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Select a valid package." });
      }
      if (
        !/^\d+(\.\d{1,2})?$/.test(monthlyFeeText) ||
        Number(monthlyFeeText) > 999999999999
      ) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Enter a valid monthly fee." });
      }
      if (!application.legacy_source && createNew && (!poleBoxNumber || !portNumber)) {
        // Imported rows may lack installation data. New applications must have
        // both values before an account can go live.
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Pole box and port are required to activate a new application.",
        });
      }

      const packageResult = await client.query(
        `SELECT package_id FROM public.packages WHERE package_id = $1;`,
        [Number(packageIdText)]
      );
      if (packageResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Selected package does not exist." });
      }

      // Register newly used pole-box numbers in the MVP 4 inventory. Existing
      // legacy spelling is preserved while the generated normalized key avoids
      // duplicate boxes that differ only by case or surrounding spaces.
      if (poleBoxNumber) {
        await client.query(
          `
          INSERT INTO public.pole_boxes (box_number, notes, created_by_employee_id)
          VALUES ($1, 'Added during customer activation', $2)
          ON CONFLICT (normalized_box_number) DO NOTHING;
          `,
          [poleBoxNumber, employee.employeeId]
        );
      }

      let customerId: number;
      let createdCustomer = false;

      if (requestedCustomerId != null) {
        // Match Review can link to the suggested existing customer instead of
        // creating a duplicate account.
        customerId = Number(requestedCustomerId);
        const customerResult = await client.query(
          `SELECT customer_id FROM public.customers WHERE customer_id = $1 FOR UPDATE;`,
          [customerId]
        );
        if (customerResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Selected customer not found." });
        }
      } else {
        if (application.suggested_customer_id && !createNew) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "Review the suggested customer before creating a duplicate.",
            suggestedCustomerId: application.suggested_customer_id,
          });
        }

        // Legacy imports supplied customer IDs manually, so synchronize the
        // sequence under an advisory lock before allocating the next ID.
        await client.query("SELECT pg_advisory_xact_lock(834201);");
        await client.query(`
          SELECT SETVAL(
            'public.customer_id_seq',
            GREATEST(
              (SELECT COALESCE(MAX(customer_id), 1) FROM public.customers),
              (SELECT last_value FROM public.customer_id_seq)
            ),
            TRUE
          );
        `);
        const nextIdResult = await client.query(
          `SELECT NEXTVAL('public.customer_id_seq')::INTEGER AS customer_id;`
        );
        customerId = nextIdResult.rows[0].customer_id;

        await client.query(
          `
          INSERT INTO public.customers (
            customer_id, name, address, occupation, telephone, email,
            id_type, id_number, package_id, legacy_package_id, monthly_fee,
            application_date, activation_date, status, adult_channel,
            pole_box_number, port_number, legacy_alias_notes,
            legacy_card_number, legacy_additional_box_notes
          )
          VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11,
            $12,
            COALESCE(
              NULLIF($13, '')::DATE,
              (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
            ),
            'active', $14, $15, $16, $17, $18,
            CASE WHEN $19::SMALLINT > 0 THEN $19::TEXT ELSE NULL END
          );
          `,
          [
            customerId,
            application.name,
            application.address,
            application.occupation,
            application.telephone,
            application.email,
            application.id_type,
            application.id_number,
            Number(packageIdText),
            application.legacy_package_id,
            monthlyFeeText,
            application.application_date,
            requestedActivationDate,
            application.adult_channel,
            poleBoxNumber || null,
            portNumber || null,
            application.alias,
            application.legacy_card_number,
            application.additional_box,
          ]
        );
        createdCustomer = true;

        // A newly activated customer starts its permanent history at Active.
        await insertStatusHistory(client, {
          customerId,
          fromStatus: null,
          toStatus: "active",
          reason: note || `Activated from application #${applicationId}`,
          employeeId: employee.employeeId,
          applicationId,
          effectiveDate: requestedActivationDate,
        });

        await client.query(
          `
          INSERT INTO public.audit_logs (
            employee_id, actor_name, action, entity_type, entity_id,
            field_name, old_value, new_value, reason, occurred_at
          )
          VALUES (
            $1, $2, 'Activated customer account', 'customer', $3,
            'status', NULL, 'active', $4, CURRENT_TIMESTAMP
          );
          `,
          [
            employee.employeeId,
            `${employee.firstName} ${employee.lastName}`,
            String(customerId),
            note || `Activated from application #${applicationId}`,
          ]
        );
      }

      // Preserve the application as Serviced and link it to the resulting
      // customer. The old application is never deleted after activation.
      await client.query(
        `
        UPDATE public.applications
        SET
          status = 'serviced',
          customer_id = $1,
          suggested_customer_id = $1,
          package_id = $2,
          monthly_fee = $3,
          pole_box_number = NULLIF($4, ''),
          port_number = NULLIF($5, ''),
          activation_date = COALESCE(
            NULLIF($6, '')::DATE,
            (CURRENT_TIMESTAMP AT TIME ZONE 'America/Jamaica')::DATE
          ),
          serviced_by_employee_id = $7,
          serviced_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE application_id = $8;
        `,
        [
          customerId,
          Number(packageIdText),
          monthlyFeeText,
          poleBoxNumber,
          portNumber,
          requestedActivationDate,
          employee.employeeId,
          applicationId,
        ]
      );

      // Hand the installation fee to the account it was always for. The same
      // payment row is re-pointed rather than copied, so the receipt number
      // the applicant is holding stays valid, the day's takings do not move,
      // and it lands in the customer's history as their first payment - dated
      // when the money was actually taken.
      //
      // No ledger entry is posted here for the same reason none was posted
      // when it was collected: installation has no matching charge.
      const installationResult = await client.query(
        `
        UPDATE public.payments
        SET customer_id = $1
        WHERE application_id = $2
          AND customer_id IS NULL
          AND voided_at IS NULL
        RETURNING payment_id, amount_paid, receipt_number;
        `,
        [customerId, applicationId]
      );
      const installationPayment = installationResult.rows[0] ?? null;

      if (installationPayment) {
        await client.query(
          `
          INSERT INTO public.audit_logs (
            employee_id, actor_name, action, entity_type, entity_id,
            field_name, old_value, new_value, reason, occurred_at
          )
          VALUES ($1, $2, 'Assigned installation fee to activated customer',
            'payment', $3, 'customer_id', NULL, $4, $5, CURRENT_TIMESTAMP);
          `,
          [
            employee.employeeId,
            `${employee.firstName} ${employee.lastName}`,
            String(installationPayment.payment_id),
            String(customerId),
            `Collected on application #${applicationId}; receipt ${installationPayment.receipt_number}`,
          ]
        );
      }

      await client.query(
        `
        INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, reason, occurred_at
        )
        VALUES ($1, $2, $3, 'application', $4,
          'status', $5, 'serviced', NULLIF($6, ''), CURRENT_TIMESTAMP);
        `,
        [
          employee.employeeId,
          `${employee.firstName} ${employee.lastName}`,
          createdCustomer
            ? "Activated application and created customer"
            : "Activated application and linked customer",
          String(applicationId),
          application.status,
          note,
        ]
      );

      // Customer creation/linking, application servicing, history, and both
      // audit entries succeed or roll back together.
      await client.query("COMMIT");
      res.json({
        applicationId,
        customerId,
        createdCustomer,
        status: "serviced",
        installationPayment,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not activate application:", error);
      res.status(500).json({ error: "Could not activate application." });
    } finally {
      client.release();
    }
  }
);

// Confirm that an application belongs to a customer who already exists.
//
// This is not an activation. No customer is created, and the customer named
// here is not modified in any way - not their address, package, rate, status,
// activation date or billing. The only thing that changes is the application:
// it records which customer it turned out to be, and leaves the work queue.
applicationsRouter.patch(
  "/applications/:applicationId/confirm-match",
  requireAuth,
  requireApplicationDecisionRole,
  async (req, res) => {
    const applicationId = parseApplicationId(req, res);
    if (applicationId === null) return;

    const note = cleanText(req.body.note);
    // The reviewer may confirm against a customer they found themselves rather
    // than the suggested one; falling back to the suggestion covers the
    // ordinary case of agreeing with it.
    const requestedCustomerId = String(req.body.customerId ?? "").trim();
    if (requestedCustomerId && !/^\d+$/.test(requestedCustomerId)) {
      return res.status(400).json({ error: "Invalid customer ID." });
    }

    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const applicationResult = await client.query(
        `
        SELECT status, legacy_source, application_date, suggested_customer_id
        FROM public.applications
        WHERE application_id = $1
        FOR UPDATE;
        `,
        [applicationId]
      );
      const application = applicationResult.rows[0];
      if (!application) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Application not found." });
      }
      if (!isImportedDecisionAllowed(application)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "This imported application is kept as historical evidence.",
        });
      }
      if (!activeStatuses.includes(application.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "This application has already been decided.",
        });
      }

      const customerId = requestedCustomerId
        ? Number(requestedCustomerId)
        : application.suggested_customer_id;

      if (customerId == null) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Choose the existing customer this applicant matches.",
        });
      }

      const customerResult = await client.query(
        `SELECT customer_id, name FROM public.customers WHERE customer_id = $1;`,
        [customerId]
      );
      if (customerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Selected customer not found." });
      }

      await client.query(
        `
        UPDATE public.applications
        SET
          status = 'confirmed_existing',
          customer_id = $1,
          suggested_customer_id = COALESCE(suggested_customer_id, $1),
          match_confirmed_by_employee_id = $2,
          match_confirmed_at = CURRENT_TIMESTAMP,
          closure_reason = NULLIF($3, ''),
          updated_at = CURRENT_TIMESTAMP
        WHERE application_id = $4;
        `,
        [customerId, employee.employeeId, note, applicationId]
      );

      // The one thing that does follow the applicant to the existing customer:
      // money already taken from them. If the counter collected an installation
      // fee on this application, it moves to that customer's payment history
      // rather than sitting against an application nobody will ever activate.
      // Nothing is charged and no balance moves - installation never posts to
      // the ledger.
      const installationResult = await client.query(
        `
        UPDATE public.payments
        SET customer_id = $1
        WHERE application_id = $2
          AND customer_id IS NULL
          AND voided_at IS NULL
        RETURNING payment_id, amount_paid, receipt_number;
        `,
        [customerId, applicationId]
      );
      const installationPayment = installationResult.rows[0] ?? null;

      if (installationPayment) {
        await client.query(
          `
          INSERT INTO public.audit_logs (
            employee_id, actor_name, action, entity_type, entity_id,
            field_name, old_value, new_value, reason, occurred_at
          )
          VALUES ($1, $2, 'Assigned installation fee to matched customer',
            'payment', $3, 'customer_id', NULL, $4, $5, CURRENT_TIMESTAMP);
          `,
          [
            employee.employeeId,
            `${employee.firstName} ${employee.lastName}`,
            String(installationPayment.payment_id),
            String(customerId),
            `Collected on application #${applicationId}; receipt ${installationPayment.receipt_number}`,
          ]
        );
      }

      await client.query(
        `
        INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, reason, occurred_at
        )
        VALUES ($1, $2, 'Confirmed application matches existing customer',
          'application', $3, 'status', $4, 'confirmed_existing',
          NULLIF($5, ''), CURRENT_TIMESTAMP);
        `,
        [
          employee.employeeId,
          `${employee.firstName} ${employee.lastName}`,
          String(applicationId),
          application.status,
          note || `Confirmed as existing customer #${customerId}`,
        ]
      );

      await client.query("COMMIT");
      res.json({
        applicationId,
        customerId,
        customerName: customerResult.rows[0].name,
        status: "confirmed_existing",
        installationPayment,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not confirm application match:", error);
      res.status(500).json({ error: "Could not confirm the match." });
    } finally {
      client.release();
    }
  }
);

// Undo a confirmation made against the wrong customer. Returns the application
// to the review queue; nothing else was ever changed, so there is nothing else
// to put back.
applicationsRouter.patch(
  "/applications/:applicationId/reopen-match",
  requireAuth,
  requireApplicationDecisionRole,
  async (req, res) => {
    const applicationId = parseApplicationId(req, res);
    if (applicationId === null) return;

    const reason = cleanText(req.body.reason);
    if (reason.length < 3 || reason.length > 500) {
      return res.status(400).json({
        error: "Give a reason of 3 to 500 characters for reopening this match.",
      });
    }

    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const applicationResult = await client.query(
        `
        SELECT status, customer_id
        FROM public.applications
        WHERE application_id = $1
        FOR UPDATE;
        `,
        [applicationId]
      );
      const application = applicationResult.rows[0];
      if (!application) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Application not found." });
      }
      if (application.status !== "confirmed_existing") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "Only a confirmed match can be reopened.",
        });
      }

      // customer_id is cleared because the confirmation is what put it there.
      // suggested_customer_id stays, so the reviewer sees the same suggestion
      // they saw the first time.
      await client.query(
        `
        UPDATE public.applications
        SET
          status = 'match_review',
          customer_id = NULL,
          match_confirmed_by_employee_id = NULL,
          match_confirmed_at = NULL,
          closure_reason = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE application_id = $1;
        `,
        [applicationId]
      );

      // A confirmation against the wrong person also put this application's
      // installation fee on the wrong customer's history. Take it back to the
      // application, where the next reviewer's decision will place it again.
      const detachedResult = await client.query(
        `
        UPDATE public.payments
        SET customer_id = NULL
        WHERE application_id = $1
          AND voided_at IS NULL
        RETURNING payment_id, receipt_number;
        `,
        [applicationId]
      );
      const detachedPayment = detachedResult.rows[0] ?? null;

      if (detachedPayment) {
        await client.query(
          `
          INSERT INTO public.audit_logs (
            employee_id, actor_name, action, entity_type, entity_id,
            field_name, old_value, new_value, reason, occurred_at
          )
          VALUES ($1, $2, 'Removed installation fee from reopened match',
            'payment', $3, 'customer_id', $4, NULL, $5, CURRENT_TIMESTAMP);
          `,
          [
            employee.employeeId,
            `${employee.firstName} ${employee.lastName}`,
            String(detachedPayment.payment_id),
            String(application.customer_id ?? ""),
            reason,
          ]
        );
      }

      await client.query(
        `
        INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, reason, occurred_at
        )
        VALUES ($1, $2, 'Reopened a confirmed application match',
          'application', $3, 'status', 'confirmed_existing', 'match_review',
          $4, CURRENT_TIMESTAMP);
        `,
        [
          employee.employeeId,
          `${employee.firstName} ${employee.lastName}`,
          String(applicationId),
          reason,
        ]
      );

      await client.query("COMMIT");
      res.json({ applicationId, status: "match_review" });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not reopen application match:", error);
      res.status(500).json({ error: "Could not reopen the match." });
    } finally {
      client.release();
    }
  }
);

applicationsRouter.patch(
  "/applications/:applicationId/close",
  requireAuth,
  requireApplicationDecisionRole,
  async (req, res) => {
    const applicationId = parseApplicationId(req, res);
    if (applicationId === null) return;

    const status = cleanText(req.body.status);
    const reason = cleanText(req.body.reason);
    if (!['cancelled', 'declined'].includes(status)) {
      return res.status(400).json({
        error: "Choose cancelled or declined.",
      });
    }

    const employee = req.session.employee!;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const applicationResult = await client.query(
        `
        SELECT status, legacy_source, application_date
        FROM public.applications
        WHERE application_id = $1
        FOR UPDATE;
        `,
        [applicationId]
      );
      const application = applicationResult.rows[0];
      if (!application) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Application not found." });
      }
      if (!isImportedDecisionAllowed(application)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "Only imported 2026 Match Review applications can be decided.",
        });
      }
      if (!activeStatuses.includes(application.status)) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "This application has already been decided.",
        });
      }

      await client.query(
        `
        UPDATE public.applications
        SET
          status = $1,
          closure_reason = NULLIF($2, ''),
          closed_by_employee_id = $3,
          closed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE application_id = $4;
        `,
        [status, reason, employee.employeeId, applicationId]
      );

      // An application that never becomes an account cannot keep the money it
      // took. Voiding is the same reversal an admin would apply by hand: the
      // receipt survives as evidence, stamped VOIDED, and the amount drops out
      // of the day's takings and every report. No ledger reversal is needed
      // because installation never posted a credit in the first place.
      //
      // The office still has to hand the cash back at the counter. This records
      // that the collection is no longer good, not that a refund happened.
      const voidReason =
        `Application #${applicationId} ${status}` +
        (reason ? `: ${reason}` : "; installation fee no longer collected");
      const voidedResult = await client.query(
        `
        UPDATE public.payments
        SET
          voided_at = CURRENT_TIMESTAMP,
          voided_by_employee_id = $1,
          void_reason = $2
        WHERE application_id = $3
          AND voided_at IS NULL
        RETURNING payment_id, amount_paid, receipt_number;
        `,
        [employee.employeeId, voidReason, applicationId]
      );
      const voidedPayment = voidedResult.rows[0] ?? null;

      if (voidedPayment) {
        await client.query(
          `
          INSERT INTO public.audit_logs (
            employee_id, actor_name, action, entity_type, entity_id,
            field_name, old_value, new_value, reason, occurred_at
          )
          VALUES ($1, $2, 'Voided installation fee with closed application',
            'payment', $3, 'payment_status', 'active', 'voided', $4,
            CURRENT_TIMESTAMP);
          `,
          [
            employee.employeeId,
            `${employee.firstName} ${employee.lastName}`,
            String(voidedPayment.payment_id),
            voidReason,
          ]
        );
      }

      await client.query(
        `
        INSERT INTO public.audit_logs (
          employee_id, actor_name, action, entity_type, entity_id,
          field_name, old_value, new_value, reason, occurred_at
        )
        VALUES ($1, $2, $3, 'application', $4,
          'status', $5, $6, NULLIF($7, ''), CURRENT_TIMESTAMP);
        `,
        [
          employee.employeeId,
          `${employee.firstName} ${employee.lastName}`,
          status === "cancelled" ? "Cancelled application" : "Declined application",
          String(applicationId),
          application.status,
          status,
          reason,
        ]
      );

      await client.query("COMMIT");
      res.json({ applicationId, status, voidedPayment });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Could not close application:", error);
      res.status(500).json({ error: "Could not close application." });
    } finally {
      client.release();
    }
  }
);

export default applicationsRouter;
