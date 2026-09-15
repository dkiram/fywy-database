"""Build a rollback-only SQL regression fixture from the real billing migrations.

Run against an EMPTY disposable PostgreSQL 17 database (no production access):
  python3 server/test/profileBillingFixture.py > /tmp/profile-billing-test.sql
  docker exec -i <test-container> psql -U postgres -q < /tmp/profile-billing-test.sql

Checks scoped/batch equivalence, customer isolation, global watermark preservation,
repeat loads, month-end charges, service outages, credits, holds and suspension quotes.
"""
from pathlib import Path
root = Path(__file__).resolve().parents[2]
def migration(n):
 return next((root/'database/migrations').glob(n+'_*')).read_text()
def function(n,name):
 s=migration(n); start=s.index('CREATE OR REPLACE FUNCTION public.'+name+'(')
 # Find the actual dollar-quoted body delimiter.
 import re
 match=re.search(r'AS (\$\w*\$)',s[start:]); tag=match[1]; body=start+match.end()
 return s[start:s.index(tag+';',body)+len(tag)+1]
def view(n,name):
 s=migration(n);a=s.index('CREATE OR REPLACE VIEW public.'+name+' AS');return s[a:s.index(';',a)+1]
parts=['''\\set ON_ERROR_STOP on
BEGIN;
-- Deliberately fails if run against a populated schema. Use an empty database.
CREATE TABLE customers(customer_id integer PRIMARY KEY, status text, activation_date date, reactivation_date date, deactivation_date date, monthly_fee numeric, package_id integer);
CREATE TABLE payments(customer_id integer, payment_date date, voided_at timestamptz);
CREATE TABLE packages(package_id integer PRIMARY KEY, reconnection_fee numeric);
CREATE TABLE customer_billing_start(customer_id integer PRIMARY KEY, billing_start_date date);
CREATE TABLE customer_rate_history(customer_rate_history_id serial PRIMARY KEY, customer_id integer, monthly_fee numeric, effective_date date, is_legacy_estimate boolean DEFAULT false);
CREATE TABLE account_status_history(account_status_history_id serial PRIMARY KEY, customer_id integer, to_status text, effective_date date, changed_at timestamptz DEFAULT now());
CREATE TABLE account_ledger_entries(account_ledger_entry_id serial PRIMARY KEY, customer_id integer, entry_type text, amount numeric, effective_date date, due_date date, grace_end_date date, description text, reason text, customer_rate_history_id integer, is_verified boolean DEFAULT true, source_key text UNIQUE);
CREATE INDEX ON account_ledger_entries(customer_id);
CREATE TABLE disconnection_holds(disconnection_hold_id serial PRIMARY KEY, customer_id integer, status text, expires_on date, reason text);
CREATE TABLE billing_generation_state(singleton boolean PRIMARY KEY, generated_through date, updated_at timestamptz);
CREATE TABLE suspension_terms(monthly_fee numeric, extended_after_months integer, reconnection_fee numeric, extended_reconnection_fee numeric);
INSERT INTO suspension_terms VALUES(500,3,500,1500);
''']
for n,name in [('026','spcl_anniversary_date'),('054','spcl_customer_service_active_on')]:parts.append(function(n,name))
parts.append(view('067','customer_suspension_episodes'))
for name in ['spcl_customer_suspended_on','spcl_prevent_offline_monthly_charge','spcl_generate_suspension_charges','spcl_generate_monthly_charges','spcl_suspension_reconnection_fee']:parts.append(function('067',name))
parts.append('CREATE TRIGGER guard BEFORE INSERT ON account_ledger_entries FOR EACH ROW EXECUTE FUNCTION spcl_prevent_offline_monthly_charge();')
parts.extend([view('069','customer_billing_status'),view('071','customer_suspension_status'),migration('084')])
parts.append('''
INSERT INTO customers VALUES
 (1,'active','2026-01-31',NULL,NULL,2500,1),
 (2,'active','2026-01-31',NULL,NULL,3500,1),
 (3,'suspended','2026-01-01',NULL,NULL,2500,1),
 (4,'suspended','2026-01-01',NULL,NULL,2500,1),
 (5,'offline','2026-01-31',NULL,'2026-02-15',2500,1),
 (6,'active','2026-01-01',NULL,NULL,2500,1);
INSERT INTO packages VALUES(1,1500);
INSERT INTO customer_rate_history(customer_id,monthly_fee,effective_date)
 SELECT customer_id,monthly_fee,activation_date FROM customers;
INSERT INTO account_status_history(customer_id,to_status,effective_date) VALUES
 (3,'suspended','2026-02-10'),(4,'suspended','2026-02-10'),(5,'offline','2026-02-15'),
 (6,'active','2026-01-01'),(6,'offline','2026-02-01'),(6,'active','2026-03-01');
INSERT INTO billing_generation_state VALUES(true,'2026-01-31',now());
SELECT spcl_generate_customer_monthly_charges(1,'2026-03-31');
DO $$ BEGIN
 IF (SELECT count(*) FROM account_ledger_entries) <> 2 THEN RAISE EXCEPTION 'Expected only target monthly charges'; END IF;
 IF EXISTS(SELECT 1 FROM account_ledger_entries WHERE customer_id<>1) THEN RAISE EXCEPTION 'Touched another customer'; END IF;
 IF NOT EXISTS(SELECT 1 FROM account_ledger_entries WHERE due_date='2026-02-28' AND amount=2500) THEN RAISE EXCEPTION 'Month-end rule changed'; END IF;
 IF (SELECT generated_through FROM billing_generation_state) <> DATE '2026-01-31' THEN RAISE EXCEPTION 'Advanced global watermark'; END IF;
END $$;
SELECT spcl_generate_customer_monthly_charges(1,'2026-03-31');
DO $$ BEGIN
 IF (SELECT count(*) FROM account_ledger_entries) <> 2 THEN RAISE EXCEPTION 'Duplicate charges on repeat load'; END IF;
END $$;
SELECT spcl_generate_customer_monthly_charges(3,'2026-03-31');
DO $$ BEGIN
 IF (SELECT count(*) FROM account_ledger_entries WHERE customer_id=3 AND entry_type='suspension_charge')<>2 THEN RAISE EXCEPTION 'Missing suspension fees'; END IF;
 IF EXISTS(SELECT 1 FROM account_ledger_entries WHERE customer_id=4) THEN RAISE EXCEPTION 'Generated another suspension'; END IF;
END $$;
SELECT spcl_generate_customer_monthly_charges(customer_id,'2026-03-31') FROM customers;
CREATE TEMP TABLE scoped_charges AS SELECT customer_id,entry_type,amount,effective_date,due_date,grace_end_date,description,customer_rate_history_id,is_verified,source_key FROM account_ledger_entries;
TRUNCATE account_ledger_entries;
SELECT spcl_generate_monthly_charges('2026-03-31');
DO $$ BEGIN
 IF EXISTS((SELECT * FROM scoped_charges EXCEPT SELECT customer_id,entry_type,amount,effective_date,due_date,grace_end_date,description,customer_rate_history_id,is_verified,source_key FROM account_ledger_entries)
 UNION ALL (SELECT customer_id,entry_type,amount,effective_date,due_date,grace_end_date,description,customer_rate_history_id,is_verified,source_key FROM account_ledger_entries EXCEPT SELECT * FROM scoped_charges)) THEN RAISE EXCEPTION 'Scoped generation differs from batch generation'; END IF;
END $$;
INSERT INTO account_ledger_entries(customer_id,entry_type,amount,effective_date,is_verified) VALUES (1,'monthly_payment',-3000,'2026-03-01',true),(3,'credit',-10000,'2026-03-01',false);
INSERT INTO disconnection_holds(customer_id,status,expires_on,reason) VALUES(1,'active',CURRENT_DATE+365,'test');
DO $$ DECLARE c integer; BEGIN
 FOR c IN SELECT customer_id FROM customers LOOP
  IF EXISTS((SELECT * FROM spcl_customer_billing_status(c) EXCEPT SELECT * FROM customer_billing_status WHERE customer_id=c)
    UNION ALL (SELECT * FROM customer_billing_status WHERE customer_id=c EXCEPT SELECT * FROM spcl_customer_billing_status(c))) THEN RAISE EXCEPTION 'Billing mismatch for %',c; END IF;
  IF EXISTS((SELECT * FROM spcl_customer_suspension_status(c) EXCEPT SELECT * FROM customer_suspension_status WHERE customer_id=c)
    UNION ALL (SELECT * FROM customer_suspension_status WHERE customer_id=c EXCEPT SELECT * FROM spcl_customer_suspension_status(c))) THEN RAISE EXCEPTION 'Suspension quote mismatch for %',c; END IF;
 END LOOP;
 IF EXISTS(SELECT * FROM spcl_customer_billing_status(999)) THEN RAISE EXCEPTION 'Unknown account returned billing'; END IF;
 IF EXISTS(SELECT * FROM spcl_customer_suspension_status(1)) THEN RAISE EXCEPTION 'Active account returned suspension'; END IF;
END $$;
ROLLBACK;
\\echo Profile billing regression checks passed
''')
# Compile and execute the actual route SELECTs as well as the database functions.
import re
routes = (root / 'server/src/routes/accounts.ts').read_text()
route_checks = []
for route, end_marker in [('billing-status', '// A dated management pass'),
                          ('suspension', '// Management action: active -> offline')]:
 start = routes.index('  "/customers/:customerId/' + route + '",')
 section = routes[start:routes.index(end_marker, start)]
 for query in re.findall(r'`\s*(SELECT[\s\S]*?)`', section):
  name = 'profile_query_' + str(len(route_checks))
  route_checks.append(f'PREPARE {name}(integer) AS {query} EXECUTE {name}(3);')
parts[-1] = parts[-1].replace('ROLLBACK;', '\n'.join(route_checks) + '\nROLLBACK;')
print('\n'.join(parts))
