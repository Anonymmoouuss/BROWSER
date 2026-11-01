// face-auth mini-service (port 3032) — server-side face verification ported
// from the SCRM project's api/_lib/face.ts (scramjet fork). Plain Node ESM.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import jpeg from "jpeg-js";

const require = createRequire(import.meta.url);

const PORT = 3032;
export const FACE_THRESHOLD = 0.48;
export const FRAME_COUNT = 20;
// Login captures several quick frames: the server averages the consistent
// subset, which markedly reduces single-frame descriptor noise from a real
// webcam (the leading cause of false rejections).
export const LOGIN_MIN_FRAMES = 1;
export const LOGIN_MAX_FRAMES = 3;
const MAX_BODY_BYTES = 3 * 1024 * 1024; // 3 MB

export class FaceCaptureError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "FaceCaptureError";
    this.code = code;
    this.status = status;
  }
}

export function faceDistance(a, b) {
  if (
    a.length !== 128 ||
    b.length !== 128 ||
    !a.every(Number.isFinite) ||
    !b.every(Number.isFinite)
  )
    throw new Error("Invalid face template.");
  return Math.sqrt(a.reduce((sum, value, i) => sum + (value - b[i]) ** 2, 0));
}

export function selectConsistentTemplate(descriptors, minimum) {
  if (descriptors.length < minimum)
    throw new FaceCaptureError(
      "not_clear",
      "Not enough clear photos were found. Keep facing the camera in even lighting and retry.",
    );
  const distances = descriptors.map((a) =>
    descriptors.map((b) => faceDistance(a, b)),
  );
  const index = distances.reduce(
    (best, row, i) =>
      row.reduce((a, b) => a + b, 0) <
      distances[best].reduce((a, b) => a + b, 0)
        ? i
        : best,
    0,
  );
  const matching = descriptors.filter(
    (d) => faceDistance(descriptors[index], d) <= FACE_THRESHOLD,
  );
  if (matching.length < minimum)
    throw new FaceCaptureError(
      "inconsistent",
      "The photos did not consistently show the same face. Hold still in steady lighting and retry.",
    );
  return {
    descriptor: descriptors[index].map(
      (_, i) => matching.reduce((sum, d) => sum + d[i], 0) / matching.length,
    ),
    index,
  };
}

