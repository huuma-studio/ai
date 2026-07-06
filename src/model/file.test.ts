import { assertEquals, assertThrows } from "@std/assert";
import { dataUrlFrom, fileSourceFrom } from "@/model/file.ts";

Deno.test("fileSourceFrom resolves data-only files to a data source", () => {
  assertEquals(
    fileSourceFrom({ mimeType: "image/png", data: "aGVsbG8=" }),
    { kind: "data", data: "aGVsbG8=" },
  );
});

Deno.test("fileSourceFrom resolves url-only files to a url source", () => {
  assertEquals(
    fileSourceFrom({
      mimeType: "application/pdf",
      url: "https://example.com/a.pdf",
    }),
    { kind: "url", url: "https://example.com/a.pdf" },
  );
});

Deno.test("fileSourceFrom throws when both data and url are set", () => {
  assertThrows(
    () =>
      fileSourceFrom({
        mimeType: "image/png",
        data: "aGVsbG8=",
        url: "https://example.com/a.png",
      }),
    RangeError,
    "exactly one of data or url",
  );
});

Deno.test("fileSourceFrom throws when neither data nor url is set", () => {
  assertThrows(
    () => fileSourceFrom({ mimeType: "image/png" }),
    RangeError,
    "exactly one of data or url",
  );
});

Deno.test("fileSourceFrom treats empty-string data as unset", () => {
  assertEquals(
    fileSourceFrom({
      mimeType: "image/png",
      data: "",
      url: "https://example.com/a.png",
    }),
    { kind: "url", url: "https://example.com/a.png" },
  );
  assertThrows(
    () => fileSourceFrom({ mimeType: "image/png", data: "", url: "" }),
    RangeError,
    "exactly one of data or url",
  );
});

Deno.test("dataUrlFrom composes the exact data URL", () => {
  assertEquals(
    dataUrlFrom({ mimeType: "image/png", data: "aGVsbG8=" }),
    "data:image/png;base64,aGVsbG8=",
  );
});

Deno.test("dataUrlFrom throws on url-only input", () => {
  assertThrows(
    () =>
      dataUrlFrom({
        mimeType: "image/png",
        url: "https://example.com/a.png",
      }),
    RangeError,
    "no data",
  );
});
