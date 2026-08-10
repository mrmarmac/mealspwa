/**
 * Renders a string as a scannable QR code image.
 *
 * The code is always drawn dark-on-white regardless of the app theme: a QR
 * needs high contrast to scan, and inverting it for dark mode breaks many
 * readers, so it lives in its own small white card that reads correctly under
 * either theme.
 */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface QrCodeProps {
  /** The text to encode — here, a sync join code. */
  value: string;
  /** Rendered edge length in CSS px. @default 200 */
  size?: number;
}

export function QrCode({ value, size = 200 }: QrCodeProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    // Render at 2× for crispness on high-DPI phones; the <img> is sized down
    // to `size` in CSS.
    QRCode.toDataURL(value, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: size * 2,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  // Encoding failing is not fatal — the copyable text code is always shown
  // alongside, so we simply render nothing here.
  if (failed || !dataUrl) return null;

  return (
    <div
      style={{
        display: 'inline-flex',
        padding: 'var(--space-2)',
        background: '#ffffff',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <img
        src={dataUrl}
        alt="QR code containing the join code"
        width={size}
        height={size}
        style={{ display: 'block', width: size, height: size }}
      />
    </div>
  );
}
