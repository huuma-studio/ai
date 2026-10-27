import { expect, test } from "vite-plus/test";
import { modelToolName, validateServerName } from "./naming.ts";

const VALID = /^[a-zA-Z0-9_-]{1,64}$/;

test("validateServerName - accepts provider-safe names", () => {
  validateServerName("github");
  validateServerName("my-srv_2");
});

test("validateServerName - rejects unsafe names", () => {
  expect(() => validateServerName("my server")).toThrow(RangeError);
  expect(() => validateServerName("srv.1")).toThrow(RangeError);
});

test("modelToolName - plain prefix", () => {
  expect(modelToolName("github", "create_issue")).toBe("github_create_issue");
});

test("modelToolName - sanitizes characters providers reject", () => {
  expect(modelToolName("srv", "repo.search")).toBe("srv_repo_search");
});

test("modelToolName - caps over-long names at exactly 64", () => {
  const name = modelToolName("server", "a".repeat(80));
  expect(name.length).toBe(64);
  expect(name).toMatch(VALID);
});

test("modelToolName - long names sharing a prefix stay distinct", () => {
  const shared = "a".repeat(70);
  const one = modelToolName("server", `${shared}_one`);
  const two = modelToolName("server", `${shared}_two`);
  expect(one).not.toStrictEqual(two);
  expect(one.slice(0, 60)).toBe(two.slice(0, 60));
});

test("modelToolName - deterministic across calls", () => {
  const tool = "b".repeat(90);
  expect(modelToolName("server", tool)).toBe(modelToolName("server", tool));
});
