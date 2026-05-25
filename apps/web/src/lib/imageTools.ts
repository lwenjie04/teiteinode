export interface PreparedPhoto {
  file: File;
  compressed: boolean;
}

const defaultMaxPhotoSide = 1800;
const defaultTargetBytes = 7 * 1024 * 1024;

export function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function imageFromFile(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片读取失败"));
    };
    image.src = url;
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

export async function preparePhotoFile(file: File, maxPhotoSide = defaultMaxPhotoSide, targetBytes = defaultTargetBytes): Promise<PreparedPhoto> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return { file, compressed: false };
  try {
    const image = await imageFromFile(file);
    const scale = Math.min(1, maxPhotoSide / Math.max(image.naturalWidth, image.naturalHeight));
    if (scale === 1 && file.size <= targetBytes) return { file, compressed: false };

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return { file, compressed: false };
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await canvasToBlob(canvas, "image/jpeg", 0.86);
    if (!blob || blob.size >= file.size) return { file, compressed: false };
    const name = file.name.replace(/\.[^.]+$/, "") || "photo";
    return {
      file: new File([blob], `${name}.jpg`, { type: "image/jpeg", lastModified: Date.now() }),
      compressed: true
    };
  } catch {
    return { file, compressed: false };
  }
}
