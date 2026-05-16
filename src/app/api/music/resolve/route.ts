import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getSpotifyAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) {
    return cachedToken;
  }

  const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("Spotify Auth Error:", err);
    return null;
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = now + 3500 * 1000;
  return cachedToken;
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 3, backoff = 1000) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, options);
    if (res.status === 429) {
      // Exponential backoff with jitter
      const nextBackoff = backoff * Math.pow(2, i);
      const wait = nextBackoff + (Math.random() * (nextBackoff * 0.5));
      console.warn(`[MusicResolve] 429 Too Many Requests. Retrying in ${Math.round(wait)}ms... (Attempt ${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    return res;
  }
  return fetch(url, options); // Final attempt
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");

  // Support for both standard and internationalized Spotify URLs (e.g. /intl-pt/track/)
  if (!url || (!url.includes("spotify.com/track/") && !url.includes("/track/"))) {
    return NextResponse.json({ error: "Invalid Spotify track URL" }, { status: 400 });
  }

  // --- HARD CREDENTIAL CHECK ---
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.error("[MusicResolve] Credentials MISSING from .env.local");
      return NextResponse.json({ 
          error: "API/DB Credentials Missing", 
          details: "Check .env.local for SPOTIFY and SUPABASE keys" 
      }, { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  console.log(`[MusicResolve] Starting discovery for: ${url.substring(0, 50)}...`);

  let name = "Unknown Track";
  let artist = "Unknown Artist";
  let image: string | null = null;
  let previewUrl: string | null = null;
  let isrc: string | null = null;
  let trackId = "";

  try {
    const match = url.match(/\/track\/([a-zA-Z0-9]+)/);
    trackId = match ? match[1] : "";
    if (!trackId) throw new Error("Could not parse Track ID");
  } catch (e) {
    console.error("[MusicResolve] Malformed Spotify URL:", url);
    return NextResponse.json({ error: "Malformed Spotify URL" }, { status: 400 });
  }

  // --- PHASE 0: Storage-Tier Check (Healing Logic) ---
  try {
    const { data: pairing } = await supabase
        .from("pairings")
        .select("song_title, artist, preview_url")
        .eq("spotify_url", url)
        .maybeSingle();

    if (pairing && pairing.song_title !== "Unknown Track") {
        console.log(`[MusicResolve] Soft Cache Hit (DB): ${pairing.song_title}`);
        name = pairing.song_title;
        artist = pairing.artist || artist;
        
        // Trust cached preview_url if it's NOT Deezer (Deezer URLs expire)
        if (pairing.preview_url && !pairing.preview_url.includes("dzcdn.net")) {
            previewUrl = pairing.preview_url;
        }
    }
  } catch (e) {
    console.warn("[MusicResolve] DB Cache Error:", e);
  }

  // --- 1. Spotify Authentication ---
  const token = await getSpotifyAccessToken();
  
  if (token) {
    // --- 2. Fetch Spotify Metadata (Resilient with Retry) ---
    try {
      console.log(`[MusicResolve] Fetching Spotify Metadata [${trackId}]...`);
      const spotifyRes = await fetchWithRetry(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store", 
      });
      
      if (spotifyRes.ok) {
        const track = await spotifyRes.json();
        if (track) {
            name = track.name || name;
            artist = track.artists[0]?.name || artist;
            image = track.album?.images[0]?.url || image;
            isrc = track.external_ids?.isrc;
            previewUrl = track.preview_url || previewUrl;
            console.log(`[MusicResolve] Found: ${name} by ${artist}`);
        }
      } else {
          const errTxt = await spotifyRes.text();
          console.warn(`[MusicResolve] Spotify Metadata failed: ${spotifyRes.status} | Body: ${errTxt}`);
      }
    } catch (e) {
      console.warn("[MusicResolve] Spotify Metadata network error:", e);
    }
  } else {
    console.warn("[MusicResolve] Spotify Auth Failed, skipping Spotify metadata.");
  }

  // --- 3. Deezer Fallback (ISRC or SEARCH) ---
  // If we don't have a preview or image, try Deezer
  if (!previewUrl || !image) {
    try {
      if (isrc) {
        console.log(`[MusicResolve] Spotify data incomplete. Falling back to Deezer ISRC [${isrc}]...`);
        const deezerRes = await fetch(`https://api.deezer.com/2.0/track/isrc:${isrc}`);
        const deezerTrack = await deezerRes.json();
        if (deezerTrack && !deezerTrack.error) {
          previewUrl = deezerTrack.preview || previewUrl;
          image = deezerTrack.album?.cover_medium || image;
          if (name === "Unknown Track") name = deezerTrack.title;
          if (artist === "Unknown Artist") artist = deezerTrack.artist?.name;
        }
      } else if (name !== "Unknown Track") {
        // Search Deezer by name and artist (Powerful fallback for Spotify 403)
        console.log(`[MusicResolve] No ISRC. Searching Deezer for: ${artist} - ${name}`);
        const searchRes = await fetch(`https://api.deezer.com/2.0/search?q=${encodeURIComponent(`${artist} ${name}`)}&limit=1`);
        const searchData = await searchRes.json();
        if (searchData.data && searchData.data.length > 0) {
          const topResult = searchData.data[0];
          previewUrl = topResult.preview || previewUrl;
          image = topResult.album?.cover_medium || image;
          console.log(`[MusicResolve] Deezer Search Hit: ${topResult.title}`);
        }
      }
    } catch (e) {
      console.warn("[MusicResolve] Deezer fallback failure:", e);
    }
  }

  // --- 4. Audio Features (Resilient with Retry) ---
  let energy: number | null = null;
  let tempo: number | null = null;
  try {
    const featuresRes = await fetchWithRetry(`https://api.spotify.com/v1/audio-features/${trackId}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (featuresRes.ok) {
      const features = await featuresRes.json();
      if (features) {
        energy = features.energy;
        tempo = Math.max(0, Math.min(1, (features.tempo - 60) / 120));
      }
    }
  } catch (e) {
    console.warn("[MusicResolve] Audio features error:", e);
  }

  // Final Safety Fallback: Deterministic DNA
  if (energy === null || tempo === null) {
    let hash = 0;
    for (let i = 0; i < trackId.length; i++) {
        hash = trackId.charCodeAt(i) + ((hash << 5) - hash);
    }
    const pseudoE = Math.abs(hash % 100) / 100;
    const pseudoT = Math.abs((hash >> 4) % 100) / 100;
    energy = parseFloat((0.2 + (pseudoE * 0.7)).toFixed(2));
    tempo = parseFloat((0.2 + (pseudoT * 0.7)).toFixed(2));
  }

  // --- 5. PERSISTENCE: Save to DB (Healing Phase) ---
  if (name !== "Unknown Track") {
    try {
        console.log(`[MusicResolve] Persisting metadata for ${name} to DB...`);
        const { error: dbErr } = await supabase
            .from("pairings")
            .update({
                song_title: name,
                artist: artist,
                // STOPPED: image_url: image ? image : undefined, <-- PROTECT OUTFIT PIC
                preview_url: previewUrl ? previewUrl : undefined
            })
            .eq("spotify_url", url);
        
        if (dbErr) console.warn("[MusicResolve] DB Persistence Failed:", dbErr.message);
        else console.log(`[MusicResolve] Metadata Saved to DB: ${name}`);
    } catch (e) {
        console.warn("[MusicResolve] DB Update unexpected error:", e);
    }
  }

  console.log(`[MusicResolve] Complete: ${name} [Preview: ${previewUrl ? 'Yes' : 'No'}]`);

  return NextResponse.json({
    song_title: name,
    artist: artist,
    image_url: image,
    preview_url: previewUrl,
    spotify_url: url,
    energy,
    tempo
  });
}