export function decodeFrame(value) {
  if (
    typeof value !== "string" ||
    value.length > 120_000 ||
    !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new Error("Invalid camera image.");
  const bytes = Buffer.from(value.slice(23), "base64");
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw new Error("JPEG camera images are required.");
  const image = jpeg.decode(bytes, {
    useTArray: true,
    maxResolutionInMP: 0.35,
    maxMemoryUsageInMB: 32,
    tolerantDecoding: false,
  });
  if (
    image.width < 160 ||
    image.height < 120 ||
    image.width > 640 ||
    image.height > 480
  )
    throw new Error("Use camera images between 160\u00d7120 and 640\u00d7480.");
  return image;
}

// No scripted yaw sequence: photos are sampled across naturally varied angles.

let loaded;
let accurateLoaded;
let modelDirectory = "";
let modelsLoaded = false;

async function loadModel() {
  if (!loaded)
    loaded = (async () => {
      const face = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
      const wasm = require("@tensorflow/tfjs-backend-wasm");
      const wasmPath = dirname(
        require.resolve(
          "@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm",
        ),
      );
      const modelPath = join(
        dirname(require.resolve("@vladmandic/face-api/package.json")),
        "model",
      );
      wasm.setWasmPaths(wasmPath + "/");
      await face.tf.setBackend("wasm");
      await face.tf.ready();
      modelDirectory = modelPath;
      await face.nets.tinyFaceDetector.loadFromDisk(modelPath);
      await face.nets.faceLandmark68Net.loadFromDisk(modelPath);
      await face.nets.faceRecognitionNet.loadFromDisk(modelPath);
      modelsLoaded = true;
      console.log(
        "[face-auth] models ready (tinyFaceDetector, faceLandmark68Net, faceRecognitionNet) from",
        modelPath,
      );
      return face;
    })().catch((error) => {
      loaded = undefined;
      throw error;
    });
  return loaded;
}

// Serialize inference and bound waiting/work so a busy instance does not hang scans.
let queue = Promise.resolve();

function frameTensor(face, value) {
  const image = decodeFrame(value);
  const rgb = new Int32Array(image.width * image.height * 3);
  for (let i = 0, j = 0; i < image.data.length; i += 4) {
    rgb[j++] = image.data[i];
    rgb[j++] = image.data[i + 1];
    rgb[j++] = image.data[i + 2];
  }
  return face.tf.tensor3d(rgb, [image.height, image.width, 3], "int32");
}

export async function verifyCapture(images, purpose) {
  const isLogin = purpose === "login";
  const expected =
    isLogin ? LOGIN_MAX_FRAMES : purpose === "enroll" ? FRAME_COUNT : 0;
  if (
    !expected ||
    !Array.isArray(images) ||
    (isLogin
      ? images.length < LOGIN_MIN_FRAMES || images.length > LOGIN_MAX_FRAMES
      : images.length !== expected)
  )
    throw new FaceCaptureError(
      "invalid_capture",
      isLogin
        ? "One to three clear login photos are required."
        : "Twenty enrollment photos are required.",
    );
  for (const image of images)
    if (
      typeof image !== "string" ||
      image.length > 120_000 ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)
    )
      throw new FaceCaptureError(
        "invalid_capture",
        "The camera sent an invalid photo. Reload the page and retry.",
      );
  const submitted = Date.now();
  const run = queue.then(async () => {
    if (Date.now() - submitted > 20000)
      throw new FaceCaptureError(
        "busy",
        "The face checker is busy. Please retry in a moment.",
        503,
      );
    let face;
    try {
      face = await loadModel();
    } catch (error) {
      console.error(
        "[face-auth] Face model failed to load:",
        error instanceof Error ? error.message : "Unknown model error",
      );
      throw new FaceCaptureError(
        "unavailable",
        "The face checker could not start. Ask the administrator to check the deployed models.",
        503,
      );
    }
    const candidates = [];
    let small = 0;
    const deadline = Date.now() + 35000;
    const checkTime = () => {
      if (Date.now() > deadline)
        throw new FaceCaptureError(
          "busy",
          "The face checker took too long. Please retry in a moment.",
          503,
        );
    };
    for (let index = 0; index < images.length; index++) {
      checkTime();
      let tensor;
      try {
        tensor = frameTensor(face, images[index]);
      } catch {
        throw new FaceCaptureError(
          "invalid_capture",
          "The camera photo could not be decoded. Reload and retry.",
        );
      }
      try {
        let detections = await face.detectAllFaces(
          tensor,
          new face.TinyFaceDetectorOptions({
            inputSize: 320,
            scoreThreshold: 0.4,
          }),
        );
        if (detections.length === 0) {
          accurateLoaded ??= face.nets.ssdMobilenetv1
            .loadFromDisk(modelDirectory)
            .catch((error) => {
              accurateLoaded = undefined;
              throw error;
            });
          await accurateLoaded;
          detections = await face.detectAllFaces(
            tensor,
            new face.SsdMobilenetv1Options({
              minConfidence: 0.5,
              maxResults: 3,
            }),
          );
        }
        if (detections.length > 1)
          throw new FaceCaptureError(
            "multiple_faces",
            "More than one face was detected. Please scan alone.",
          );
        if (!detections.length) continue;
        const detection = detections[0];
        if (detection.box.width < 45) {
          small++;
          continue;
        }
        candidates.push({
          index,
          detection,
          quality:
            detection.score *
            Math.min(detection.box.width, detection.box.height),
        });
      } finally {
        tensor.dispose();
      }
    }
    const minimum = purpose === "login" ? 1 : 12;
    if (candidates.length < minimum)
      throw new FaceCaptureError(
        "not_clear",
        small
          ? "Move a little closer so your face fills the guide."
          : "Your face was not clear enough in the photos. Face the camera directly with light in front of you.",
      );
    candidates.sort((a, b) => b.quality - a.quality);
    const descriptors = [];
    for (let i = 0; i < candidates.length; i++) {
      checkTime();
      const candidate = candidates[i];
      const tensor = frameTensor(face, images[candidate.index]);
      try {
        // Reuse the detection; do not run the detector again during alignment.
        const result = await new face.DetectAllFaceLandmarksTask(
          Promise.resolve([{ detection: candidate.detection }]),
          tensor,
          false,
        ).withFaceDescriptors();
        descriptors.push(Array.from(result[0].descriptor));
      } finally {
        tensor.dispose();
      }
      // Login: keep computing descriptors for EVERY frame first — the
      // consistent subset is averaged below, so a single noisy frame can
      // neither fail the scan nor dominate the result.
      if (!isLogin && descriptors.length >= minimum) {
        try {
          const selected = selectConsistentTemplate(descriptors, minimum);
          return {
            descriptor: selected.descriptor,
            reviewFrameIndex: candidates[selected.index].index,
          };
        } catch (error) {
          if (
            !(error instanceof FaceCaptureError) ||
            i === candidates.length - 1
          )
            throw error;
        }
      }
    }
    if (isLogin && descriptors.length >= LOGIN_MIN_FRAMES) {
      const selected = selectConsistentTemplate(descriptors, LOGIN_MIN_FRAMES);
      return {
        descriptor: selected.descriptor,
        reviewFrameIndex: candidates[selected.index].index,
      };
    }
    throw new FaceCaptureError(
      "not_clear",
      "Please keep one clear face in view and retry.",
    );
  });
  queue = run.catch(() => undefined);
  return run;
}

function respond(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      if (overflow) return; // keep draining without buffering
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) {
        reject(new Error("request body exceeds 3 MB"));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const pathname = req.url ? req.url.split("?")[0] : "";
  if (req.method === "GET" && pathname === "/health") {
    respond(res, 200, {
      ok: true,
      service: "face-auth",
      port: PORT,
      models: modelsLoaded,
    });
    return;
  }
  if (req.method === "POST" && pathname === "/verify") {
    try {
      let payload;
      try {
        const raw = await readBody(req);
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        respond(res, 400, {
          code: "invalid_capture",
          message: "The camera sent an invalid photo. Reload the page and retry.",
        });
        return;
      }
      const body = payload && typeof payload === "object" ? payload : {};
      const verification = await verifyCapture(body.images, body.purpose);
      respond(res, 200, verification);
    } catch (error) {
      if (error instanceof FaceCaptureError) {
        respond(res, error.status ?? 400, {
          code: error.code,
          message: error.message,
        });
        return;
      }
      // Log the real reason only; never log camera frames.
      console.error(
        "[face-auth] Verification failed:",
        error instanceof Error ? error.stack || error.message : String(error),
      );
      respond(res, 500, {
        code: "internal",
        message: "Face verification failed.",
      });
    }
    return;
  }
  respond(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[face-auth] listening on 0.0.0.0:${PORT}`);
  // Warm the models in the background (lazy loadModel stays on-demand/cached).
  loadModel().catch((error) => {
    console.error(
      "[face-auth] Model warm-up failed:",
      error instanceof Error ? error.message : error,
    );
  });
});
