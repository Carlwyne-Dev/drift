import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const audioUrl = searchParams.get("url");

  if (!audioUrl) {
    return NextResponse.json({ error: "Missing audio URL" }, { status: 400 });
  }

  // Get the incoming Range header from the user's browser (important for streaming)
  const rangeHeader = request.headers.get("range");

  try {
    // Naked fetch: Stripping all custom headers to avoid fingerprinting
    const response = await fetch(audioUrl, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
       console.error(`[AudioProxy] remote status: ${response.status} for ${audioUrl.slice(0, 60)}...`);
       return NextResponse.json({ error: "CDN Blocked Access" }, { status: response.status });
    }

    const data = await response.arrayBuffer();
    const contentType = response.headers.get("Content-Type") || "audio/mpeg";
    
    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
        "Content-Length": data.byteLength.toString(),
      },
    });

  } catch (error: any) {
    console.error("[AudioProxy] Proxy failure:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
