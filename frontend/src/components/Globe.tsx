import { useEffect, useRef } from "react";
import createGlobe from "cobe";

type Props = {
  className?: string;
};

export default function Globe({ className = "" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let phi = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    // 让画面在 resize 下保持清晰
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    const globe = createGlobe(canvas, {
      devicePixelRatio: dpr,
      width: canvas.width,
      height: canvas.height,
      phi: 0,
      theta: 0.3,
      dark: 1,
      diffuse: 1.15,
      mapSamples: 16000,
      mapBrightness: 6,
      baseColor: [0.06, 0.13, 0.25],
      markerColor: [0.56, 0.83, 0.99],
      glowColor: [0.12, 0.45, 0.85],
      markers: [
        // 简单点缀：象征 “全球开源”
        { location: [37.77, -122.42], size: 0.06 },
        { location: [51.50, -0.12], size: 0.06 },
        { location: [35.68, 139.69], size: 0.06 },
        { location: [1.35, 103.82], size: 0.05 },
        { location: [48.85, 2.35], size: 0.05 },
        { location: [31.23, 121.47], size: 0.06 },
      ],
      onRender: (state) => {
        phi += 0.006;
        state.phi = phi;
        // cobe 内部会用 width/height；这里随 resize 同步
        state.width = canvas.width;
        state.height = canvas.height;
      },
    });

    return () => {
      globe.destroy();
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div className={`relative ${className}`}>
      <canvas
        ref={canvasRef}
        className="w-full h-full rounded-full"
        style={{
          background: "radial-gradient(circle at 30% 30%, rgba(56,189,248,0.25), rgba(2,6,23,0) 55%)",
        }}
      />
      <div className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-white/10 shadow-[0_0_80px_rgba(56,189,248,0.18)]" />
    </div>
  );
}

