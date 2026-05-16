"use client";

import { useDrift } from "@/lib/useDrift";
import { Pairing } from "@/lib/data";
import { OutfitPanel } from "./OutfitPanel";
import { Minimap } from "./Minimap";
import { SongDrawer } from "./SongDrawer";
import { audioEngine } from "@/lib/audio";
import { createClient } from "@/utils/supabase/client";
import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { RitualGate } from "./RitualGate";
import { ShadowImage } from "./ShadowImage";

// ------------------------------------------------------------------
// Unified resolve cache — one call per track per session
// Returns both the fresh preview URL and the Spotify album art
// ------------------------------------------------------------------
interface Resolved {
  previewUrl: string | null;
  albumArt: string | null;
}

const resolveCache = new Map<string, Resolved>();

const isSpotifyNative = (url: string | null) =>
  !!url && (url.includes('scdn.co') || url.includes('akamaized.net'));

async function resolveTrack(pairing: Pairing): Promise<Resolved> {
  const cached = resolveCache.get(pairing.id);
  // Only use cache if it was a COMPLETE success (image + audio)
  if (cached && cached.albumArt && cached.previewUrl) return cached;

  const result: Resolved = {
    previewUrl: pairing.preview_url,
    albumArt: null,
  };

  if (pairing.spotify_url) {
    try {
      const res = await fetch(
        `/api/music/resolve?url=${encodeURIComponent(pairing.spotify_url)}`,
        { cache: 'no-store' }
      );
      if (res.ok) {
        const data = await res.json();
        if (data.preview_url) result.previewUrl = data.preview_url;
        if (data.image_url) result.albumArt = data.image_url;
        
        // ONLY CACHE IF SUCCESSFUL
        if (result.albumArt && result.previewUrl) {
           resolveCache.set(pairing.id, result);
        }
      }
    } catch (e) {
      console.warn(`[Resolve] Silent failure for ${pairing.id}`);
    }
  }

  // Final check for Spotify-native previews
  if (isSpotifyNative(pairing.preview_url)) {
    result.previewUrl = pairing.preview_url;
  }

  return result;
}

