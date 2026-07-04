# Migrations

Applied migrations are tracked by FILENAME in `_schema_migrations`. There is
no drizzle meta journal, so the filename number is the migration's identity:
two branches shipping the same number collide as soon as the second one merges.

## Claiming a migration number

Parallel branches must claim the next free number, not the next number after
their own base:

1. Check `lib/db/drizzle/` on **main** for the highest committed number.
2. Check **open PRs and unmerged branches** for numbers they already claim
   (`gh pr list`, then scan each PR's diff for `lib/db/drizzle/00*`).
3. Claim the next number free across BOTH. If two in-flight branches want a
   number at the same time, the one that merges first keeps it.
4. If another branch merges your number before you do, renumber on rebase:
   a straight file rename is safe on an unmerged branch because nothing has
   recorded the filename in `_schema_migrations` yet. Never renumber a
   migration that has already run anywhere (it would re-apply under the new
   name).

Precedent: an unmerged branch claimed `0045` while main advanced through
`0050`; the file was renumbered to `0051` before merge
(`fix(db): renumber migration 0045 -> 0051`).
