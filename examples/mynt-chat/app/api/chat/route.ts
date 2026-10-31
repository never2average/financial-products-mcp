import { NextResponse, type NextRequest } from "next/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { runTurn, toClaudeTools } from "@/lib/agent";
import { chatModel } from "@/lib/config";
import { encodeEvent, type ChatEvent } from "@/lib/events";
import { createLlm } from "@/lib/llm";
import { callMyntTool, connectMynt, listChatTools, NotSignedInError } from "@/lib/mynt";
import { currentSession, fromOwnOrigin } from "@/lib/session";
import { appendEvent } from "@/lib/transcript";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_MESSAGE = 4000;

// One user message in, the assistant's reply streamed out as server-sent events.
export async function POST(req: NextRequest) {
  if (!fromOwnOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const session = await currentSession();
  if (!session?.tokens) return NextResponse.json({ error: "auth_required" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { message?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message || message.length > MAX_MESSAGE) {
    return NextResponse.json({ error: `Write a message of 1 to ${MAX_MESSAGE} characters.` }, { status: 400 });
  }
  if (session.busy) return NextResponse.json({ error: "Still answering your last message." }, { status: 409 });
  session.busy = true;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: ChatEvent) => {
        try {
          controller.enqueue(encoder.encode(encodeEvent(event)));
        } catch {
          // the browser went away (a phone locked, an app switch); keep going so the history
          // and the transcript stay paired, and a reload shows the finished reply
        }
      };
      let mynt: Client | undefined;
      try {
        mynt = await connectMynt(session);
        const tools = toClaudeTools(await listChatTools(mynt));
        const client = mynt;
        // Anything the user did outside the chat since the last turn goes first, as data.
        const events = session.pendingEvents.splice(0);
        const transcriptStart = session.transcript.length;
        session.history.push({
          role: "user",
          content: events.length ? [...events.map((text) => ({ type: "text" as const, text })), { type: "text" as const, text: message }] : message,
        });
        session.transcript.push({ kind: "user", text: message });
        // No abort signal: the turn finishes server side even if the browser goes away.
        const result = await runTurn(session.history, {
          llm: createLlm(),
          model: chatModel(),
          tools,
          callTool: (name, args) => callMyntTool(client, name, args),
          emit: (event) => {
            // Mirror what the browser draws (minus errors), so a reload shows the same chat.
            if (event.type === "text" || event.type === "card" || event.type === "request") {
              session.transcript = appendEvent(session.transcript, event);
            }
            emit(event);
          },
        });
        if (result.refused) {
          // runTurn took the turn back out of the history; drop it from the transcript too, and
          // keep the app events for the next message.
          session.transcript.length = transcriptStart;
          session.pendingEvents.unshift(...events);
        }
      } catch (err) {
        if (err instanceof NotSignedInError) emit({ type: "auth_required" });
        else {
          console.error("chat turn failed:", err instanceof Error ? err.message : err);
          emit({ type: "error", message: "Something went wrong reaching Mynt. Please try again." });
        }
      } finally {
        session.busy = false;
        await mynt?.close().catch(() => undefined);
        emit({ type: "done" });
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no", // ask reverse proxies not to buffer the stream
    },
  });
}

// "New chat": forget the conversation, stay signed in.
export async function DELETE(req: NextRequest) {
  if (!fromOwnOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "auth_required" }, { status: 401 });
  if (session.busy) return NextResponse.json({ error: "Still answering your last message." }, { status: 409 });
  session.history = [];
  session.transcript = [];
  session.accepted = [];
  session.sentRequests = [];
  session.pendingEvents = [];
  return NextResponse.json({ ok: true });
}
