-- Distinguish supervised equipment tests from ONT writes performed as part of
-- a customer account-status transition. The timestamps make it obvious when
-- the physical action succeeded but the database transition still needs human
-- reconciliation.
ALTER TABLE public.olt_action_attempts
  ADD COLUMN workflow TEXT NOT NULL DEFAULT 'test_control',
  ADD COLUMN account_status_before TEXT,
  ADD COLUMN account_status_after TEXT,
  ADD COLUMN account_status_applied_at TIMESTAMPTZ,
  ADD CONSTRAINT olt_action_attempts_workflow_check
    CHECK (workflow IN ('test_control', 'account_transition')),
  ADD CONSTRAINT olt_action_attempts_account_status_before_check
    CHECK (
      account_status_before IS NULL OR
      account_status_before IN ('active', 'disconnected', 'pending_reconnection', 'closed', 'archived')
    ),
  ADD CONSTRAINT olt_action_attempts_account_status_after_check
    CHECK (
      account_status_after IS NULL OR
      account_status_after IN ('active', 'disconnected', 'pending_reconnection', 'closed', 'archived')
    );

COMMENT ON COLUMN public.olt_action_attempts.workflow IS
  'test_control is the supervised profile-card tool; account_transition is the normal deactivate/reconnect workflow.';
COMMENT ON COLUMN public.olt_action_attempts.account_status_applied_at IS
  'Set only when the database account transition commits after the live OLT result is confirmed.';
