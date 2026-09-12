import { promises as fs } from "node:fs";
import { configFile, defaultDownloadDir } from "./paths";
import { serializeWrites, writeJsonAtomic } from "../util/atomic";

export interface Config {
  downloadDir: string;
  trackers: string[];
  // TMDB API key (free, themoviedb.org) — resolves scene release names to
  // canonical movie titles in the New Releases feed. Optional; without it the
  // feed falls back to cleaned scene names.
  tmdbKey: string;
}

export const defaultConfig: Config = {
  downloadDir: defaultDownloadDir,
  trackers: [],
  tmdbKey: "",
};

export async function loadConfig(): Promise<Config> {
  let raw: string;
  try {
    raw = await fs.readFile(configFile, "utf8");
  } catch {
    return { ...defaultConfig, tmdbKey: process.env.TORLINK_TMDB_KEY ?? "" };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Config>;
    const cfg: Config = {
      downloadDir:
        typeof parsed.downloadDir === "string" && parsed.downloadDir
          ? parsed.downloadDir
          : defaultDownloadDir,
      trackers: Array.isArray(parsed.trackers)
        ? parsed.trackers.filter((t): t is string => typeof t === "string" && t.length > 0)
        : [],
      tmdbKey:
        process.env.TORLINK_TMDB_KEY ??
        (typeof parsed.tmdbKey === "string" ? parsed.tmdbKey : ""),
    };
    return cfg;
  } catch {
    return { ...defaultConfig, tmdbKey: process.env.TORLINK_TMDB_KEY ?? "" };
  }
}

const write = serializeWrites();

export function saveConfig(config: Config): Promise<void> {
  return write(() => writeJsonAtomic(configFile, config));
}
