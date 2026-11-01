"use client";

/**
 * FaceCapture — webcam capture for the SCRM-style face login.
 *
 * React port of SCRM auth/camera.ts using the "basic camera checks" guidance
 * path (brightness + sharpness measured on the canvas; the SERVER does all
 * face verification — browser guidance can never grant access). Captures
 * 1 photo for login or 20 photos for enrollment, as JPEG data URLs
 * (<= 120k characters, 160x120..640x480), then hands them to the parent.
 */

import { useEffect, useRef, useState } from "react";
import { VideoOff, X } from "lucide-react";
import { ENROLLMENT_PHOTOS, LOGIN_PHOTOS, MAX_FRAME_CHARACTERS } from "./access-client";

export interface FaceCaptureProps {
  single: boolean;
  onCapture: (images: string[]) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}

type FrameQuality = { brightness: number; sharpness: number };

function captureSize(width: number, height: number) {
  if (width <= 0 || height <= 0)
    throw new Error("The camera has not supplied a frame yet.");
  const scale = Math.min(1, 640 / width, 480 / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function measureFrame(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): FrameQuality {
  const left = Math.max(2, Math.floor(width * 0.2));
  const right = Math.min(width - 2, Math.ceil(width * 0.8));
  const top = Math.max(2, Math.floor(height * 0.15));
  const bottom = Math.min(height - 2, Math.ceil(height * 0.85));
  const gray = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  let brightness = 0;
  let sharpness = 0;
  let count = 0;
  for (let y = top; y < bottom; y += 3)
    for (let x = left; x < right; x += 3) {
      const value = gray(x, y);
      brightness += value;
      sharpness +=
        (4 * value - gray(x - 1, y) - gray(x + 1, y) - gray(x, y - 1) - gray(x, y + 1)) **
        2;
      count++;
    }
  return {
    brightness: count ? brightness / count : 0,
    sharpness: count ? sharpness / count : 0,
  };
}

function assessFrame(quality: FrameQuality) {
  if (quality.brightness < 32)
    return { message: "Add light in front of you, rather than behind you.", ready: false };
  if (quality.sharpness < 3)
    return { message: "Hold still for a moment while the camera focuses.", ready: false };
  return { message: "Face ready. Hold comfortably still and look at the camera.", ready: true };
}

function encodeCameraFrame(canvas: HTMLCanvasElement): string {
  for (const quality of [0.78, 0.68, 0.58, 0.48, 0.38]) {
    const image = canvas.toDataURL("image/jpeg", quality);
    if (image.length <= MAX_FRAME_CHARACTERS) return image;
  }
  throw new Error("This camera image is too large. Try a lower camera resolution.");
}

export default function FaceCapture({ single, onCapture, onCancel, onError }: FaceCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [prompt, setPrompt] = useState("Starting camera...");
  const [count, setCount] = useState(0);
  const [ready, setReady] = useState(false);
  const total = single ? LOGIN_PHOTOS : ENROLLMENT_PHOTOS;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let stream: MediaStream | undefined;
    let cancelled = false;
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    const stop = () => {
      stream?.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    };

    const run = async () => {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error(
          "Camera access needs HTTPS or localhost. Open this page in Chrome and allow camera access.",
        );
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: "user",
          },
          audio: false,
        });
      } catch (error) {
        const name = (error as Error).name;
        if (name === "NotAllowedError")
          throw new Error(
            "Camera permission was denied. In Chrome, open the site controls next to the address bar, allow Camera, then retry. If you are inside a preview frame, open this page in its own tab first.",
          );
        if (name === "NotReadableError")
          throw new Error("The camera is busy. Close other camera apps or tabs, then retry.");
        if (name === "NotFoundError")
          throw new Error("No camera was found. Connect a webcam or try a device with a camera.");
        throw error;
      }
      if (cancelled) return;
      video.srcObject = stream;
      const readyAt = performance.now();
      video.play().catch(() => {});
      while (video.readyState < 2 || !video.videoWidth) {
        if (cancelled) return;
        if (performance.now() - readyAt > 12000)
          throw new Error("The camera did not start. Check camera permissions and retry.");
        await wait(100);
      }
      const canvas = document.createElement("canvas");
      const size = captureSize(video.videoWidth, video.videoHeight);
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Camera capture is unavailable.");

      const images: string[] = [];
      let settled = 0;
      const started = performance.now();
      let previousFrame = -1;

      while (images.length < total) {
        if (cancelled) return;
        if (performance.now() - started > 45000)
          throw new Error(
            "The camera could not get a clear view yet. Move closer, face a light, and retry.",
          );
        if (
          video.readyState < 2 ||
          !stream.getVideoTracks()[0] ||
          stream.getVideoTracks()[0].readyState === "ended"
        )
          throw new Error("The camera stopped. Reconnect it or allow camera access, then retry.");
        if (video.currentTime === previousFrame) {
          await wait(100);
          continue;
        }
        previousFrame = video.currentTime;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const quality = measureFrame(
          context.getImageData(0, 0, canvas.width, canvas.height).data,
          canvas.width,
          canvas.height,
        );
        const assessment = assessFrame(quality);
        setReady(assessment.ready);
        if (!assessment.ready) {
          settled = 0;
          setPrompt(assessment.message);
          await wait(200);
          continue;
        }
        settled++;
        setPrompt(
          settled < 3
            ? "Camera ready. Hold still briefly..."
            : `Capturing clear photo ${images.length + 1} of ${total}...`,
        );
        if (settled >= 3) {
          images.push(encodeCameraFrame(canvas));
          setCount(images.length);
        }
        await wait(180);
      }
      setPrompt("Clear photos captured. Checking your face...");
      onCapture(images);
    };

    run().catch((error) => {
      if (cancelled) return;
      onError(
        (error as Error).name === "AbortError" ? "Scan cancelled." : (error as Error).message,
      );
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-inner">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="block h-auto w-full max-w-[420px] bg-zinc-950"
          aria-label="Camera preview for face verification"
        />
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 flex items-center justify-center transition-colors ${
            ready ? "" : "bg-black/40"
          }`}
        >
          <div
            className={`h-[70%] w-[52%] rounded-[50%] border-2 transition-colors ${
              ready ? "border-emerald-400/80 shadow-[0_0_24px_rgba(52,211,153,0.25)]" : "border-zinc-500/60"
            }`}
          />
        </div>
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
            <VideoOff className="h-6 w-6 text-zinc-600" />
          </div>
        )}
      </div>
      <p className="text-center text-sm text-zinc-400" role="status" aria-live="polite">
        {prompt}
      </p>
      <div className="flex w-full max-w-[420px] items-center gap-3">
        <div
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800"
          role="progressbar"
          aria-valuenow={count}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-label="Clear photos captured"
        >
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
            style={{ width: `${(count / total) * 100}%` }}
          />
        </div>
        <span className="text-xs tabular-nums text-zinc-500">
          {count}/{total}
        </span>
      </div>
      <p className="max-w-sm text-center text-xs text-zinc-600">
        Face the camera comfortably. You do not need to turn your head. Unclear frames are skipped
        automatically.
      </p>
      <button
        type="button"
        onClick={onCancel}
        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
      >
        <X className="h-4 w-4" aria-hidden="true" /> Cancel scan
      </button>
    </div>
  );
}
