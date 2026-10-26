import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { expect, test } from "vite-plus/test";
import { image } from "./image.ts";
import { ToolOutput } from "../mod.ts";

const encodeBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const decodeBase64 = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

/** A real 1x1 transparent PNG. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

// Minimal headers plus arbitrary payload — the tool sniffs magic bytes
// and never decodes pixel data, so the payloads need not be valid.
const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const GIF89a_BYTES = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0xff, 0x00,
]);
const GIF87a_BYTES = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00, 0x01, 0x00, 0xff, 0x00,
]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

test("image - reads a PNG file into a base64 file part", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = image();
  const filePath = join(tempDir, "pixel.png");

  try {
    await writeFile(filePath, PNG_BYTES);
    expect(tool.name).toBe("read_image");

    const result = await tool.call({ path: filePath });
    if (!(result instanceof ToolOutput)) {
      expect.fail("expected a ToolOutput");
    }
    expect(result.files.length).toStrictEqual(1);

    const [part] = result.files;
    expect(part.file).toStrictEqual({
      mimeType: "image/png",
      data: encodeBase64(PNG_BYTES),
    });
    expect(decodeBase64(part.file.data!)).toStrictEqual(PNG_BYTES);
    expect(result.output).toStrictEqual(
      `Image loaded: ${filePath} (image/png, ${PNG_BYTES.length} bytes).`,
    );
    expect(result.output.includes(part.file.data!)).toBe(false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("image - reads a JPEG file into a base64 file part", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = image();
  const filePath = join(tempDir, "photo.jpg");

  try {
    await writeFile(filePath, JPEG_BYTES);
    const result = await tool.call({ path: filePath });
    if (!(result instanceof ToolOutput)) {
      expect.fail("expected a ToolOutput");
    }

    const [part] = result.files;
    expect(part.file).toStrictEqual({
      mimeType: "image/jpeg",
      data: encodeBase64(JPEG_BYTES),
    });
    expect(decodeBase64(part.file.data!)).toStrictEqual(JPEG_BYTES);
    expect(result.output).toStrictEqual(
      `Image loaded: ${filePath} (image/jpeg, ${JPEG_BYTES.length} bytes).`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("image - reads a GIF89a file into a base64 file part", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = image();
  const filePath = join(tempDir, "animation.gif");

  try {
    await writeFile(filePath, GIF89a_BYTES);
    const result = await tool.call({ path: filePath });
    if (!(result instanceof ToolOutput)) {
      expect.fail("expected a ToolOutput");
    }

    const [part] = result.files;
    expect(part.file).toStrictEqual({
      mimeType: "image/gif",
      data: encodeBase64(GIF89a_BYTES),
    });
    expect(decodeBase64(part.file.data!)).toStrictEqual(GIF89a_BYTES);
    expect(result.output).toStrictEqual(
      `Image loaded: ${filePath} (image/gif, ${GIF89a_BYTES.length} bytes).`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("image - reads a GIF87a file into a base64 file part", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = image();
  const filePath = join(tempDir, "legacy.gif");

  try {
    await writeFile(filePath, GIF87a_BYTES);
    const result = await tool.call({ path: filePath });
    if (!(result instanceof ToolOutput)) {
      expect.fail("expected a ToolOutput");
    }

    const [part] = result.files;
    expect(part.file).toStrictEqual({
      mimeType: "image/gif",
      data: encodeBase64(GIF87a_BYTES),
    });
    expect(decodeBase64(part.file.data!)).toStrictEqual(GIF87a_BYTES);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("image - reads a WebP file into a base64 file part", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = image();
  const filePath = join(tempDir, "picture.webp");

  try {
    await writeFile(filePath, WEBP_BYTES);
    const result = await tool.call({ path: filePath });
    if (!(result instanceof ToolOutput)) {
      expect.fail("expected a ToolOutput");
    }

    const [part] = result.files;
    expect(part.file).toStrictEqual({
      mimeType: "image/webp",
      data: encodeBase64(WEBP_BYTES),
    });
    expect(decodeBase64(part.file.data!)).toStrictEqual(WEBP_BYTES);
    expect(result.output).toStrictEqual(
      `Image loaded: ${filePath} (image/webp, ${WEBP_BYTES.length} bytes).`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("image - sniffs a JPEG stored with a .png extension", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = image();
  const filePath = join(tempDir, "mislabeled.png");

  try {
    await writeFile(filePath, JPEG_BYTES);
    const result = await tool.call({ path: filePath });
    if (!(result instanceof ToolOutput)) {
      expect.fail("expected a ToolOutput");
    }

    const [part] = result.files;
    expect(part.file.mimeType).toStrictEqual("image/jpeg");
    expect(decodeBase64(part.file.data!)).toStrictEqual(JPEG_BYTES);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("image - honors custom maxBytes and allowedMimeTypes", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = image({ maxBytes: 1_000, allowedMimeTypes: ["image/gif"] });
  const filePath = join(tempDir, "animation.gif");

  try {
    await writeFile(filePath, GIF89a_BYTES);
    const result = await tool.call({ path: filePath });
    if (!(result instanceof ToolOutput)) {
      expect.fail("expected a ToolOutput");
    }

    const [part] = result.files;
    expect(part.file.mimeType).toStrictEqual("image/gif");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("image - requires a path input", async () => {
  const tool = image();
  await expect(tool.call({})).rejects.toThrow();
});

test("image - throws when the image is not found", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = image();
  const filePath = join(tempDir, "missing.png");

  try {
    await expect(tool.call({ path: filePath })).rejects.toThrow(`Image not found: ${filePath}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("image - throws when the path is a directory", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = image();
  const dirPath = join(tempDir, "some_dir");

  try {
    await mkdir(dirPath);
    await expect(tool.call({ path: dirPath })).rejects.toThrow(
      `Path is a directory, not a file: ${dirPath}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("image - throws on non-image content", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = image();
  const filePath = join(tempDir, "not-an-image.png");

  try {
    await writeFile(filePath, new TextEncoder().encode("definitely not an image"));
    await expect(tool.call({ path: filePath })).rejects.toThrow(
      `Unsupported image format: ${filePath}. Supported formats: image/png, image/jpeg, image/gif, image/webp.`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("image - throws on files over the default 5 MB limit", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = image();
  const filePath = join(tempDir, "huge.png");
  const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
  bytes.set(PNG_BYTES, 0);

  try {
    await writeFile(filePath, bytes);
    await expect(tool.call({ path: filePath })).rejects.toThrow(
      `Image too large: ${filePath} is ${bytes.length} bytes, which exceeds the ${
        5 * 1024 * 1024
      } byte limit.`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("image - throws on files over a custom maxBytes", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = image({ maxBytes: 10 });
  const filePath = join(tempDir, "too-big.gif");

  try {
    await writeFile(filePath, GIF89a_BYTES);
    await expect(tool.call({ path: filePath })).rejects.toThrow(
      `Image too large: ${filePath} is ${GIF89a_BYTES.length} bytes, which exceeds the 10 byte limit.`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("image - throws on sniffed types outside allowedMimeTypes", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = image({ allowedMimeTypes: ["image/png"] });
  const filePath = join(tempDir, "photo.jpg");

  try {
    await writeFile(filePath, JPEG_BYTES);
    await expect(tool.call({ path: filePath })).rejects.toThrow(
      `Image type not allowed: ${filePath} is image/jpeg. Allowed types: image/png.`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("image - rejects invalid maxBytes configuration", () => {
  for (const maxBytes of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
    expect(() => image({ maxBytes })).toThrow(TypeError);
    expect(() => image({ maxBytes })).toThrow("Image maxBytes must be a finite, positive number");
  }
});

test("image - reads an image through a symlink to a regular file", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = image();
  const targetPath = join(tempDir, "pixel.png");
  const linkPath = join(tempDir, "link.png");

  try {
    await writeFile(targetPath, PNG_BYTES);
    await symlink(targetPath, linkPath);
    const result = await tool.call({ path: linkPath });
    if (!(result instanceof ToolOutput)) {
      expect.fail("expected a ToolOutput");
    }

    const [part] = result.files;
    expect(part.file).toStrictEqual({
      mimeType: "image/png",
      data: encodeBase64(PNG_BYTES),
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// mkfifo is a Unix utility.
test.skipIf(process.platform === "win32")("image - throws when the path is a FIFO", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = image();
  const fifoPath = join(tempDir, "named-pipe.png");

  try {
    // Throws on a non-zero exit, which fails the test.
    execFileSync("mkfifo", [fifoPath]);

    await expect(tool.call({ path: fifoPath })).rejects.toThrow(
      `Path is not a regular file: ${fifoPath}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
