# Kale Release Control Plane

Kale Deploy owns immutable revisions, release history, approvals, and the
stateful publication workflow. Its local Workerd/D1/R2/provider harness is the
release contract; it never stands in for a live publication.

## Release

Merge only after the repository checks pass. Deploy is a direct production
cutover for this stateful control plane: the local Workerd/D1/R2/Workflow gate
proves the release before it reaches production. A successful release leaves
the public readiness check healthy while anonymous project creation remains
rejected.
