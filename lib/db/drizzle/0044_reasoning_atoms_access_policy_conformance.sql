-- Architecture-homes Track A: align reasoning_atoms.access_policy with ADR-017
-- five-value union (tenant-scoped was pre-conformance legacy).

UPDATE reasoning_atoms
SET access_policy = 'tenant-private'
WHERE access_policy = 'tenant-scoped';

ALTER TABLE reasoning_atoms
  DROP CONSTRAINT IF EXISTS reasoning_atoms_access_policy_check;

ALTER TABLE reasoning_atoms
  ADD CONSTRAINT reasoning_atoms_access_policy_check
  CHECK (
    access_policy IN (
      'public-free',
      'public-paid',
      'platform-internal',
      'tenant-private',
      'tenant-shared'
    )
  );
