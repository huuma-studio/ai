import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { join } from "@std/path";
import { image } from "@/tools/image/image.ts";
import { ToolOutput } from "@/tools/mod.ts";

/** A real 1x1 transparent PNG. */
const PNG_BYTES = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x1f,
  0x15,
  0xc4,
  0x89,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x44,
  0x41,
  0x54,
  0x78,
  0x9c,
  0x62,
  0x00,
  0x01,
  0x00,
  0x00,
  0x05,
  0x00,
  0x01,
  0x0d,
  0x0a,
  0x2d,
  0xb4,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
]);

// Minimal headers plus arbitrary payload — the tool sniffs magic bytes
// and never decodes pixel data, so the payloads need not be valid.
const JPEG_BYTES = new Uint8Array([
  0xff,
  0xd8,
  0xff,
  0xe0,
  0x00,
  0x10,
  0x4a,
  0x46,
  0x49,
  0x46,
  0x00,
  0x01,
]);
const GIF89a_BYTES = new Uint8Array([
  0x47,
  0x49,
  0x46,
  0x38,
  0x39,
  0x61,
  0x01,
  0x00,
  0x01,
  0x00,
  0xff,
  0x00,
]);
const GIF87a_BYTES = new Uint8Array([
  0x47,
  0x49,
  0x46,
  0x38,
  0x37,
  0x61,
  0x01,
  0x00,
  0x01,
  0x00,
  0xff,
  0x00,
]);
const WEBP_BYTES = new Uint8Array([
  0x52,
  0x49,
  0x46,
  0x46,
  0x24,
  0x00,
  0x00,
  0x00,
  0x57,
  0x45,
  0x42,
  0x50,
  0x56,
  0x50,
  0x38,
  0x20,
]);

