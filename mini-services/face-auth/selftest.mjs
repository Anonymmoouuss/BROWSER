// Self-test: encodes a 320x240 solid-gray JPEG with jpeg-js (valid format,
// no face) and POSTs it to /verify as a login image. Expected result:
// HTTP 400 { code: "not_clear", ... } — proves jpeg decode, detector run,
// SSD fallback and error mapping all work (no real face needed).
import jpeg from "jpeg-js";

const width = 320;
const height = 240;
const data = Buffer.alloc(width * height * 4);
for (let i = 0; i < width * height; i++) {
  const j = i * 4;
  data[j] = 128; // gray
  data[j + 1] = 128;
  data[j + 2] = 128;
  data[j + 3] = 255;
}
const encoded = jpeg.encode({ data, width, height }, 90);
const dataUrl = "data:image/jpeg;base64," + encoded.data.toString("base64");
console.log(
  `image: ${width}x${height}, ${encoded.data.length} bytes, data URL ${dataUrl.length} chars`,
);

const response = await fetch("http://127.0.0.1:3032/verify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ images: [dataUrl], purpose: "login" }),
});
const text = await response.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  json = text;
}
console.log(`HTTP ${response.status}`);
console.log(JSON.stringify(json));
if (response.status === 400 && json && json.code === "not_clear") {
  console.log("SELFTEST PASSED: face pipeline returned not_clear");
} else {
  console.log("SELFTEST UNEXPECTED RESULT");
  process.exitCode = 1;
}
