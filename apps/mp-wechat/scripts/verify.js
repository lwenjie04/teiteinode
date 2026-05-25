import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const jsonFiles = ["app.json", "project.config.json"];
const requiredFiles = [
  "app.js",
  "app.wxss",
  "utils/api.js",
  "utils/storage.js",
  "pages/index/index.js",
  "pages/index/index.wxml",
  "pages/timeline/timeline.js",
  "pages/timeline/timeline.wxml",
  "pages/editor/editor.js",
  "pages/editor/editor.wxml",
  "pages/settings/settings.js",
  "pages/settings/settings.wxml"
];

for (const file of [...jsonFiles, ...requiredFiles]) {
  if (!existsSync(join(root, file))) {
    throw new Error(`Missing mini program file: ${file}`);
  }
}

for (const file of jsonFiles) {
  JSON.parse(readFileSync(join(root, file), "utf8"));
}

for (const file of requiredFiles.filter((item) => item.endsWith(".js"))) {
  const source = readFileSync(join(root, file), "utf8");
  try {
    new Function(source);
  } catch (error) {
    throw new Error(`Mini program script has invalid syntax: ${file}\n${error.message}`);
  }
}

const app = JSON.parse(readFileSync(join(root, "app.json"), "utf8"));
for (const page of app.pages) {
  if (!existsSync(join(root, `${page}.js`)) || !existsSync(join(root, `${page}.wxml`))) {
    throw new Error(`Mini program page is incomplete: ${page}`);
  }
}

console.log("WeChat mini program shell verified.");
