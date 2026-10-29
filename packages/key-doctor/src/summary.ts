import type { KdReport, KdReportSummary } from "./types.ts";

/** kd.report_summary.v1 (§4.2): the report without each member's key list. Pure; never mutates `report`. */
export function toSummary(report: KdReport): KdReportSummary {
  const { schema_version: _schema, members, ...rest } = report;
  return {
    ...structuredClone(rest),
    schema_version: "kd.report_summary.v1",
    members: members.map(({ keys: _keys, ...m }) => structuredClone(m)),
  };
}
