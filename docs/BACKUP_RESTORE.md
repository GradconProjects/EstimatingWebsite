# Backup and restore — code and data are separate

The application code (this repository, deployed by Vercel from `main`) and
the entered data (the Supabase `estimator_kv` table and the `gradcon-files`
storage bucket) are backed up and restored **independently**. A source-code
backup does not contain any entered values; a database backup does not
contain any code.

## Code

- **Backup:** a dated branch (`backup/<what>-<date>`) pushed to GitHub, plus
  `git archive --format=zip <commit>` with a SHA-256 checksum kept outside
  the repository.
- **Restore (roll back the live site):** in Vercel → Deployments, open the
  previous production deployment and choose *Promote to Production*
  (instant, no rebuild), or `git revert <commit>` on `main` and push (Vercel
  rebuilds). Neither touches the database.

## Data

- **Backup:** a private script (kept outside the repository) downloads every
  `estimator_kv` row ONE KEY PER REQUEST (a single select of all rows is
  ~30 MB and trips the database statement timeout) and every object in the
  `gradcon-files` bucket, and writes `manifest.json` with a SHA-256 and byte
  count per file plus row/object totals. Verify a backup by re-hashing the
  files against the manifest and comparing the row count with a fresh
  `select key, updated_at` of the table.
- **Restore one project:** upsert its `estimator_kv` row from the backup
  file (`key`, `value`, `updated_at`) through the Supabase SQL editor or the
  REST API. Restoring a row replaces everything entered since the backup
  for THAT project only.
- **Never restore a whole database backup automatically** after a code
  rollback: it would erase every legitimate entry made since the backup.
  Restore only the specific rows that are known to be damaged, after
  comparing `updated_at`.
- Bucket objects (quote versions, estimate versions, project folders) are
  immutable; re-upload a missing object from the backup under the same path.

## Database functions used by the app (optional, additive, read-only or field-level)

- `supabase/migrations/0004_estimator_kv_quote_summaries.sql` — read-only
  summaries without drawing image data (SECURITY INVOKER, STABLE). The app
  detects it and falls back to bounded full-row reads when absent.
- `supabase/migrations/0003_estimator_kv_merge.sql` — field-level merge for
  status / planner / register edits. The app falls back to read-merge-write
  when absent.

Run only the migration you have reviewed, in the Supabase SQL editor; both
are `create or replace` and can be re-run safely.
