import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const requiredFiles = [
  "settings.gradle",
  "build.gradle",
  "app/build.gradle",
  "app/src/main/AndroidManifest.xml",
  "app/src/main/java/com/tietie/diary/MainActivity.java"
];

for (const file of requiredFiles) {
  const fullPath = join(root, file);
  if (!existsSync(fullPath)) {
    throw new Error(`Missing Android shell file: ${file}`);
  }
}

const manifest = readFileSync(join(root, "app/src/main/AndroidManifest.xml"), "utf8");
if (!manifest.includes("android.permission.INTERNET") || !manifest.includes(".MainActivity")) {
  throw new Error("Android manifest is incomplete.");
}

console.log("Android shell verified.");
