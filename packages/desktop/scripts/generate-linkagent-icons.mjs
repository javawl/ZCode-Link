// 从 ImageGen 母版派生发行图标；仅编码/缩放，不重新绘制品牌。运行环境：macOS (sips)。
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Icns, IcnsImage } from "@fiahfy/icns";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const master = join(root, "packages/ui/src/assets/brand/linkagent-icon.png");
const build = join(root, "packages/desktop/build");
const icons = join(build, "icons");
const temp = await mkdtemp(join(tmpdir(), "linkagent-icons-"));
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
try {
  await mkdir(icons, { recursive: true });
  const images = new Map();
  for (const size of sizes) {
    const path = join(temp, `${size}.png`);
    await run("sips", ["-z", String(size), String(size), master, "--out", path]);
    images.set(size, await readFile(path));
    await cp(path, join(icons, `${size}x${size}.png`));
  }
  const icns = new Icns();
  for (const [size, type] of [
    [16, "icp4"],
    [32, "icp5"],
    [64, "icp6"],
    [128, "ic07"],
    [256, "ic08"],
    [512, "ic09"],
    [1024, "ic10"],
  ]) {
    icns.append(IcnsImage.fromPNG(images.get(size), type));
  }
  await writeFile(join(build, "icon.icns"), icns.data);
  // ICO 容器内使用 PNG 帧，保留透明度并提供 Windows 小尺寸图标。
  const icoSizes = sizes.filter((size) => size <= 256);
  const header = Buffer.alloc(6 + icoSizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(icoSizes.length, 4);
  let offset = header.length;
  icoSizes.forEach((size, index) => {
    const start = 6 + index * 16;
    const png = images.get(size);
    header[start] = size === 256 ? 0 : size;
    header[start + 1] = header[start];
    header.writeUInt16LE(1, start + 4);
    header.writeUInt16LE(32, start + 6);
    header.writeUInt32LE(png.length, start + 8);
    header.writeUInt32LE(offset, start + 12);
    offset += png.length;
  });
  await writeFile(
    join(build, "icon.ico"),
    Buffer.concat([header, ...icoSizes.map((size) => images.get(size))]),
  );
  for (const name of ["icon.png", "icon_windows.png", "icon_installer.png"]) {
    await writeFile(join(build, name), images.get(1024));
  }
  await cp(join(build, "icon.icns"), join(build, "icon_installer.icns"));
  await cp(join(build, "icon.ico"), join(build, "icon_installer.ico"));
  await cp(
    join(icons, "256x256.png"),
    join(root, "packages/desktop/src/renderer/public/linkagent-icon.png"),
  );
  await cp(join(icons, "32x32.png"), join(root, "packages/web/public/linkagent-icon.png"));
  console.log("LinkAgent PNG / ICNS / ICO assets generated from", master);
} finally {
  await rm(temp, { recursive: true, force: true });
}
