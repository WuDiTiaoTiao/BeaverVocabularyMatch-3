# Supabase setup

This project stores one progress row per authenticated user. The SQL contract
is in [`schema.sql`](./schema.sql). Run it once in the Supabase SQL Editor;
the named objects are written so the script can be rerun safely during setup.

## Project setup

1. Open the [Supabase dashboard](https://supabase.com/dashboard), create a
   project (or select the project that will host Synonym Match), and wait for
   the database to finish provisioning.
2. Open **SQL Editor**, create a query, paste the complete contents of
   `supabase/schema.sql`, and run it. The script creates the
   `public.challenge_progress` table, row-level security policies, the
   `public.merge_challenge_progress(...)` RPC, and the required grants.
3. In **Authentication → Providers**, enable the **Email** provider.
4. In **Authentication → Email Templates**, edit the confirmation/sign-in
   email template so the one-time code is visible as a six-digit code. Include
   this exact template expression where the code should appear:

   ```text
   {{ .Token }}
   ```

5. In **Authentication → URL Configuration**, set **Site URL** to:

   ```text
   https://wuditiaotiao.github.io/KaoyanVocabularyMatch-3/
   ```

6. Add local development redirect URLs for `http://127.0.0.1:*`. If the
   dashboard rejects a wildcard port, use the dashboard-compatible path
   wildcard form with each actual development port, for example:
   `http://127.0.0.1:3000/**` (and add another concrete port entry when the
   local server uses a different port). The `/**` suffix permits callback paths;
   Supabase redirect matching does not consistently accept a wildcard port.
7. Configure a public SMTP provider before opening registration broadly. The
   default Supabase mail service is suitable only for controlled testing and
   has delivery/rate limits.
8. From **Project Settings → API**, copy only the **Project URL** and the
   public **anon/publishable key** for frontend configuration.
9. Never copy a service-role or secret key into frontend files, browser
   storage, issue comments, or GitHub. Those keys bypass row-level security
   and belong only in a protected server environment.

## Manual checks for Task 8

These checks require a live Supabase project and two test accounts. They are
intentionally deferred until the project is attached.

### Anonymous access is denied

Using only the public anon key and no session, verify that a direct select from
`public.challenge_progress` is rejected (or returns no rows under RLS), and
that calling `public.merge_challenge_progress(...)` fails with SQLSTATE
`42501`. Confirm the RPC is not callable with an anonymous session.

### User isolation

Sign in as user A and merge a row for one allowed book/scope. Sign in as user B
and verify that B cannot select, update, or delete A's row. Repeat in the other
direction. Each authenticated request must use its own `auth.uid()`; the RPC
does not accept a caller-supplied user ID.

### Pair-union under concurrency

Start with no row for a test account. Submit two authenticated RPC calls at the
same time for the same `book_id` and `scope`, with disjoint pair arrays (for
example `["a"]` and `["b"]`). Verify both calls succeed with `status =
"merged"` and the final row contains the sorted distinct array `["a", "b"]`.
Also verify that the timestamp-selected scalar fields come from the call with
the greater `client_updated_at`; equal timestamps use the incoming call.

### Different-book conflict

Create a row for a test account for `cet4`/`frequent`, then call the RPC for
the same account with a different book such as `ielts`/`frequent`. Verify the
response has `status = "conflict"`, its `record` is the unchanged database row,
and the original row still has its original book and scope.

### Constraint rejection

Call the RPC with a negative score and verify PostgreSQL rejects it with a check
constraint error. Also check that a seed above `9007199254740991`, a negative
counter, `correct_matches > attempts`, a non-array pair value, or an array
containing a non-string value is rejected.

