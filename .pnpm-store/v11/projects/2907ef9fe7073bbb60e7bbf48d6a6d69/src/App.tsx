import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { io, Socket } from "socket.io-client";
import YoutubePlayer from "./components/YoutubePlayer";
import type {
  ChatMessage,
  Participant,
  PlaybackState,
  RoomState,
} from "./types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
const defaultPlayback: PlaybackState = {
  videoId: "M7lc1UVf-VE",
  currentTime: 0,
  playState: "paused",
  updatedAt: Date.now(),
};
const getUserId = () => {
  const key = "visualarena:user-id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
};
const videoIdFrom = (value: string) => {
  const match = value.match(
    /(?:youtu\.be\/|v=|embed\/)?([\w-]{11})(?:[?&/]|$)/,
  );
  return match?.[1] ?? value.match(/^[\w-]{11}$/)?.[0] ?? null;
};

type Ack = { ok: boolean; error?: string };
const emit = (socket: Socket, event: string, payload?: unknown) =>
  new Promise<Ack>((resolve) => socket.emit(event, payload, resolve));
const inputClass =
  "min-w-0 rounded-lg border border-[#4c4568] bg-[#171328] px-3 py-3 text-white outline-none transition focus:border-[#9b79ff] focus:ring-2 focus:ring-[#7d50e6]/25";
const primaryClass =
  "rounded-lg bg-[#9169f7] px-4 py-3 font-bold text-white transition hover:bg-[#a884ff] disabled:cursor-not-allowed disabled:opacity-45";
const roleClass = {
  host: "bg-[#5b3d9f] text-[#e6ddff]",
  moderator: "bg-[#264d6d] text-[#c8ebff]",
  participant: "bg-[#333049] text-[#d4c9ff]",
} as const;

