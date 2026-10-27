import { expect, test } from "vite-plus/test";
import { ollama, OllamaModel } from "./mod.ts";

test("ollama factory returns OllamaModel instance", () => {
  const model = ollama();
  expect(model).toBeInstanceOf(OllamaModel);
});

test("ollama factory accepts apiKey", () => {
  const model = ollama({ apiKey: "test-key" });
  expect(model).toBeInstanceOf(OllamaModel);
});

test("ollama factory accepts host", () => {
  const model = ollama({ host: "http://localhost:11434" });
  expect(model).toBeInstanceOf(OllamaModel);
});

test("OllamaModel has expected methods", () => {
  const model = new OllamaModel();
  expect(typeof model.generate).toStrictEqual("function");
  expect(typeof model.stream).toStrictEqual("function");
});

test("OllamaModel trims apiKey whitespace", () => {
  // Should not throw and should trim the key
  const model = ollama({ apiKey: "  test-key-with-spaces  " });
  expect(model).toBeInstanceOf(OllamaModel);
});

test("OllamaModel warns on HTTP with API key for remote host", () => {
  const originalWarn = console.warn;
  let warnCalled = false;
  let warnMessage = "";

  console.warn = (...args: unknown[]) => {
    warnCalled = true;
    warnMessage = args.join(" ");
  };

  try {
    ollama({ host: "http://remote-server.com:11434", apiKey: "test-key" });
    expect(warnCalled).toStrictEqual(true);
    expect(
      warnMessage.includes("SECURITY WARNING"),
      "Expected security warning about unencrypted connection",
    ).toStrictEqual(true);
  } finally {
    console.warn = originalWarn;
  }
});

test("OllamaModel does not warn on HTTP with API key for localhost", () => {
  const originalWarn = console.warn;
  let warnCalled = false;

  console.warn = () => {
    warnCalled = true;
  };

  try {
    // Should not warn for localhost
    ollama({ host: "http://localhost:11434", apiKey: "test-key" });
    expect(warnCalled).toStrictEqual(false);

    // Should not warn for 127.0.0.1
    ollama({ host: "http://127.0.0.1:11434", apiKey: "test-key" });
    expect(warnCalled).toStrictEqual(false);
  } finally {
    console.warn = originalWarn;
  }
});

test("OllamaModel does not warn on HTTPS with API key", () => {
  const originalWarn = console.warn;
  let warnCalled = false;

  console.warn = () => {
    warnCalled = true;
  };

  try {
    ollama({ host: "https://api.ollama.com", apiKey: "test-key" });
    expect(warnCalled).toStrictEqual(false);
  } finally {
    console.warn = originalWarn;
  }
});
