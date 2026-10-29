# High-Risk Story: [Title] — Design

## Architecture

(How does this fit into the existing system? Diagrams welcome.)

## Data Model

### Schema Changes

```sql
-- New tables, columns, indexes
```

### Migration Strategy

(Forward migration, backward compatibility, data backfill plan.)

### Rollback Plan

(How to undo if something goes wrong.)

## API Contract

### New / Modified Routes

```
METHOD /path
Request: { ... }
Response: { ... }
```

### Breaking Changes

(List any breaking changes and their mitigation.)

## Domain Rules

(Business logic constraints that the implementation must enforce.)

## Security Considerations

- **Auth**: (who can access this?)
- **Input validation**: (what gets validated, where?)
- **Data sensitivity**: (PII, secrets, financial data?)
- **Attack surface**: (what could go wrong?)

## R.E.S.T Targets

| Pillar | Target |
|---|---|
| Reliability | (specific requirement) |
| Efficiency | (specific requirement) |
| Security | (specific requirement) |
| Traceability | (specific requirement) |
