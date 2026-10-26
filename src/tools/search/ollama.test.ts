import { afterEach, expect, test, vi } from "vite-plus/test";
import { OllamaSearchProvider } from "./ollama.ts";

// Helper: create a mock fetch that records the request and returns a canned response
function mockFetch(response: Response): { fetchStub: typeof globalThis.fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fetchStub = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    calls.push(req);
    return Promise.resolve(response);
  };
  return { fetchStub, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

test("OllamaSearchProvider - maps url to link and content to snippet", async () => {
  const sampleResponse = new Response(
    JSON.stringify({
      results: [
        {
          title: "Ollama",
          url: "https://ollama.com/",
          content: "Cloud models are now available...",
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  const { fetchStub } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  try {
    const provider = new OllamaSearchProvider("test-key");
    const result = await provider.search("ollama");

    expect(result.results.length).toStrictEqual(1);
    expect(result.results[0].title).toStrictEqual("Ollama");
    expect(result.results[0].link).toStrictEqual("https://ollama.com/");
    expect(result.results[0].snippet).toStrictEqual("Cloud models are now available...");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OllamaSearchProvider - sends max_results when count is provided", async () => {
  const sampleResponse = new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const { fetchStub, calls } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  try {
    const provider = new OllamaSearchProvider("test-key");
    await provider.search("test query", { count: 7 });

    const body = JSON.parse(await calls[0].text());
    expect(body.max_results).toStrictEqual(7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OllamaSearchProvider - omits max_results when count is not provided", async () => {
  const sampleResponse = new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const { fetchStub, calls } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  try {
    const provider = new OllamaSearchProvider("test-key");
    await provider.search("test query");

    const body = JSON.parse(await calls[0].text());
    expect(body.max_results).toStrictEqual(undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OllamaSearchProvider - constructor arg takes priority over env vars", async () => {
  const sampleResponse = new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const { fetchStub, calls } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  vi.stubEnv("OLLAMA_SEARCH_API_KEY", "env-search-key");
  vi.stubEnv("OLLAMA_API_KEY", "env-model-key");

  try {
    const provider = new OllamaSearchProvider("constructor-key");
    await provider.search("test");

    expect(calls[0].headers.get("Authorization")).toStrictEqual("Bearer constructor-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OllamaSearchProvider - falls back to OLLAMA_SEARCH_API_KEY env var", async () => {
  const sampleResponse = new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const { fetchStub, calls } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  vi.stubEnv("OLLAMA_SEARCH_API_KEY", "env-search-key");
  vi.stubEnv("OLLAMA_API_KEY", "env-model-key");

  try {
    const provider = new OllamaSearchProvider();
    await provider.search("test");

    expect(calls[0].headers.get("Authorization")).toStrictEqual("Bearer env-search-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OllamaSearchProvider - falls back to OLLAMA_API_KEY env var", async () => {
  const sampleResponse = new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const { fetchStub, calls } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  vi.stubEnv("OLLAMA_SEARCH_API_KEY", undefined);
  vi.stubEnv("OLLAMA_API_KEY", "env-model-key");

  try {
    const provider = new OllamaSearchProvider();
    await provider.search("test");

    expect(calls[0].headers.get("Authorization")).toStrictEqual("Bearer env-model-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OllamaSearchProvider - throws when no API key is set", async () => {
  const sampleResponse = new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const { fetchStub } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  vi.stubEnv("OLLAMA_SEARCH_API_KEY", undefined);
  vi.stubEnv("OLLAMA_API_KEY", undefined);

  try {
    const provider = new OllamaSearchProvider();
    const error = await provider.search("test").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Ollama API Key is required");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OllamaSearchProvider - throws on non-OK response", async () => {
  const errorResponse = new Response("Unauthorized", { status: 401 });

  const { fetchStub } = mockFetch(errorResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  try {
    const provider = new OllamaSearchProvider("test-key");
    const error = await provider.search("test").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Ollama Search failed: 401");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OllamaSearchProvider - sends Authorization with Bearer scheme", async () => {
  const sampleResponse = new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const { fetchStub, calls } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  try {
    const provider = new OllamaSearchProvider("my-secret-key");
    await provider.search("test");

    expect(calls[0].headers.get("Authorization")).toStrictEqual("Bearer my-secret-key");
    expect(calls[0].headers.get("Content-Type")).toStrictEqual("application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OllamaSearchProvider - POSTs to the correct endpoint", async () => {
  const sampleResponse = new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  const { fetchStub, calls } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  try {
    const provider = new OllamaSearchProvider("test-key");
    await provider.search("test query");

    expect(calls[0].method).toStrictEqual("POST");
    expect(calls[0].url).toStrictEqual("https://ollama.com/api/web_search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
