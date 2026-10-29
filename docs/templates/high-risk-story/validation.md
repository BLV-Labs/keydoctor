# High-Risk Story: [Title] — Validation Plan

## Contract

(What behavior must be true when this story is done?)

## Proof Levels

### Unit Tests

- **Test file**: (path)
- **Key assertions**:
  1. (what specific behavior is verified)
  2. (edge case coverage)
  3. (error case coverage)

### Integration Tests

- **Boundary**: (what components are being tested together)
- **Key scenarios**:
  1. (happy path)
  2. (error path)
  3. (edge case)

### E2E Tests

- **User flow**: (what end-to-end path is verified)
- **Steps**:
  1. (step 1)
  2. (step 2)
  3. (expected outcome)

### Platform Checks

- [ ] Migration applies cleanly on a fresh DB (skip when no schema change)
- [ ] Migration applies cleanly on existing data (skip when no schema change)
- [ ] Rollback migration works (skip when no schema change)
- [ ] Build artifact (e.g. container image) succeeds, if the repo ships one
- [ ] Deploy to a non-production environment succeeds, if one exists
- [ ] Smoke test passes

## Security Validation

- [ ] Input validation covers all external inputs
- [ ] Auth checks on all new routes/endpoints
- [ ] No secrets in logs
- [ ] No SQL injection vectors
- [ ] Rate limiting on public endpoints (if applicable)

## Evidence Template

```
[YYYY-MM-DD] <command>: <result>
```

(Filled in after each proof level is run.)

## Sign-Off

- [ ] All proof levels pass
- [ ] No critical findings unresolved
- [ ] TEST_MATRIX rows updated
- [ ] Security review complete (if high-risk)
- [ ] Lead dev approved
