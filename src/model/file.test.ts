import { expect, test } from "vite-plus/test";
import { dataUrlFrom, fileSourceFrom } from "./file.ts";

test("fileSourceFrom resolves data-only files to a data source", () => {
  expect(fileSourceFrom({ mimeType: "image/png", data: "aGVsbG8=" })).toStrictEqual({
    kind: "data",
    data: "aGVsbG8=",
  });
});

test("fileSourceFrom resolves url-only files to a url source", () => {
  expect(
    fileSourceFrom({
      mimeType: "application/pdf",
      url: "https://example.com/a.pdf",
    }),
  ).toStrictEqual({ kind: "url", url: "https://example.com/a.pdf" });
});

test("fileSourceFrom throws when both data and url are set", () => {
  expect(() =>
    fileSourceFrom({
      mimeType: "image/png",
      data: "aGVsbG8=",
      url: "https://example.com/a.png",
    }),
  ).toThrow(RangeError);
  expect(() =>
    fileSourceFrom({
      mimeType: "image/png",
      data: "aGVsbG8=",
      url: "https://example.com/a.png",
    }),
  ).toThrow("exactly one of data or url");
});

test("fileSourceFrom throws when neither data nor url is set", () => {
  expect(() => fileSourceFrom({ mimeType: "image/png" })).toThrow(RangeError);
  expect(() => fileSourceFrom({ mimeType: "image/png" })).toThrow("exactly one of data or url");
});

test("fileSourceFrom treats empty-string data as unset", () => {
  expect(
    fileSourceFrom({
      mimeType: "image/png",
      data: "",
      url: "https://example.com/a.png",
    }),
  ).toStrictEqual({ kind: "url", url: "https://example.com/a.png" });
  expect(() => fileSourceFrom({ mimeType: "image/png", data: "", url: "" })).toThrow(RangeError);
  expect(() => fileSourceFrom({ mimeType: "image/png", data: "", url: "" })).toThrow(
    "exactly one of data or url",
  );
});

test("dataUrlFrom composes the exact data URL", () => {
  expect(dataUrlFrom({ mimeType: "image/png", data: "aGVsbG8=" })).toStrictEqual(
    "data:image/png;base64,aGVsbG8=",
  );
});

test("dataUrlFrom throws on url-only input", () => {
  expect(() =>
    dataUrlFrom({
      mimeType: "image/png",
      url: "https://example.com/a.png",
    }),
  ).toThrow(RangeError);
  expect(() =>
    dataUrlFrom({
      mimeType: "image/png",
      url: "https://example.com/a.png",
    }),
  ).toThrow("no data");
});
