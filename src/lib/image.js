// Payment screenshots: shrink in the browser before upload so phone
// screenshots fit comfortably under the server's 2.5 MB limit. The canvas
// re-encodes the pixels into a fresh JPEG. The server still checks the
// real file type and size.

const MAX_SIDE = 1600;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Couldn't read the image"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file isn't an image Luna can read"));
    img.src = src;
  });
}

// File -> { contentType, dataBase64 } ready for /api/payments.
export async function prepareProof(file) {
  if (!file) return null;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Choose a JPEG, PNG or WebP screenshot");
  const dataUrl = await readAsDataUrl(file);
  try {
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const jpeg = canvas.toDataURL("image/jpeg", 0.82);
    return { contentType: "image/jpeg", dataBase64: jpeg.slice(jpeg.indexOf(",") + 1) };
  } catch {
    // No canvas (very old browser): send the original if it's small enough.
    if (file.size > 2_400_000) throw new Error("That screenshot is too large; take a smaller one");
    return { contentType: file.type, dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1) };
  }
}