Deno.test("image - reads a PNG file into a base64 file part", async () => {
  const tempDir = await Deno.makeTempDir();
  const tool = image();
  const filePath = join(tempDir, "pixel.png");

  try {
    await Deno.writeFile(filePath, PNG_BYTES);
    assertEquals(tool.name, "read_image");

    const result = await tool.call({ path: filePath });
    assertInstanceOf(result, ToolOutput);
    assertEquals(result.files.length, 1);

    const [part] = result.files;
    assertEquals(part.file, {
      mimeType: "image/png",
      data: encodeBase64(PNG_BYTES),
    });
    assertEquals(decodeBase64(part.file.data!), PNG_BYTES);
    assertEquals(
      result.output,
      `Image loaded: ${filePath} (image/png, ${PNG_BYTES.length} bytes).`,
    );
    assertEquals(result.output.includes(part.file.data!), false);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("image - reads a JPEG file into a base64 file part", async () => {
  const tempDir = await Deno.makeTempDir();
  const tool = image();
  const filePath = join(tempDir, "photo.jpg");

  try {
    await Deno.writeFile(filePath, JPEG_BYTES);
    const result = await tool.call({ path: filePath });
    assertInstanceOf(result, ToolOutput);

    const [part] = result.files;
    assertEquals(part.file, {
      mimeType: "image/jpeg",
      data: encodeBase64(JPEG_BYTES),
    });
    assertEquals(decodeBase64(part.file.data!), JPEG_BYTES);
    assertEquals(
      result.output,
      `Image loaded: ${filePath} (image/jpeg, ${JPEG_BYTES.length} bytes).`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("image - reads a GIF89a file into a base64 file part", async () => {
  const tempDir = await Deno.makeTempDir();
  const tool = image();
  const filePath = join(tempDir, "animation.gif");

  try {
    await Deno.writeFile(filePath, GIF89a_BYTES);
    const result = await tool.call({ path: filePath });
    assertInstanceOf(result, ToolOutput);

    const [part] = result.files;
    assertEquals(part.file, {
      mimeType: "image/gif",
      data: encodeBase64(GIF89a_BYTES),
    });
    assertEquals(decodeBase64(part.file.data!), GIF89a_BYTES);
    assertEquals(
      result.output,
      `Image loaded: ${filePath} (image/gif, ${GIF89a_BYTES.length} bytes).`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("image - reads a GIF87a file into a base64 file part", async () => {
  const tempDir = await Deno.makeTempDir();
  const tool = image();
  const filePath = join(tempDir, "legacy.gif");

  try {
    await Deno.writeFile(filePath, GIF87a_BYTES);
    const result = await tool.call({ path: filePath });
    assertInstanceOf(result, ToolOutput);

    const [part] = result.files;
    assertEquals(part.file, {
      mimeType: "image/gif",
      data: encodeBase64(GIF87a_BYTES),
    });
    assertEquals(decodeBase64(part.file.data!), GIF87a_BYTES);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("image - reads a WebP file into a base64 file part", async () => {
  const tempDir = await Deno.makeTempDir();
  const tool = image();
  const filePath = join(tempDir, "picture.webp");

  try {
    await Deno.writeFile(filePath, WEBP_BYTES);
    const result = await tool.call({ path: filePath });
    assertInstanceOf(result, ToolOutput);

    const [part] = result.files;
    assertEquals(part.file, {
      mimeType: "image/webp",
      data: encodeBase64(WEBP_BYTES),
    });
    assertEquals(decodeBase64(part.file.data!), WEBP_BYTES);
    assertEquals(
      result.output,
      `Image loaded: ${filePath} (image/webp, ${WEBP_BYTES.length} bytes).`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("image - sniffs a JPEG stored with a .png extension", async () => {
  const tempDir = await Deno.makeTempDir();
  const tool = image();
  const filePath = join(tempDir, "mislabeled.png");

  try {
    await Deno.writeFile(filePath, JPEG_BYTES);
    const result = await tool.call({ path: filePath });
    assertInstanceOf(result, ToolOutput);

    const [part] = result.files;
    assertEquals(part.file.mimeType, "image/jpeg");
    assertEquals(decodeBase64(part.file.data!), JPEG_BYTES);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("image - honors custom maxBytes and allowedMimeTypes", async () => {
  const tempDir = await Deno.makeTempDir();
  const tool = image({ maxBytes: 1_000, allowedMimeTypes: ["image/gif"] });
  const filePath = join(tempDir, "animation.gif");

  try {
    await Deno.writeFile(filePath, GIF89a_BYTES);
    const result = await tool.call({ path: filePath });
    assertInstanceOf(result, ToolOutput);

    const [part] = result.files;
    assertEquals(part.file.mimeType, "image/gif");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("image - requires a path input", async () => {
  const tool = image();
  await assertRejects(() => tool.call({}));
});

Deno.test("image - throws when the image is not found", async () => {
  const tempDir = await Deno.makeTempDir();
  const tool = image();
  const filePath = join(tempDir, "missing.png");

  try {
    await assertRejects(
      () => tool.call({ path: filePath }),
      Error,
      `Image not found: ${filePath}`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("image - throws when the path is a directory", async () => {
  const tempDir = await Deno.makeTempDir();
  const tool = image();
  const dirPath = join(tempDir, "some_dir");

  try {
    await Deno.mkdir(dirPath);
    await assertRejects(
      () => tool.call({ path: dirPath }),
      Error,
      `Path is a directory, not a file: ${dirPath}`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("image - throws on non-image content", async () => {
  const tempDir = await Deno.makeTempDir();
  const tool = image();
  const filePath = join(tempDir, "not-an-image.png");

  try {
    await Deno.writeFile(
      filePath,
      new TextEncoder().encode("definitely not an image"),
    );
    await assertRejects(
      () => tool.call({ path: filePath }),
      Error,
      `Unsupported image format: ${filePath}. Supported formats: image/png, image/jpeg, image/gif, image/webp.`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("image - throws on files over the default 5 MB limit", async () => {
  const tempDir = await Deno.makeTempDir();
  const tool = image();
  const filePath = join(tempDir, "huge.png");
  const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
  bytes.set(PNG_BYTES, 0);

  try {
    await Deno.writeFile(filePath, bytes);
    await assertRejects(
      () => tool.call({ path: filePath }),
      Error,
      `Image too large: ${filePath} is ${bytes.length} bytes, which exceeds the ${
        5 * 1024 * 1024
      } byte limit.`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("image - throws on files over a custom maxBytes", async () => {
  const tempDir = await Deno.makeTempDir();
  const tool = image({ maxBytes: 10 });
  const filePath = join(tempDir, "too-big.gif");

  try {
    await Deno.writeFile(filePath, GIF89a_BYTES);
    await assertRejects(
      () => tool.call({ path: filePath }),
      Error,
      `Image too large: ${filePath} is ${GIF89a_BYTES.length} bytes, which exceeds the 10 byte limit.`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("image - throws on sniffed types outside allowedMimeTypes", async () => {
  const tempDir = await Deno.makeTempDir();
  const tool = image({ allowedMimeTypes: ["image/png"] });
  const filePath = join(tempDir, "photo.jpg");

  try {
    await Deno.writeFile(filePath, JPEG_BYTES);
    await assertRejects(
      () => tool.call({ path: filePath }),
      Error,
      `Image type not allowed: ${filePath} is image/jpeg. Allowed types: image/png.`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("image - rejects invalid maxBytes configuration", () => {
  for (const maxBytes of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
    assertThrows(
      () => image({ maxBytes }),
      TypeError,
      "Image maxBytes must be a finite, positive number",
    );
  }
});

Deno.test("image - reads an image through a symlink to a regular file", async () => {
  const tempDir = await Deno.makeTempDir();
  const tool = image();
  const targetPath = join(tempDir, "pixel.png");
  const linkPath = join(tempDir, "link.png");

  try {
    await Deno.writeFile(targetPath, PNG_BYTES);
    await Deno.symlink(targetPath, linkPath);
    const result = await tool.call({ path: linkPath });
    assertInstanceOf(result, ToolOutput);

    const [part] = result.files;
    assertEquals(part.file, {
      mimeType: "image/png",
      data: encodeBase64(PNG_BYTES),
    });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test({
  name: "image - throws when the path is a FIFO",
  // mkfifo is a Unix utility.
  ignore: Deno.build.os === "windows",
  async fn() {
    const tempDir = await Deno.makeTempDir();
    const tool = image();
    const fifoPath = join(tempDir, "named-pipe.png");

    try {
      const mkfifo = new Deno.Command("mkfifo", { args: [fifoPath] });
      const { success } = await mkfifo.output();
      assertEquals(success, true);

      await assertRejects(
        () => tool.call({ path: fifoPath }),
        Error,
        `Path is not a regular file: ${fifoPath}`,
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});