export default function App() {
  const initialRoom = location.pathname
    .match(/^\/room\/([A-Za-z0-9]+)$/)?.[1]
    ?.toUpperCase();
  const [roomId, setRoomId] = useState(initialRoom ?? "");
  const [name, setName] = useState(
    () => localStorage.getItem("visualarena:name") ?? "",
  );
  const [title, setTitle] = useState("Friday night queue");
  const [room, setRoom] = useState<RoomState>();
  const [socket, setSocket] = useState<Socket>();
  const [error, setError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [videoUrl, setVideoUrl] = useState("");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [userId] = useState(() => getUserId());

  const join = async (code: string, creatorToken?: string) => {
    if (!name.trim()) {
      setError("Choose a display name before joining.");
      return;
    }
    localStorage.setItem("visualarena:name", name.trim());
    const connected = io(API_URL, { transports: ["websocket"] });
    connected.on("room_state", setRoom);
    connected.on("sync_state", (playback: PlaybackState) =>
      setRoom((current) => current && { ...current, playback }),
    );
    connected.on("participants_updated", (participants: Participant[]) =>
      setRoom((current) => current && { ...current, participants }),
    );
    connected.on(
      "role_assigned",
      ({ participants }: { participants: Participant[] }) =>
        setRoom((current) => current && { ...current, participants }),
    );
    connected.on(
      "host_credentials",
      ({
        roomId: hostedRoom,
        creatorToken,
      }: {
        roomId: string;
        creatorToken: string;
      }) =>
        sessionStorage.setItem(`visualarena:host:${hostedRoom}`, creatorToken),
    );
    connected.on("chat_message", (chat: ChatMessage) =>
      setMessages((current) => [...current.slice(-99), chat]),
    );
    connected.on(
      "removed_from_room",
      ({ message: text }: { message: string }) => {
        setError(text);
        setRoom(undefined);
        connected.disconnect();
        history.pushState({}, "", "/");
      },
    );
    connected.on("connect", async () => {
      const reply = await emit(connected, "join_room", {
        roomId: code,
        username: name.trim(),
        userId,
        creatorToken,
      });
      if (!reply.ok) {
        setError(reply.error ?? "Could not join this room.");
        connected.disconnect();
        return;
      }
      setRoomId(code);
      setError("");
      history.pushState({}, "", `/room/${code}`);
    });
    connected.on("connect_error", () =>
      setError("Could not reach the party server. Is the API running?"),
    );
    setSocket(connected);
  };

  const createRoom = async (event: FormEvent) => {
    event.preventDefault();
    setIsCreating(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const result = (await response.json()) as {
        roomId?: string;
        creatorToken?: string;
        error?: string;
      };
      if (!response.ok || !result.roomId || !result.creatorToken)
        throw new Error(result.error ?? "Could not create room.");
      sessionStorage.setItem(
        `visualarena:host:${result.roomId}`,
        result.creatorToken,
      );
      await join(result.roomId, result.creatorToken);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not create room.",
      );
    } finally {
      setIsCreating(false);
    }
  };

  useEffect(
    () => () => {
      socket?.disconnect();
    },
    [socket],
  );
  useEffect(() => {
    if (initialRoom && name)
      window.queueMicrotask(
        () =>
          void join(
            initialRoom,
            sessionStorage.getItem(`visualarena:host:${initialRoom}`) ??
              undefined,
          ),
      );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const me = room?.participants.find((member) => member.userId === userId);
  const canControl = me?.role === "host" || me?.role === "moderator";
  const action = async (event: string, payload?: unknown) => {
    if (!socket) return;
    const reply = await emit(socket, event, payload);
    if (!reply.ok) setError(reply.error ?? "Action was not allowed.");
  };
  const leaveRoom = async () => {
    if (me?.role === "host") {
      setError("Transfer host controls before leaving the room.");
      return;
    }
    if (!socket) return;
    const reply = await emit(socket, "leave_room");
    if (!reply.ok) {
      setError(reply.error ?? "Could not leave the room.");
      return;
    }
    socket.disconnect();
    setRoom(undefined);
    history.pushState({}, "", "/");
  };
  const changeVideo = async (event: FormEvent) => {
    event.preventDefault();
    const videoId = videoIdFrom(videoUrl);
    if (!videoId) {
      setError("Paste a valid YouTube URL or 11-character video ID.");
      return;
    }
    await action("change_video", { videoId });
    setVideoUrl("");
  };
  const sendChat = async (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim()) return;
    await action("send_message", { message });
    setMessage("");
  };

  if (!room)
    return (
      <main className="min-h-screen overflow-hidden bg-[#0d0b18] px-[clamp(22px,8vw,130px)] py-7 text-[#f7f5ff] [background:radial-gradient(circle_at_72%_34%,#5b2cb9_0,#1f1648_23%,transparent_49%),#0d0b18]">
        <nav className="inline-flex items-center gap-1 text-xl font-extrabold tracking-tight">
          <span className="grid size-7 place-items-center rounded-lg bg-[#8659ee] text-xs">
            ▶
          </span>
          Visual<span className="text-[#a98bff]">Arena</span>
        </nav>
        <section className="max-w-3xl py-[clamp(72px,15vh,160px)] pb-20">
          <p className="mb-3 text-[11px] font-extrabold tracking-[.18em] text-[#bda9ff]">
            SYNCHRONIZED YOUTUBE WATCH PARTIES
          </p>
          <h1 className="m-0 text-[clamp(52px,8vw,92px)] leading-[.98] tracking-[-.06em]">
            Same video.
            <br />
            <em className="not-italic text-[#b696ff]">Same moment.</em>
          </h1>
          <p className="my-7 max-w-xl text-lg leading-relaxed text-[#c1bed2]">
            Create a room, share its code, and watch together - with roles that
            keep the queue under control.
          </p>
          <form
            className="grid items-end gap-3.5 rounded-2xl border border-[#494169] bg-[#161329]/75 p-5 backdrop-blur md:grid-cols-[1fr_1fr_auto]"
            onSubmit={createRoom}
          >
            <label className="grid gap-2 text-xs font-bold text-[#c8c3d6]">
              Your display name
              <input
                className={inputClass}
                value={name}
                maxLength={30}
                placeholder="e.g. Alex"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="grid gap-2 text-xs font-bold text-[#c8c3d6]">
              Party name
              <input
                className={inputClass}
                value={title}
                maxLength={80}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <button className={primaryClass} disabled={isCreating}>
              {isCreating ? "Creating…" : "Create watch party →"}
            </button>
          </form>
          <div className="mt-4 grid items-center gap-3.5 rounded-2xl border border-[#494169] bg-[#161329]/75 p-5 text-[#c7c2d1] backdrop-blur md:grid-cols-[auto_155px_auto]">
            <span>Already have an invite?</span>
            <input
              className={`${inputClass} uppercase tracking-widest`}
              value={roomId}
              maxLength={6}
              placeholder="ROOM CODE"
              onChange={(e) => setRoomId(e.target.value.toUpperCase())}
            />
            <button
              className="font-bold text-[#ba9eff]"
              onClick={() =>
                void join(
                  roomId,
                  sessionStorage.getItem(`visualarena:host:${roomId}`) ??
                    undefined,
                )
              }
            >
              Join room
            </button>
          </div>
          {error && (
            <p className="mt-4 rounded-lg bg-[#4d1d35] px-3 py-2.5 text-[#ffd4e1]">
              {error}
            </p>
          )}
        </section>
      </main>
    );

  return (
    <main className="min-h-screen bg-[#0d0b18] px-[clamp(18px,4vw,68px)] pb-15 pt-5 text-[#f7f5ff]">
      <header className="flex items-center gap-3 border-b border-[#2b2640] pb-6">
        <a
          className="inline-flex items-center gap-1 text-xl font-extrabold tracking-tight"
          href="/"
        >
          <span className="grid size-7 place-items-center rounded-lg bg-[#8659ee] text-xs">
            ▶
          </span>{" "}
          Visual<span className="text-[#a98bff]">Arena</span>
        </a>
        <div className="ml-auto hidden items-center gap-2 text-[11px] text-[#ada8bd] sm:flex">
          <span>ROOM</span>
          <strong>{room.roomId}</strong>
          <button
            className="rounded-md border border-[#494263] px-2.5 py-1.5 text-[#d8d3e5]"
            onClick={() => navigator.clipboard.writeText(location.href)}
          >
            Copy link
          </button>
        </div>
        <button
          className="rounded-md border border-[#494263] px-2.5 py-1.5 text-[#ffb9d1]"
          onClick={() => void leaveRoom()}
        >
          Leave
        </button>
      </header>
      {error && (
        <p className="mt-4 rounded-lg bg-[#4d1d35] px-3 py-2.5 text-[#ffd4e1]">
          {error}
          <button onClick={() => setError("")}>×</button>
        </p>
      )}
      <div className="mx-auto mt-9 grid max-w-[1400px] gap-6 lg:grid-cols-[minmax(0,1fr)_330px]">
        <section>
          <div className="mb-4 flex items-end justify-between">
            <div>
              <p className="mb-2 text-[11px] font-extrabold tracking-[.18em] text-[#bda9ff]">
                NOW WATCHING
              </p>
              <h2 className="m-0 text-3xl font-bold tracking-tight">
                {room.title}
              </h2>
            </div>
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold capitalize ${me ? roleClass[me.role] : "bg-[#333049] text-[#d4c9ff]"}`}
            >
              {me?.role ?? "connecting"}
            </span>
          </div>
          <YoutubePlayer
            playback={room.playback ?? defaultPlayback}
            canControl={canControl}
            onAction={(kind, time) =>
              void action(kind, time === undefined ? undefined : { time })
            }
          />
          <form className="mt-3.5 flex gap-2.5" onSubmit={changeVideo}>
            <input
              className={`${inputClass} flex-1 disabled:cursor-not-allowed disabled:opacity-45`}
              disabled={!canControl}
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder={
                canControl
                  ? "Paste a YouTube link to change the video"
                  : "Only hosts and moderators can change the video"
              }
            />
            <button className={primaryClass} disabled={!canControl}>
              Change video
            </button>
          </form>
        </section>
        <aside className="grid content-start gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <section className="overflow-visible rounded-xl border border-[#38334d] bg-[#171328]">
            <div className="flex items-center justify-between border-b border-[#312c47] px-4 pb-3 pt-4">
              <h3>In the room</h3>
              <span>{room.participants.length}</span>
            </div>
            <div className="p-2">
              {room.participants.map((member) => (
                <div
                  className="relative flex items-center gap-2.5 rounded-lg p-2 hover:bg-[#211d32]"
                  key={member.socketId}
                >
                  <div className="grid size-8 place-items-center rounded-full bg-[#4d3d7f] text-sm font-bold text-[#e8e1ff]">
                    {member.username.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <strong>
                      {member.username}
                      {member.userId === userId ? " (you)" : ""}
                    </strong>
                    <span className={`member-role ${member.role}`}>
                      {member.role}
                    </span>
                  </div>
                  {me?.role === "host" && member.socketId !== me.socketId && (
                    <details>
                      <summary>•••</summary>
                      <button
                        onClick={() =>
                          void action("assign_role", {
                            socketId: member.socketId,
                            role:
                              member.role === "moderator"
                                ? "participant"
                                : "moderator",
                          })
                        }
                      >
                        {member.role === "moderator"
                          ? "Make participant"
                          : "Make moderator"}
                      </button>
                      <button
                        onClick={() =>
                          void action("transfer_host", {
                            socketId: member.socketId,
                          })
                        }
                      >
                        Transfer host
                      </button>
                      <button
                        className="danger"
                        onClick={() =>
                          void action("remove_participant", {
                            socketId: member.socketId,
                          })
                        }
                      >
                        Remove
                      </button>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </section>
          <section className="side-card chat">
            <div className="side-title">
              <h3>Party chat</h3>
              <span>LIVE</span>
            </div>
            <div className="messages">
              {messages.length === 0 ? (
                <p className="muted">Be the first to say hi.</p>
              ) : (
                messages.map((chat) => (
                  <p key={chat.id}>
                    <strong>{chat.username}</strong>
                    {chat.message}
                  </p>
                ))
              )}
            </div>
            <form onSubmit={sendChat}>
              <input
                value={message}
                maxLength={500}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Say something…"
              />
              <button aria-label="Send message">↑</button>
            </form>
          </section>
        </aside>
      </div>
    </main>
  );
}