export function DriftCanvas() {
  const supabase = createClient();

  const [pairings, setPairings] = useState<Pairing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [initialPicIndex, setInitialPicIndex] = useState<number | undefined>(undefined);
  const [activePicIndex, setActivePicIndex] = useState(0);
  const activePairing = pairings[currentIndex] ?? null;

  const searchParams = useSearchParams();
  const sharedId = searchParams?.get("id");
  const sharedPic = searchParams?.get("pic");

  const [isEntry, setIsEntry] = useState(true);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [discArt, setDiscArt] = useState<string | null>(null);

  const mainRef = useRef<HTMLDivElement>(null);
  const lastTap = useRef<number>(0);

  const [showHints, setShowHints] = useState(true);
  const hintTimer = useRef<NodeJS.Timeout>();
  const lastPairingId = useRef<string | null>(null);
  const tapTimer = useRef<NodeJS.Timeout | null>(null);
  const currentPairingRef = useRef(activePairing);

  useEffect(() => { currentPairingRef.current = activePairing; }, [activePairing]);

  const hideHintsOnMove = useCallback(() => {
    setShowHints(false);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setShowHints(true), 3000);
  }, []);

  useEffect(() => {
    // Session persistence: Don't show greeting if already unlocked in this session
    if (typeof window !== 'undefined') {
      const unlocked = sessionStorage.getItem("drift_unlocked") === "true";
      if (unlocked) {
        setIsAudioUnlocked(true);
        audioEngine?.resume();
      }
    }
    
    hideHintsOnMove(); // initial trigger
    const el = document.body;
    el.addEventListener("pointerdown", hideHintsOnMove, { passive: true });
    el.addEventListener("pointermove", hideHintsOnMove, { passive: true });
    el.addEventListener("wheel", hideHintsOnMove, { passive: true });
    
    return () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
      el.removeEventListener("pointerdown", hideHintsOnMove);
      el.removeEventListener("pointermove", hideHintsOnMove);
      el.removeEventListener("wheel", hideHintsOnMove);
    };
  }, [hideHintsOnMove]);

  // Ref-based proxy to handle circular dependencies between useDrift and handleSwipe
  const swipeHandlerRef = useRef<(dir: 'up' | 'down' | 'left' | 'right') => void>(() => {});
  
  const { px, py, snapTo } = useDrift(
    (dir) => swipeHandlerRef.current(dir), 
    () => setIsDrawerOpen(true)
  );

  // Sync refs for the swipe handler to use safely
  const pxRef = useRef(px);
  const pyRef = useRef(py);
  useEffect(() => {
    pxRef.current = px;
    pyRef.current = py;
  }, [px, py]);

  const handleSwipe = useCallback((direction: 'up' | 'down' | 'left' | 'right') => {
    if (pairings.length === 0) return;
    
    // Nudge the virtual position significantly to ensure we enter a new quadrant
    const nudge = 0.35;
    let nextX = pxRef.current;
    let nextY = pyRef.current;

    if (direction === 'right') nextX += nudge;
    if (direction === 'left') nextX -= nudge;
    if (direction === 'up') nextY += nudge;
    if (direction === 'down') nextY -= nudge;

    snapTo(nextX, nextY);
  }, [pairings.length, snapTo]);

  // Connect the actual handler to the hook
  swipeHandlerRef.current = handleSwipe;

  // --- THE SPATIAL RESOLVER ---
  // Calculates the 'nearest' pairing on the 2D grid
  useEffect(() => {
    if (pairings.length === 0) return;

    const timer = setTimeout(() => {
      // Helper for looping distance (Toroidal distance)
      const getToroidalDist = (v1: number, v2: number) => {
        const d = Math.abs(v1 - v2);
        return Math.min(d, 1 - d);
      };

      let nearest = activePairing;
      let minDist = Infinity;
      
      // Calculate Toroidal Euclidean distance to every pairing
      pairings.forEach((p) => {
        const dx = getToroidalDist(p.tempo, px);
        const dy = getToroidalDist(p.energy, py);
        const d = Math.sqrt(dx * dx + dy * dy);
        
        if (d < minDist) {
          minDist = d;
          nearest = p;
        }
      });

      // Update state and Auto-Snap to the perfect center
      if (nearest) {
        if (nearest.id !== activePairing?.id) {
          const newIndex = pairings.findIndex(p => p.id === nearest?.id);
          setCurrentIndex(newIndex);
        }
        // Always snap to the nearest pairing's exact coordinates to ensure auto-lock/rubber-banding
        if (px !== nearest.tempo || py !== nearest.energy) {
          snapTo(nearest.tempo, nearest.energy);
        }
      }
    }, 100); 

    return () => clearTimeout(timer);
  }, [px, py, pairings, activePairing, snapTo]);

  // Initial snap to landing pairing only
  useEffect(() => {
    if (activePairing && !isAudioUnlocked) {
        snapTo(activePairing.tempo, activePairing.energy);
    }
  }, [activePairing, isAudioUnlocked, snapTo]);

  // Fetch pairings, then resolve initial position
  useEffect(() => {
    async function fetchPairings() {
      try {
        const { data, error } = await supabase
          .from("pairings")
          .select("*")
          .eq("status", "live")
          .limit(50);

        if (error) throw error;
        const rows = data || [];
        setPairings(rows);

        // Optimization: Resolve only current + immediate neighbors on load
        // This prevents the 50-request flood that leads to 500 errors
        const toWarm = [0, 1, rows.length - 1]; // Current, Next, Prev
        toWarm.forEach(idx => {
          if (rows[idx]) resolveTrack(rows[idx]).catch(() => {});
        });

        // --- Shared Deep-Link Context ---
        let initialIndex = 0;
        const saved = localStorage.getItem("drift_position");

        const sharedIdx = sharedId ? rows.findIndex(p => p.id === sharedId) : -1;
        if (sharedIdx !== -1) {
          initialIndex = sharedIdx;
          if (sharedPic) setInitialPicIndex(parseInt(sharedPic));
        } else if (saved) {
          const { px, py } = JSON.parse(saved);
          // Find nearest pairing to saved coords
          let minDist = Infinity;
          rows.forEach((p, idx) => {
            const dist = Math.sqrt(Math.pow(p.tempo - px, 2) + Math.pow(p.energy - py, 2));
            if (dist < minDist) {
              minDist = dist;
              initialIndex = idx;
            }
          });
        } else {
          // Fallback to featured pairing
          const featuredIdx = rows.findIndex(p => p.featured);
          if (featuredIdx !== -1) initialIndex = featuredIdx;
        }

        setCurrentIndex(initialIndex);
      } catch (err: any) {
        console.error("Failed to load pairings:", err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchPairings();
  }, [supabase, sharedId, sharedPic]);

  // TRIPLE-BUFFER PRE-LOADING: Proactively warm neighbors with throttling
  useEffect(() => {
    if (pairings.length === 0 || !isAudioUnlocked) return;
    
    // Wait for the user to 'settle' on a pairing before flooding the API
    const timer = setTimeout(() => {
      const neighborIndices = [
          (currentIndex + 1) % pairings.length,
          (currentIndex - 1 + pairings.length) % pairings.length
      ];

      neighborIndices.forEach(idx => {
          const p = pairings[idx];
          if (!p) return;

          resolveTrack(p).then(({ previewUrl, albumArt }) => {
             if (albumArt) {
                const img = new (window as any).Image();
                img.src = albumArt;
             }
             if (previewUrl && audioEngine) {
                audioEngine.prime(p.id, previewUrl);
             }
          }).catch(() => {});
      });
    }, 400); // 400ms debounce

    return () => clearTimeout(timer);
  }, [currentIndex, pairings, isAudioUnlocked]);

  // Save position on change
  useEffect(() => {
    if (activePairing) {
      localStorage.setItem("drift_position", JSON.stringify({
        px: activePairing.tempo,
        py: activePairing.energy
      }));
    }
  }, [activePairing]);

  useEffect(() => {
    const timer = setTimeout(() => setIsEntry(false), 2200);
    return () => clearTimeout(timer);
  }, []);

  // IMMEDIATELY stop audio on index change — prevents ghosting
  useEffect(() => {
    audioEngine?.stop();
    setIsPlaying(false);
    setDiscArt(null);
  }, [currentIndex]);

  // Resolve and play — URL + album art come from the same cached call
  useEffect(() => {
    if (!audioEngine || !activePairing) return;
    let cancelled = false;

    resolveTrack(activePairing).then(({ previewUrl, albumArt }) => {
      if (!cancelled && audioEngine && isAudioUnlocked) {
        audioEngine.onLoadError = null;
        audioEngine.play(activePairing.id, previewUrl);
        setIsPlaying(true);
        setDiscArt(albumArt);
      }
    });

    // --- STABLE LOOKBOOK LOGIC ---
    // Only reset the picture index if we have truly transitioned to a NEW pairing.
    // This prevents the "reset to 0" bug when opening drawers or clicking buttons.
    if (activePairing.id !== lastPairingId.current) {
      if (initialPicIndex === undefined) {
        setActivePicIndex(0);
      } else {
        setActivePicIndex(initialPicIndex);
        setInitialPicIndex(undefined); 
      }
      lastPairingId.current = activePairing.id;
    }

    return () => { cancelled = true; };
  }, [activePairing, isAudioUnlocked, initialPicIndex]);

  // Stop audio when leaving the page
  useEffect(() => {
    return () => {
      audioEngine?.stop();
      setIsPlaying(false);
    };
  }, []);

  // Double-tap using ref — reliable across all mobile browsers
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;

    const handleTouch = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('a') || target.closest('button')) return;

      const now = Date.now();
      
      // If it's a second tap...
      if (now - lastTap.current < 300) {
        if (e.cancelable) e.preventDefault();
        
        // Cancel the pending single-tap action (image flip)
        if (tapTimer.current) {
          clearTimeout(tapTimer.current);
          tapTimer.current = null;
        }
        
        setIsDrawerOpen(true);
        lastTap.current = 0; // reset
      } else {
        lastTap.current = now;

        // Schedule a single-tap action (image flip)
        tapTimer.current = setTimeout(() => {
          const p = currentPairingRef.current;
          if (p) {
            const raw = [p.image_url, ...(p.additional_images || [])];
            const imgs = raw.filter(url => url && url.trim() !== "");
            if (imgs.length > 1) {
              setActivePicIndex(v => (v + 1) % imgs.length);
            }
          }
          tapTimer.current = null;
        }, 220); // 220ms is fast enough to feel responsive but long enough to catch a double-tap
      }
    };

    el.addEventListener('touchstart', handleTouch, { passive: false });
    return () => el.removeEventListener('touchstart', handleTouch);
  }, [loading]);

  if (loading) {
    return (
      <div className="w-full h-screen bg-black flex flex-col items-center justify-center gap-4 text-white">
        <Loader2 className="animate-spin text-muted" size={24} />
        <span className="font-dm-sans text-[10px] uppercase tracking-[.4em] text-muted">loading drift</span>
      </div>
    );
  }

  if (error || pairings.length === 0) {
    return (
      <div className="fixed inset-0 bg-black flex flex-col items-center justify-center z-50 p-6 overflow-hidden flex-center-void">
        {/* Grain Overlay */}
        <div className="absolute inset-0 pointer-events-none opacity-[0.05] grayscale bg-[url('data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E')] z-10" />
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center gap-12 text-center"
        >
          <div className="flex flex-col items-center gap-4">
            <h1 className="font-dm-sans text-[10px] uppercase tracking-[1em] text-white/30 ml-[1em]">
              WORLD ARCHIVE
            </h1>
            <div className="w-1 h-1 rounded-full bg-white/20" />
          </div>

          <div className="flex flex-col items-center gap-6">
            <h2 className="text-white font-dm-sans text-xl md:text-2xl uppercase tracking-[.4em] font-light leading-relaxed">
              {error ? "SYSTEM" : "THE GRID IS"} <span className="opacity-40 italic">{error ? "ERROR" : "EMPTY"}</span>
            </h2>
            <p className="max-w-xs text-[9px] uppercase tracking-[.3em] leading-loose text-white/30 font-dm-sans">
              {error ? error : "INITIATE THE FIRST SPATIAL RECORDING TO BEGIN THE DRIFT"}
            </p>
          </div>

          {!error && (
            <Link href="/submit" className="be-the-first-btn">
              <motion.div
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="px-10 py-5 bg-white text-black text-[10px] font-dm-sans uppercase tracking-[.5em] font-bold shadow-[0_0_30px_rgba(255,255,255,0.2)]"
              >
                BE THE FIRST
              </motion.div>
            </Link>
          )}
        </motion.div>

        {/* Ambient Glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-white/5 rounded-full blur-[120px] pointer-events-none" />
      </div>
    );
  }

  return (
    <>
      <AnimatePresence>
        {!isAudioUnlocked && (
          <RitualGate 
             onEnter={() => {
                setIsAudioUnlocked(true);
                sessionStorage.setItem("drift_unlocked", "true");
                audioEngine?.resume();
             }} 
          />
        )}
      </AnimatePresence>

      <motion.main
        ref={mainRef}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1, ease: "easeOut" }}
        className="relative w-full h-[100dvh] bg-black cursor-crosshair overflow-hidden touch-none"
      >
        {activePairing && (
          <>
            <OutfitPanel
              pairing={activePairing}
              isPlaying={isPlaying}
              discArt={discArt}
              currentIndex={currentIndex}
              activePicIndex={activePicIndex}
              onImageChange={setActivePicIndex}
            />
            <Minimap px={px} py={py} pairings={pairings} />
            <SongDrawer
              isOpen={isDrawerOpen}
              onClose={() => setIsDrawerOpen(false)}
              pairing={activePairing}
              discArt={discArt}
              isPlaying={isPlaying}
              currentIndex={currentIndex}
              activePicIndex={activePicIndex}
            />
          </>
        )}
        
        {/* Navigation Overlays */}
        <AnimatePresence>
          {!isEntry && showHints && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.8 }}
              className="absolute inset-0 pointer-events-none select-none opacity-[.08] font-dm-sans uppercase tracking-widest z-30"
            >
              {/* Axis Hints */}
              <span className="absolute top-16 left-1/2 -translate-x-1/2 text-[7px]">Loud (Energy)</span>
              <span className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[7px]">Quiet (Energy)</span>
              <span className="absolute left-4 top-1/2 -translate-y-1/2 -rotate-90 text-[7px]">Soft (Tempo)</span>
              <span className="absolute right-4 top-1/2 -translate-y-1/2 rotate-90 text-[7px]">Hard (Tempo)</span>

              {/* Exploration Hint — Centered Sync */}
              <span className="absolute bottom-12 left-1/2 -translate-x-1/2 text-[10px] tracking-[.25em] text-white/40">
                drag to explore
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Shadow Image Pre-loader Cluster (Zero-Latency Rendering) */}
        <div className="pointer-events-none opacity-0 select-none -z-[200]">
          {Array.from(new Set([
            (currentIndex + 1) % pairings.length,
            (currentIndex - 1 + pairings.length) % pairings.length
          ])).map(idx => {
            const p = pairings[idx];
            return p ? <ShadowImage key={`shadow-${p.id}`} src={p.image_url} /> : null;
          })}
        </div>
      </motion.main>
    </>
  );
}

