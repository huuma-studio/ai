import { assertEquals, assertInstanceOf } from "@std/assert";
import { ollama, OllamaModel } from "./mod.ts";

Deno.test("ollama factory returns OllamaModel instance", () => {
  const model = ollama();
  assertInstanceOf(model, OllamaModel);
});

Deno.test("ollama factory accepts apiKey", () => {
  const model = ollama({ apiKey: "test-key" });
  assertInstanceOf(model, OllamaModel);
});

Deno.test("ollama factory accepts host", () => {
  const model = ollama({ host: "http://localhost:11434" });
  assertInstanceOf(model, OllamaModel);
});

Deno.test("OllamaModel has expected methods", () => {
  const model = new OllamaModel();
  assertEquals(typeof model.generate, "function");
  assertEquals(typeof model.stream, "function");
});

Deno.test("OllamaModel trims apiKey whitespace", () => {
  // Should not throw and should trim the key
  const model = ollama({ apiKey: "  test-key-with-spaces  " });
  assertInstanceOf(model, OllamaModel);
});

Deno.test("OllamaModel warns on HTTP with API key for remote host", () => {
  const originalWarn = console.warn;
  let warnCalled = false;
  let warnMessage = "";

  console.warn = (...args: unknown[]) => {
    warnCalled = true;
    warnMessage = args.join(" ");
  };

  try {
    ollama({ host: "http://remote-server.com:11434", apiKey: "test-key" });
    assertEquals(warnCalled, true);
    assertEquals(
      warnMessage.includes("SECURITY WARNING"),
      true,
      "Expected security warning about unencrypted connection",
    );
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("OllamaModel does not warn on HTTP with API key for localhost", () => {
  const originalWarn = console.warn;
  let warnCalled = false;

  console.warn = () => {
    warnCalled = true;
  };

  try {
    // Should not warn for localhost
    ollama({ host: "http://localhost:11434", apiKey: "test-key" });
    assertEquals(warnCalled, false);

    // Should not warn for 127.0.0.1
    ollama({ host: "http://127.0.0.1:11434", apiKey: "test-key" });
    assertEquals(warnCalled, false);
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("OllamaModel does not warn on HTTPS with API key", () => {
  const originalWarn = console.warn;
  let warnCalled = false;

  console.warn = () => {
    warnCalled = true;
  };

  try {
    ollama({ host: "https://api.ollama.com", apiKey: "test-key" });
    assertEquals(warnCalled, false);
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("OllamaModel reads API key from environment variable", () => {
  const originalEnv = Deno.env.get("OLLAMA_API_KEY");

  try {
    Deno.env.set("OLLAMA_API_KEY", "env-api-key");
    const model = ollama({ host: "http://localhost:11434" });
    assertInstanceOf(model, OllamaModel);
    // The model should be created successfully with the env key
  } finally {
    if (originalEnv) {
      Deno.env.set("OLLAMA_API_KEY", originalEnv);
    } else {
      Deno.env.delete("OLLAMA_API_KEY");
    }
  }
});

Deno.test("OllamaModel explicit apiKey takes precedence over env variable", () => {
  const originalEnv = Deno.env.get("OLLAMA_API_KEY");

  try {
    Deno.env.set("OLLAMA_API_KEY", "env-api-key");
    // Explicit apiKey should be used even if env var exists
    const model = ollama({
      host: "http://localhost:11434",
      apiKey: "explicit-api-key",
    });
    assertInstanceOf(model, OllamaModel);
  } finally {
    if (originalEnv) {
      Deno.env.set("OLLAMA_API_KEY", originalEnv);
    } else {
      Deno.env.delete("OLLAMA_API_KEY");
    }
  }
});
