import { useEffect, useMemo, useRef } from "react";
import createGlobe from "cobe";
import globeData from "../data/globe_points.json";

type Props = {
  className?: string;
};

function mulberry32(seed: number) {
  // deterministic small PRNG (for stable marker layout)
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

type GlobePoint = {
  lat: number;
  lon: number;
  city?: string | null;
  repo?: string | null;
  owner?: string | null;
};

type GlobeData = { points: GlobePoint[] };

export default function Globe({ className = "" }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const repoPoints = (globeData as unknown as GlobeData)?.points ?? [];

  const markers = useMemo(() => {
    // Make repo markers smaller so we can render more without looking crowded.
    const r = mulberry32(7);
    const repoMarkers = repoPoints
      .filter((p) => typeof p.lat === "number" && typeof p.lon === "number")
      .slice(0, 150) // requested: at least 150 repo markers
      .map((p) => ({
        location: [p.lat, p.lon] as [number, number],
        size: 0.018 + r() * 0.014, // [0.018..0.032]
      }));

    const highlight = [
      { location: [39.9042, 116.4074] as [number, number], size: 0.045 }, // Beijing
      { location: [31.2304, 121.4737] as [number, number], size: 0.045 }, // Shanghai
      { location: [34.0522, -118.2437] as [number, number], size: 0.045 }, // Los Angeles
      { location: [40.7128, -74.0060] as [number, number], size: 0.040 }, // New York
      { location: [51.5074, -0.1278] as [number, number], size: 0.040 }, // London
      { location: [35.6762, 139.6503] as [number, number], size: 0.040 }, // Tokyo
    ];

    return [...repoMarkers, ...highlight];
  }, [repoPoints]);

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
      mapSamples: 42000,
      mapBrightness: 5.2,
      baseColor: [0.04, 0.10, 0.20],
      markerColor: [0.88, 0.95, 1.0],
      glowColor: [0.18, 0.55, 1.0],
      markers,
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
  }, [markers]);

  return (
    <div className={`relative ${className}`}>
      <canvas
        ref={canvasRef}
        className="w-full h-full rounded-full"
        style={{
          background:
            "radial-gradient(circle at 28% 28%, rgba(56,189,248,0.30), rgba(2,6,23,0) 58%)," +
            "radial-gradient(circle at 70% 72%, rgba(139,92,246,0.16), rgba(2,6,23,0) 62%)",
        }}
      />
      <div className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-white/12 shadow-[0_0_110px_rgba(56,189,248,0.22)]" />
      <div className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-sky-400/10" />
    </div>
  );
}

