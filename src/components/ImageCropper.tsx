"use client";

import { useState, useCallback } from "react";
import Cropper from "react-easy-crop";
import { X, Check, RotateCcw } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface Props {
  image: string;
  onCropComplete: (croppedImage: Blob) => void;
  onCancel: () => void;
}

export function ImageCropper({ image, onCropComplete, onCancel }: Props) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<any>(null);

  const onCropChange = (crop: { x: number; y: number }) => {
    setCrop(crop);
  };

  const onZoomChange = (zoom: number) => {
    setZoom(zoom);
  };

  const onCropAreaComplete = useCallback((_: any, croppedAreaPixels: any) => {
    setCroppedAreaPixels(croppedAreaPixels);
  }, []);

  const createImage = (url: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.addEventListener("load", () => resolve(image));
      image.addEventListener("error", (error) => reject(error));
      image.setAttribute("crossOrigin", "anonymous");
      image.src = url;
    });

  const getCroppedImg = async () => {
    try {
      const img = await createImage(image);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      if (!ctx) return;

      canvas.width = croppedAreaPixels.width;
      canvas.height = croppedAreaPixels.height;

      ctx.drawImage(
        img,
        croppedAreaPixels.x,
        croppedAreaPixels.y,
        croppedAreaPixels.width,
        croppedAreaPixels.height,
        0,
        0,
        croppedAreaPixels.width,
        croppedAreaPixels.height
      );

      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Canvas is empty"));
        }, "image/jpeg", 0.95);
      });
    } catch (e) {
      console.error(e);
    }
  };

  const handleDone = async () => {
    const croppedBlob = await getCroppedImg();
    if (croppedBlob) {
      onCropComplete(croppedBlob);
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[300] bg-black/90 backdrop-blur-xl flex flex-col items-center justify-center p-6"
    >
      <div 
        className="relative w-[80vw] max-w-[400px] aspect-[9/16] max-h-[60vh] bg-[#050505] overflow-hidden rounded-sm border border-white/10 shadow-2xl"
        style={{ touchAction: 'none' }}
      >
        <Cropper
          image={image}
          crop={crop}
          zoom={zoom}
          aspect={9 / 16}
          onCropChange={onCropChange}
          onCropComplete={onCropAreaComplete}
          onZoomChange={onZoomChange}
          style={{
            containerStyle: { background: "#050505" },
            cropAreaStyle: { border: "1px solid rgba(255,255,255,0.2)" }
          }}
        />
      </div>

      <div className="w-full max-w-[400px] mt-8 space-y-8">
        <div className="flex flex-col gap-4">
           <div className="flex justify-between items-center px-1">
             <span className="font-dm-sans text-[8px] uppercase tracking-[.4em] text-muted">zoom to frame</span>
             <button onClick={() => setZoom(1)} className="text-muted hover:text-text transition-colors">
                <RotateCcw size={12} />
             </button>
           </div>
           <input
             type="range"
             value={zoom}
             min={1}
             max={3}
             step={0.1}
             aria-labelledby="Zoom"
             onChange={(e) => setZoom(Number(e.target.value))}
             className="w-full h-[1px] bg-white/10 appearance-none cursor-pointer accent-white"
           />
        </div>

        <div className="flex gap-4">
          <button
            onClick={onCancel}
            className="flex-1 py-4 border border-white/5 font-dm-sans text-[9px] uppercase tracking-[.4em] text-muted hover:text-text transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleDone}
            className="flex-1 py-4 bg-white text-black font-dm-sans text-[9px] uppercase tracking-[.4em] border border-white hover:bg-transparent hover:text-white transition-all transform active:scale-95"
          >
            Apply Frame
          </button>
        </div>
      </div>
      
      <div className="mt-8 text-center pointer-events-none opacity-20">
         <p className="font-dm-sans text-[8px] uppercase tracking-[.6em]">9:16 Full Screen / confirmed</p>
      </div>
    </motion.div>
  );
}
