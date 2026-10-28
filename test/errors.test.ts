import { describe, expect, it } from "vitest";
import { errors, redactUrl } from "../src/errors.js";

describe("redactUrl", () => {
  it("remove user:pass@", () => {
    expect(redactUrl("https://user:pass@exemplo.com/p")).toBe("https://exemplo.com/p");
    expect(redactUrl("http://user@exemplo.com:8080/")).toBe("http://exemplo.com:8080/");
    expect(redactUrl("https://u:p@ss@exemplo.com/p")).toBe("https://exemplo.com/p");
  });

  it("mascara valores de chaves sensíveis, sem diferenciar maiúsculas", () => {
    const keys = [
      "token", "key", "apikey", "api_key", "access_token", "auth", "password",
      "pwd", "secret", "sig", "signature", "session", "sid", "code",
    ];
    for (const k of keys) {
      expect(redactUrl(`https://e.com/p?a=1&${k}=SEGREDO&b=2`)).toBe(`https://e.com/p?a=1&${k}=***&b=2`);
    }
    expect(redactUrl("https://e.com/p?Token=abc&API_KEY=def")).toBe("https://e.com/p?Token=***&API_KEY=***");
  });

  it("preserva parâmetros comuns e mascara no fragmento", () => {
    expect(redactUrl("https://e.com/p?q=ola&page=2")).toBe("https://e.com/p?q=ola&page=2");
    expect(redactUrl("https://e.com/cb#access_token=xyz&state=1")).toBe("https://e.com/cb#access_token=***&state=1");
  });

  it("funciona com texto que não é URL válida", () => {
    expect(redactUrl("ht!tp://u:p@x/?token=abc")).toBe("ht!tp://u:p@x/?token=abc".replace("u:p@", "").replace("abc", "***"));
  });
});

describe("mensagens de erro não vazam credenciais", () => {
  const url = "https://user:S3gr3d0@exemplo.com/p?token=ABC123&q=1";
  const messages = [
    errors.invalidUrl(url).message,
    errors.http(500, url).message,
    errors.timeout(url, 30_000).message,
    errors.network(url, "ECONNRESET").message,
    errors.proxyConnect("proxy:8080", url, "x").message,
    errors.proxyAuth("proxy:8080", url).message,
    errors.proxyRefused("proxy:8080", url, 403).message,
    errors.unsupportedContentType("image/png", url).message,
    errors.jsRequired(url).message,
  ];

  it.each(messages.map((m, i) => [i, m] as const))("mensagem %i", (_i, m) => {
    expect(m).not.toContain("S3gr3d0");
    expect(m).not.toContain("user:");
    expect(m).not.toContain("ABC123");
    expect(m).toContain("exemplo.com/p?token=***&q=1");
  });
});
