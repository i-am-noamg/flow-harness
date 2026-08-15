import type { FlowCatalogEntry } from "./types.js";

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function renderFlow(flow: FlowCatalogEntry): string {
  const inputs = flow.inputs.map((input) => `${input.name}:${input.type}${input.default !== undefined ? `=${JSON.stringify(input.default)}` : ""}${input.description ? ` — ${compact(input.description)}` : ""}`).join(", ");
  const description = flow.description ? `: ${compact(flow.description)}` : "";
  const reference = flow.temporary ? `.flow/tmp/${flow.name}.flow` : flow.name;
  return `- ${reference}${description}${inputs ? ` (inputs: ${inputs})` : ""}${flow.outputs.length ? ` (outputs: ${flow.outputs.join(", ")})` : ""}`;
}

export function formatFlowCatalog(catalog: FlowCatalogEntry[]): string {
  const permanent = catalog.filter((flow) => !flow.temporary).map(renderFlow);
  const temporary = catalog.filter((flow) => flow.temporary).map(renderFlow);
  if (!permanent.length && !temporary.length) return "(none)";
  return [
    permanent.length ? `Available workflows:\n${permanent.join("\n")}` : "",
    temporary.length ? `Temporary workflows:\n${temporary.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}
