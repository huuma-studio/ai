import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import { modelToolName, validateServerName } from "@/tools/mcp/naming.ts";

const VALID = /^[a-zA-Z0-9_-]{1,64}$/;

Deno.test("validateServerName - accepts provider-safe names", () => {
  validateServerName("github");
  validateServerName("my-srv_2");
});

Deno.test("validateServerName - rejects unsafe names", () => {
  assertThrows(() => validateServerName("my server"), RangeError);
  assertThrows(() => validateServerName("srv.1"), RangeError);
});

Deno.test("modelToolName - plain prefix", () => {
  assertEquals(modelToolName("github", "create_issue"), "github_create_issue");
});

Deno.test("modelToolName - sanitizes characters providers reject", () => {
  assertEquals(modelToolName("srv", "repo.search"), "srv_repo_search");
});

Deno.test("modelToolName - caps over-long names at exactly 64", () => {
  const name = modelToolName("server", "a".repeat(80));
  assertEquals(name.length, 64);
  assertMatch(name, VALID);
});

Deno.test("modelToolName - long names sharing a prefix stay distinct", () => {
  const shared = "a".repeat(70);
  const one = modelToolName("server", `${shared}_one`);
  const two = modelToolName("server", `${shared}_two`);
  assertNotEquals(one, two);
  assertEquals(one.slice(0, 60), two.slice(0, 60));
});

Deno.test("modelToolName - deterministic across calls", () => {
  const tool = "b".repeat(90);
  assertEquals(modelToolName("server", tool), modelToolName("server", tool));
});
