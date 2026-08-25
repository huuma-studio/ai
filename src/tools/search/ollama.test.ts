import { assertEquals, assertRejects } from "@std/assert";
import { OllamaSearchProvider } from "./ollama.ts";

// Helper: create a mock fetch that records the request and returns a canned response
function mockFetch(
  response: Response,
): { fetchStub: typeof globalThis.fetch; calls: Request[] } {
  const calls: Request[] = [];
  const fetchStub = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = new Request(input, init);
    calls.push(req);
    return Promise.resolve(response);
  };
  return { fetchStub, calls };
}

Deno.test("OllamaSearchProvider - maps url to link and content to snippet", async () => {
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

    assertEquals(result.results.length, 1);
    assertEquals(result.results[0].title, "Ollama");
    assertEquals(result.results[0].link, "https://ollama.com/");
    assertEquals(result.results[0].snippet, "Cloud models are now available...");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OllamaSearchProvider - sends max_results when count is provided", async () => {
  const sampleResponse = new Response(
    JSON.stringify({ results: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  const { fetchStub, calls } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  try {
    const provider = new OllamaSearchProvider("test-key");
    await provider.search("test query", { count: 7 });

    const body = JSON.parse(await calls[0].text());
    assertEquals(body.max_results, 7);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OllamaSearchProvider - omits max_results when count is not provided", async () => {
  const sampleResponse = new Response(
    JSON.stringify({ results: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  const { fetchStub, calls } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  try {
    const provider = new OllamaSearchProvider("test-key");
    await provider.search("test query");

    const body = JSON.parse(await calls[0].text());
    assertEquals(body.max_results, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OllamaSearchProvider - constructor arg takes priority over env vars", async () => {
  const sampleResponse = new Response(
    JSON.stringify({ results: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  const { fetchStub, calls } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  const originalSearchKey = Deno.env.get("OLLAMA_SEARCH_API_KEY");
  const originalModelKey = Deno.env.get("OLLAMA_API_KEY");
  Deno.env.set("OLLAMA_SEARCH_API_KEY", "env-search-key");
  Deno.env.set("OLLAMA_API_KEY", "env-model-key");

  try {
    const provider = new OllamaSearchProvider("constructor-key");
    await provider.search("test");

    assertEquals(
      calls[0].headers.get("Authorization"),
      "Bearer constructor-key",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSearchKey === undefined) {
      Deno.env.delete("OLLAMA_SEARCH_API_KEY");
    } else {
      Deno.env.set("OLLAMA_SEARCH_API_KEY", originalSearchKey);
    }
    if (originalModelKey === undefined) {
      Deno.env.delete("OLLAMA_API_KEY");
    } else {
      Deno.env.set("OLLAMA_API_KEY", originalModelKey);
    }
  }
});

Deno.test("OllamaSearchProvider - falls back to OLLAMA_SEARCH_API_KEY env var", async () => {
  const sampleResponse = new Response(
    JSON.stringify({ results: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  const { fetchStub, calls } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  const originalSearchKey = Deno.env.get("OLLAMA_SEARCH_API_KEY");
  const originalModelKey = Deno.env.get("OLLAMA_API_KEY");
  Deno.env.set("OLLAMA_SEARCH_API_KEY", "env-search-key");
  Deno.env.set("OLLAMA_API_KEY", "env-model-key");

  try {
    const provider = new OllamaSearchProvider();
    await provider.search("test");

    assertEquals(
      calls[0].headers.get("Authorization"),
      "Bearer env-search-key",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSearchKey === undefined) {
      Deno.env.delete("OLLAMA_SEARCH_API_KEY");
    } else {
      Deno.env.set("OLLAMA_SEARCH_API_KEY", originalSearchKey);
    }
    if (originalModelKey === undefined) {
      Deno.env.delete("OLLAMA_API_KEY");
    } else {
      Deno.env.set("OLLAMA_API_KEY", originalModelKey);
    }
  }
});

Deno.test("OllamaSearchProvider - falls back to OLLAMA_API_KEY env var", async () => {
  const sampleResponse = new Response(
    JSON.stringify({ results: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  const { fetchStub, calls } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  const originalSearchKey = Deno.env.get("OLLAMA_SEARCH_API_KEY");
  const originalModelKey = Deno.env.get("OLLAMA_API_KEY");
  Deno.env.delete("OLLAMA_SEARCH_API_KEY");
  Deno.env.set("OLLAMA_API_KEY", "env-model-key");

  try {
    const provider = new OllamaSearchProvider();
    await provider.search("test");

    assertEquals(
      calls[0].headers.get("Authorization"),
      "Bearer env-model-key",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSearchKey === undefined) {
      Deno.env.delete("OLLAMA_SEARCH_API_KEY");
    } else {
      Deno.env.set("OLLAMA_SEARCH_API_KEY", originalSearchKey);
    }
    if (originalModelKey === undefined) {
      Deno.env.delete("OLLAMA_API_KEY");
    } else {
      Deno.env.set("OLLAMA_API_KEY", originalModelKey);
    }
  }
});

Deno.test("OllamaSearchProvider - throws when no API key is set", async () => {
  const sampleResponse = new Response(
    JSON.stringify({ results: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  const { fetchStub } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  const originalSearchKey = Deno.env.get("OLLAMA_SEARCH_API_KEY");
  const originalModelKey = Deno.env.get("OLLAMA_API_KEY");
  Deno.env.delete("OLLAMA_SEARCH_API_KEY");
  Deno.env.delete("OLLAMA_API_KEY");

  try {
    const provider = new OllamaSearchProvider();
    await assertRejects(
      () => provider.search("test"),
      Error,
      "Ollama API Key is required",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSearchKey !== undefined) {
      Deno.env.set("OLLAMA_SEARCH_API_KEY", originalSearchKey);
    }
    if (originalModelKey !== undefined) {
      Deno.env.set("OLLAMA_API_KEY", originalModelKey);
    }
  }
});

Deno.test("OllamaSearchProvider - throws on non-OK response", async () => {
  const errorResponse = new Response("Unauthorized", { status: 401 });

  const { fetchStub } = mockFetch(errorResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  try {
    const provider = new OllamaSearchProvider("test-key");
    await assertRejects(
      () => provider.search("test"),
      Error,
      "Ollama Search failed: 401",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OllamaSearchProvider - sends Authorization with Bearer scheme", async () => {
  const sampleResponse = new Response(
    JSON.stringify({ results: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  const { fetchStub, calls } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  try {
    const provider = new OllamaSearchProvider("my-secret-key");
    await provider.search("test");

    assertEquals(
      calls[0].headers.get("Authorization"),
      "Bearer my-secret-key",
    );
    assertEquals(
      calls[0].headers.get("Content-Type"),
      "application/json",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OllamaSearchProvider - POSTs to the correct endpoint", async () => {
  const sampleResponse = new Response(
    JSON.stringify({ results: [] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  const { fetchStub, calls } = mockFetch(sampleResponse);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  try {
    const provider = new OllamaSearchProvider("test-key");
    await provider.search("test query");

    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].url, "https://ollama.com/api/web_search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});