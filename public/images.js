// Photos are downscaled on the phone before they are stored or sent anywhere.

async function decode(source) {
  if (source instanceof Blob && 'createImageBitmap' in window) {
    try {
      return await createImageBitmap(source, { imageOrientation: 'from-image' });
    } catch { /* fall through to <img> */ }
  }
  const url = source instanceof Blob ? URL.createObjectURL(source) : source;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    if (source instanceof Blob) URL.revokeObjectURL(url);
  }
}

async function toJpeg(source, maxSide, quality) {
  const image = await decode(source);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close?.();
  return canvas.toDataURL('image/jpeg', quality);
}

/** A camera/library file -> JPEG data URL, big enough to read small print. */
export const fileToJpeg = (file) => toJpeg(file, 1600, 0.82);

/** A stored photo -> small data URL for the coffee list. */
export const makeThumb = (dataUrl) => toJpeg(dataUrl, 320, 0.78);
