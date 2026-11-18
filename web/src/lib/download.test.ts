import { describe, expect, it } from "vitest";
import { filenameFromDisposition, parseWarningsHeader } from "./download";

describe("filenameFromDisposition", () => {
  it("prefers the RFC 5987 form", () => {
    expect(filenameFromDisposition(`attachment; filename*=utf-8''Disserta%C3%A7%C3%A3o.md`, "x")).toBe("Dissertação.md");
  });
  it("reads plain and quoted names", () => {
    expect(filenameFromDisposition(`attachment; filename=sample.md`, "x")).toBe("sample.md");
    expect(filenameFromDisposition(`attachment; filename="a b-markdown.zip"`, "x")).toBe("a b-markdown.zip");
    expect(filenameFromDisposition(null, "fallback.md")).toBe("fallback.md");
  });
});

describe("parseWarningsHeader", () => {
  it("decodes Go's url.QueryEscape of a JSON array", () => {
    // url.QueryEscape(`["imagem \"x\": não encontrada"]`)
    expect(parseWarningsHeader("%5B%22imagem+%5C%22x%5C%22%3A+n%C3%A3o+encontrada%22%5D")).toEqual(['imagem "x": não encontrada']);
    expect(parseWarningsHeader("null")).toEqual([]);
    expect(parseWarningsHeader("%ZZ")).toEqual([]);
  });
});
