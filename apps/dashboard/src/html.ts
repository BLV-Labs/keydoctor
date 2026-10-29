// Every value from chain data or the URL passes through `escape`. Only `Html` built by `html` is trusted.

export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

type Part = Html | string | number | null | undefined | false | readonly Part[];

export function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function part(p: Part): string {
  if (p === null || p === undefined || p === false) return "";
  if (p instanceof Html) return p.value;
  if (Array.isArray(p)) return p.map(part).join("");
  return escape(String(p));
}

export function html(strings: TemplateStringsArray, ...values: Part[]): Html {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += part(v) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}
