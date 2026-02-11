import { assertEquals, assertRejects } from "@std/assert";
import { fetchWebsite } from "./browser.ts";

Deno.test("fetchWebsite - fetches content", async () => {
  const controller = new AbortController();
  const port = 8481;
  const server = Deno.serve({ port, signal: controller.signal }, (_req) => {
    return new Response("Hello from test server");
  });

  try {
    const tool = fetchWebsite();
    const result = await tool.call({ url: `http://localhost:${port}` });
    assertEquals(result, "Hello from test server");
  } finally {
    controller.abort();
    await server.finished;
  }
});

Deno.test("fetchWebsite - handles 404", async () => {
  const controller = new AbortController();
  const port = 8482;
  const server = Deno.serve({ port, signal: controller.signal }, (_req) => {
    return new Response("Not Found", { status: 404 });
  });

  try {
    const tool = fetchWebsite();
    await assertRejects(
      async () => await tool.call({ url: `http://localhost:${port}` }),
      Error
    );
  } finally {
    controller.abort();
    await server.finished;
  }
});
