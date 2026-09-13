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
import "./App.css";

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
      <main className="landing">
        <nav className="brand">
          <span className="brand-mark">▶</span> Visual<span>Arena</span>
        </nav>
        <section className="hero">
          <p className="eyebrow">SYNCHRONIZED YOUTUBE WATCH PARTIES</p>
          <h1>
            Same video.
            <br />
            <em>Same moment.</em>
          </h1>
          <p className="subtitle">
            Create a room, share its code, and watch together - with roles that
            keep the queue under control.
          </p>
          <form className="create-card" onSubmit={createRoom}>
            <label>
              Your display name
              <input
                value={name}
                maxLength={30}
                placeholder="e.g. Alex"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Party name
              <input
                value={title}
                maxLength={80}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <button className="primary" disabled={isCreating}>
              {isCreating ? "Creating…" : "Create watch party →"}
            </button>
          </form>
          <div className="join-card">
            <span>Already have an invite?</span>
            <input
              value={roomId}
              maxLength={6}
              placeholder="ROOM CODE"
              onChange={(e) => setRoomId(e.target.value.toUpperCase())}
            />
            <button
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
          {error && <p className="notice error">{error}</p>}
        </section>
      </main>
    );

  return (
    <main className="party">
      <header className="party-header">
        <a className="brand" href="/">
          {" "}
          <span className="brand-mark">▶</span> Visual<span>Arena</span>
        </a>
        <div className="room-badge">
          <span>ROOM</span>
          <strong>{room.roomId}</strong>
          <button onClick={() => navigator.clipboard.writeText(location.href)}>
            Copy link
          </button>
        </div>
        <button
          className="leave"
          onClick={() => {
            socket?.emit("leave_room");
            socket?.disconnect();
            setRoom(undefined);
            history.pushState({}, "", "/");
          }}
        >
          Leave
        </button>
      </header>
      {error && (
        <p className="notice error">
          {error}
          <button onClick={() => setError("")}>×</button>
        </p>
      )}
      <div className="party-grid">
        <section className="watch-area">
          <div className="room-title">
            <div>
              <p className="eyebrow">NOW WATCHING</p>
              <h2>{room.title}</h2>
            </div>
            <span className={`role-pill ${me?.role}`}>
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
          <form className="video-form" onSubmit={changeVideo}>
            <input
              disabled={!canControl}
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder={
                canControl
                  ? "Paste a YouTube link to change the video"
                  : "Only hosts and moderators can change the video"
              }
            />
            <button className="primary" disabled={!canControl}>
              Change video
            </button>
          </form>
        </section>
        <aside className="sidebar">
          <section className="side-card">
            <div className="side-title">
              <h3>In the room</h3>
              <span>{room.participants.length}</span>
            </div>
            <div className="members">
              {room.participants.map((member) => (
                <div className="member" key={member.socketId}>
                  <div className="avatar">
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
