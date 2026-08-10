/**
 * A camera-based QR scanner for reading a join code off the other phone.
 *
 * Uses getUserMedia + jsQR (pure JS, no native BarcodeDetector dependency, so
 * it works on iOS Safari too). It degrades honestly: if there's no camera, or
 * permission is denied, it reports the reason via `onError` and the caller
 * falls back to the paste-a-code path, which always works.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

interface QrScannerProps {
  /** Called once with the decoded text the first time a QR is read. The parent
   *  is expected to unmount the scanner in response. */
  onResult: (text: string) => void;
  /** Called when the camera can't be started (unsupported, denied, no device). */
  onError?: (message: string) => void;
}

export function QrScanner({ onResult, onError }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [starting, setStarting] = useState(true);
  // Latest callbacks in refs so the effect that owns the camera runs once and
  // isn't torn down/restarted when the parent re-renders with new closures.
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  onResultRef.current = onResult;
  onErrorRef.current = onError;

  const fail = useCallback((message: string) => {
    onErrorRef.current?.(message);
  }, []);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let rafId = 0;
    let stopped = false;
    let found = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const stop = () => {
      stopped = true;
      if (rafId) cancelAnimationFrame(rafId);
      stream?.getTracks().forEach((t) => t.stop());
    };

    const tick = () => {
      if (stopped || found) return;
      const video = videoRef.current;
      if (video && video.readyState === video.HAVE_ENOUGH_DATA && ctx) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (w && h) {
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          const image = ctx.getImageData(0, 0, w, h);
          const result = jsQR(image.data, w, h, { inversionAttempts: 'dontInvert' });
          if (result && result.data) {
            found = true;
            stop();
            onResultRef.current(result.data);
            return;
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        fail('This device has no camera available for scanning.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        // iOS needs these set for an inline autoplay to be allowed.
        video.setAttribute('playsinline', 'true');
        video.muted = true;
        await video.play();
        setStarting(false);
        rafId = requestAnimationFrame(tick);
      } catch (err) {
        const denied =
          err instanceof DOMException &&
          (err.name === 'NotAllowedError' || err.name === 'SecurityError');
        fail(
          denied
            ? 'Camera permission was denied — paste the code instead.'
            : 'Could not start the camera — paste the code instead.',
        );
      }
    };

    void start();
    return stop;
  }, [fail]);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: 320,
        aspectRatio: '1 / 1',
        margin: '0 auto',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        background: '#000',
      }}
    >
      <video
        ref={videoRef}
        playsInline
        muted
        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      />
      {starting ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: 'var(--font-size-sm)',
          }}
        >
          Starting camera…
        </div>
      ) : null}
    </div>
  );
}
