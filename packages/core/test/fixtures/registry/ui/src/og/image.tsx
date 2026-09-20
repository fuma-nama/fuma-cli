import { readFile } from "node:fs/promises";

// not a reference
const docs = "new URL('./nope.ttf', import.meta.url)";
export const font = readFile(new URL("./font.ttf", import.meta.url));
