import { useEffect, useRef, useState } from "react";
import type { PlaybackState } from "../types";

interface Props {
  playback: PlaybackState;
  canControl: boolean;
  onAction: (action: "play" | "pause" | "seek", time?: number) => void;
}
type YouTubePlayer = {
  destroy: () => void;
  getDuration: () => number;
  getCurrentTime: () => number;
  seekTo: (time: number, allowSeekAhead: boolean) => void;
  loadVideoById: (id: string, startSeconds?: number) => void;
  playVideo: () => void;
  pauseVideo: () => void;
};
type PlayerEvent = { target: YouTubePlayer };
declare global {
  interface Window {
    YT?: {
      Player: new (element: HTMLElement, options: unknown) => YouTubePlayer;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let iframeApi: Promise<void> | undefined;
const loadIframeApi = () => {
  if (window.YT?.Player) return Promise.resolve();
  if (!iframeApi)
    iframeApi = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = () => resolve();
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      document.head.appendChild(script);
    });
  return iframeApi;
};
const displayTime = (value: number) =>
  `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;

export default function YoutubePlayer({
  playback,
  canControl,
  onAction,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const lastVideoId = useRef("");
  const [initialVideoId] = useState(() => playback.videoId);
  const [ready, setReady] = useState(false);
  const [currentTime, setCurrentTime] = useState(playback.currentTime);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    let alive = true;
    loadIframeApi().then(() => {
      if (!alive || !hostRef.current) return;
      playerRef.current = new window.YT!.Player(hostRef.current, {
        videoId: initialVideoId,
        playerVars: { controls: 0, rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onReady: (event: PlayerEvent) => {
            lastVideoId.current = initialVideoId;
            setDuration(event.target.getDuration());
            setReady(true);
          },
        },
      });
    });
    return () => {
      alive = false;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [initialVideoId]);

  useEffect(() => {
    if (!ready || !playerRef.current) return;
    const player = playerRef.current;
    const target =
      playback.currentTime +
      (playback.playState === "playing"
        ? Math.max(0, (Date.now() - playback.updatedAt) / 1000)
        : 0);
    if (lastVideoId.current !== playback.videoId) {
      lastVideoId.current = playback.videoId;
      player.loadVideoById(playback.videoId, target);
      if (playback.playState === "paused") player.pauseVideo();
    } else {
      player.seekTo(target, true);
      if (playback.playState === "playing") player.playVideo();
      else player.pauseVideo();
    }
    setCurrentTime(target);
    setDuration(player.getDuration());
  }, [playback, ready]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (playerRef.current) {
        setCurrentTime(playerRef.current.getCurrentTime());
        setDuration(playerRef.current.getDuration());
      }
    }, 500);
    return () => window.clearInterval(interval);
  }, []);

  const seek = (time: number) => canControl && onAction("seek", time);
  return (
    <section className="player-card">
      <div className="video-frame" ref={hostRef} />
      <div className="player-controls" style={{ position: "relative" }}>
        {!canControl && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 10,
              cursor: "not-allowed",
            }}
            aria-hidden="true"
          />
        )}
        <input
          aria-label="Video progress"
          type="range"
          min="0"
          max={Math.max(duration, 1)}
          step="0.1"
          value={Math.min(currentTime, duration || currentTime)}
          disabled={!canControl}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <div className="control-row">
          <button
            className="icon-button"
            disabled={!canControl}
            onClick={() => seek(Math.max(0, currentTime - 10))}
          >
            ↶ 10
          </button>
          <button
            className="play-button"
            disabled={!canControl}
            onClick={() =>
              onAction(playback.playState === "playing" ? "pause" : "play")
            }
          >
            {playback.playState === "playing" ? "❚❚ Pause" : "▶ Play"}
          </button>
          <button
            className="icon-button"
            disabled={!canControl}
            onClick={() => seek(currentTime + 10)}
          >
            10 ↷
          </button>
          <span className="time-readout">
            {displayTime(currentTime)} / {displayTime(duration)}
          </span>
          {!canControl && (
            <span className="locked">🔒 Host controls playback</span>
          )}
        </div>
      </div>
    </section>
  );
}
